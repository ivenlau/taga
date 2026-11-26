import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { join, resolve } from 'node:path';
import {
  EmbeddingError,
  embeddingFingerprint,
  type Embedder,
  type EmbedderMetadata,
  type EmbeddingInput,
  type EmbeddingResult,
} from './index.js';

/**
 * Local embed RPC: one BGE-M3 model hosted by the taga daemon, reused by
 * web / mcp / cli over a per-user local endpoint (unix socket or named pipe).
 * One JSON line per request, one JSON line per response.
 */

export const EMBED_RPC_VERSION = 1;

const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_TEXTS_PER_REQUEST = 64;
const DEFAULT_TIMEOUT_MS = 120_000;
const ERROR_CODES: readonly EmbeddingError['code'][] = ['unavailable', 'incompatible', 'invalid-input', 'unknown'];

export interface RpcEmbedderOptions {
  readonly endpoint?: string;
  readonly timeoutMs?: number;
}

export interface EmbedRpcServer {
  readonly endpoint: string;
  close(): Promise<void>;
}

export function embedRpcEndpoint(brainPath: string): string {
  const normalized = resolve(brainPath);
  if (process.platform === 'win32') {
    const digest = createHash('sha256').update(normalized.toLowerCase()).digest('hex').slice(0, 16);
    return `\\\\.\\pipe\\taga-embed-${digest}`;
  }
  return join(normalized, '.taga', 'daemon-embed.sock');
}

export function createRpcEmbedder(brainPath: string, options: RpcEmbedderOptions = {}): Embedder {
  const endpoint = options.endpoint ?? embedRpcEndpoint(brainPath);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let metadata: EmbedderMetadata | undefined;
  return {
    get metadata(): EmbedderMetadata {
      return metadata ?? placeholderMetadata();
    },
    async embed(inputs: readonly EmbeddingInput[]): Promise<readonly EmbeddingResult[]> {
      if (inputs.length === 0) return [];
      if (inputs.length > MAX_TEXTS_PER_REQUEST) {
        throw new EmbeddingError('invalid-input', `embed RPC accepts at most ${MAX_TEXTS_PER_REQUEST} texts per request`);
      }
      const response = await rpcRequest(endpoint, {
        v: EMBED_RPC_VERSION,
        id: randomRequestId(),
        method: 'embed',
        texts: inputs.map(({ text }) => text),
      }, timeoutMs);
      if (response.ok !== true) throw responseError(response);
      metadata = readMetadata(response.metadata) ?? metadata;
      const vectors = response.vectors;
      if (!Array.isArray(vectors) || vectors.length !== inputs.length) {
        throw new EmbeddingError('unknown', 'embed RPC returned an unexpected vector count');
      }
      return inputs.map((input, index) => ({
        id: input.id,
        vector: vectors[index] as readonly number[],
      }));
    },
  };
}

export async function startEmbedRpcServer(brainPath: string, embedder: Embedder): Promise<EmbedRpcServer> {
  const endpoint = embedRpcEndpoint(brainPath);
  const server = createEmbedRpcServer(embedder);
  if (process.platform !== 'win32') await rm(endpoint, { force: true });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(endpoint, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  return {
    endpoint,
    async close(): Promise<void> {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      if (process.platform !== 'win32') await rm(endpoint, { force: true }).catch(() => undefined);
    },
  };
}

export function createEmbedRpcServer(embedder: Embedder): Server {
  let queue: Promise<void> = Promise.resolve();
  return createServer((socket: Socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: Buffer | string) => {
      buffer += String(chunk);
      if (buffer.length > MAX_LINE_BYTES) {
        buffer = '';
        socket.end(`${JSON.stringify({ v: EMBED_RPC_VERSION, ok: false, code: 'invalid-input', message: 'request too large' })}\n`);
        return;
      }
      for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim().length > 0) {
          queue = queue.then(async () => {
            if (!socket.destroyed) {
              socket.write(`${JSON.stringify(await handleRpcRequest(embedder, line))}\n`);
              socket.end();
            }
          });
        }
      }
    });
    socket.on('error', () => { /* client went away; response writes are guarded above */ });
  });
}

