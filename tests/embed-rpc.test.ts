import { describe, expect, it } from 'vitest';
import { connect } from 'node:net';
import {
  createDeterministicEmbedder,
  createRpcEmbedder,
  EmbeddingError,
  startEmbedRpcServer,
} from '../packages/embedding/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';

function rawRequest(endpoint: string, line: string, timeoutMs = 5000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint);
    let buffer = '';
    socket.setTimeout(timeoutMs, () => { socket.destroy(); reject(new Error('raw request timed out')); });
    socket.on('connect', () => { socket.write(line); });
    socket.setEncoding('utf8');
    socket.on('data', (chunk: Buffer | string) => {
      buffer += String(chunk);
      const index = buffer.indexOf('\n');
      if (index < 0) return;
      socket.end();
      try {
        resolve(JSON.parse(buffer.slice(0, index)) as Record<string, unknown>);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on('error', reject);
  });
}

describe('embed RPC', () => {
  it('serves embeddings over the local endpoint and propagates server metadata', async () => {
    const fixture = await createTemporaryDirectory();
    const embedder = createDeterministicEmbedder({ dimensions: 8 });
    const server = await startEmbedRpcServer(fixture.path, embedder);
    try {
      const client = createRpcEmbedder(fixture.path);
      const direct = await embedder.embed([{ id: 'a', text: 'alpha' }, { id: 'b', text: 'beta' }]);
      const results = await client.embed([{ id: 'a', text: 'alpha' }, { id: 'b', text: 'beta' }]);
      expect(results.map((result) => result.id)).toEqual(['a', 'b']);
      expect(results[0]?.vector).toEqual(direct[0]?.vector);
      expect(results[1]?.vector).toEqual(direct[1]?.vector);
      expect(client.metadata.fingerprint).toBe(embedder.metadata.fingerprint);
      expect(client.metadata.dimensions).toBe(8);
    } finally {
      await server.close();
      await fixture.cleanup();
    }
  });

  it('throws EmbeddingError(unavailable) when the daemon is not serving', async () => {
    const fixture = await createTemporaryDirectory();
    try {
      const client = createRpcEmbedder(fixture.path, { timeoutMs: 2000 });
      const error = await client.embed([{ id: 'a', text: 'alpha' }]).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(EmbeddingError);
      expect((error as EmbeddingError).code).toBe('unavailable');
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects malformed lines and unknown methods with invalid-input', async () => {
    const fixture = await createTemporaryDirectory();
    const server = await startEmbedRpcServer(fixture.path, createDeterministicEmbedder({ dimensions: 4 }));
    try {
      const endpoint = server.endpoint;
      const malformed = await rawRequest(endpoint, 'not json\n');
      expect(malformed.ok).toBe(false);
      expect(malformed.code).toBe('invalid-input');
      const unknownMethod = await rawRequest(endpoint, `${JSON.stringify({ v: 1, id: 'x', method: 'train' })}\n`);
      expect(unknownMethod.ok).toBe(false);
      expect(unknownMethod.id).toBe('x');
      expect(unknownMethod.code).toBe('invalid-input');
      const emptyTexts = await rawRequest(endpoint, `${JSON.stringify({ v: 1, id: 'y', method: 'embed', texts: [] })}\n`);
      expect(emptyTexts.ok).toBe(false);
      expect(emptyTexts.code).toBe('invalid-input');
    } finally {
      await server.close();
      await fixture.cleanup();
    }
  });

  it('maps server-side embedding failures onto EmbeddingError codes', async () => {
    const fixture = await createTemporaryDirectory();
    const failing = createDeterministicEmbedder({ dimensions: 4 });
    const server = await startEmbedRpcServer(fixture.path, {
      metadata: failing.metadata,
      embed(): Promise<never> {
        return Promise.reject(new EmbeddingError('incompatible', 'model mismatch'));
      },
    });
    try {
      const client = createRpcEmbedder(fixture.path);
      const error = await client.embed([{ id: 'a', text: 'alpha' }]).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(EmbeddingError);
      expect((error as EmbeddingError).code).toBe('incompatible');
      expect((error as EmbeddingError).message).toBe('model mismatch');
    } finally {
      await server.close();
      await fixture.cleanup();
    }
  });
});