async function handleRpcRequest(embedder: Embedder, line: string): Promise<Record<string, unknown>> {
  let request: unknown;
  try {
    request = JSON.parse(line);
  } catch {
    return failure(undefined, 'invalid-input', 'request must be one JSON object per line');
  }
  if (!isRecord(request) || typeof request.id !== 'string') {
    return failure(undefined, 'invalid-input', 'request.id must be a string');
  }
  const id = request.id;
  try {
    if (request.method === 'metadata') {
      return { v: EMBED_RPC_VERSION, id, ok: true, metadata: embedder.metadata };
    }
    if (request.method === 'embed') {
      const texts = request.texts;
      if (!Array.isArray(texts) || texts.length === 0 || texts.length > MAX_TEXTS_PER_REQUEST || texts.some((text) => typeof text !== 'string')) {
        return failure(id, 'invalid-input', `texts must be 1..${MAX_TEXTS_PER_REQUEST} strings`);
      }
      const inputs: EmbeddingInput[] = texts.map((text, index) => ({ id: `t${index}`, text: text as string }));
      const results = await embedder.embed(inputs);
      return {
        v: EMBED_RPC_VERSION,
        id,
        ok: true,
        metadata: embedder.metadata,
        vectors: results.map((result) => [...result.vector]),
      };
    }
    return failure(id, 'invalid-input', `unsupported method: ${String(request.method)}`);
  } catch (error) {
    const code = error instanceof EmbeddingError ? error.code : 'unknown';
    return failure(id, code, error instanceof Error ? error.message : String(error));
  }
}

function failure(id: string | undefined, code: EmbeddingError['code'], message: string): Record<string, unknown> {
  return { v: EMBED_RPC_VERSION, ...(id === undefined ? {} : { id }), ok: false, code, message };
}

function rpcRequest(endpoint: string, payload: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolveRequest, rejectRequest) => {
    const socket = connect(endpoint);
    let settled = false;
    let buffer = '';
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      rejectRequest(error);
    };
    socket.setTimeout(timeoutMs, () => fail(new EmbeddingError('unavailable', 'embed RPC timed out')));
    socket.on('connect', () => { socket.write(`${JSON.stringify(payload)}\n`); });
    socket.setEncoding('utf8');
    socket.on('data', (chunk: Buffer | string) => {
      buffer += String(chunk);
      const index = buffer.indexOf('\n');
      if (index < 0 || settled) return;
      settled = true;
      socket.end();
      try {
        resolveRequest(JSON.parse(buffer.slice(0, index)) as Record<string, unknown>);
      } catch {
        rejectRequest(new EmbeddingError('unknown', 'embed RPC returned invalid JSON'));
      }
    });
    socket.on('error', (error) => fail(new EmbeddingError('unavailable', `embed RPC unavailable: ${error.message}`)));
    socket.on('end', () => fail(new EmbeddingError('unavailable', 'embed RPC closed before responding')));
  });
}

function responseError(response: Record<string, unknown>): EmbeddingError {
  const rawCode = typeof response.code === 'string' ? response.code : 'unknown';
  const code = ERROR_CODES.includes(rawCode as EmbeddingError['code']) ? rawCode as EmbeddingError['code'] : 'unknown';
  return new EmbeddingError(code, typeof response.message === 'string' ? response.message : 'embed RPC request failed');
}

function readMetadata(value: unknown): EmbedderMetadata | undefined {
  return isRecord(value) ? value as unknown as EmbedderMetadata : undefined;
}

function placeholderMetadata(): EmbedderMetadata {
  const metadata = {
    provider: 'taga-daemon-rpc',
    model: 'Xenova/bge-m3',
    dimensions: 1024,
    pooling: 'mean' as const,
    normalized: true as const,
    maxTokens: 8192,
    batchSize: 4,
    implementationVersion: 'taga-embedding-v1',
  };
  return { ...metadata, fingerprint: embeddingFingerprint(metadata) };
}

function randomRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
