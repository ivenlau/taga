import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { FeatureExtractionPipeline, pipeline as transformersPipeline } from '@huggingface/transformers';

export {
  BGE_M3_DOWNLOAD_BYTES,
  BGE_M3_MODEL_ID,
  BGE_M3_MODEL_REVISION,
  defaultBgeM3ModelPath,
  downloadBgeM3Model,
  inspectBgeM3Model,
  type BgeM3DownloadProgress,
  type BgeM3ModelInspection,
  type DownloadBgeM3ModelOptions,
} from './model-download.js';

export const EMBEDDING_IMPLEMENTATION_VERSION = 'taga-embedding-v1';

export type EmbeddingErrorCode = 'unavailable' | 'incompatible' | 'invalid-input' | 'unknown';

export interface EmbeddingInput {
  readonly id: string;
  readonly text: string;
}

export interface EmbeddingResult {
  readonly id: string;
  readonly vector: readonly number[];
}

export interface EmbedderMetadata {
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;
  readonly pooling: 'mean';
  readonly normalized: true;
  readonly maxTokens: number;
  readonly batchSize: number;
  readonly fingerprint: string;
  readonly implementationVersion: string;
}

export interface Embedder {
  readonly metadata: EmbedderMetadata;
  embed(inputs: readonly EmbeddingInput[]): Promise<readonly EmbeddingResult[]>;
}

export class EmbeddingError extends Error {
  constructor(
    readonly code: EmbeddingErrorCode,
    message: string,
    readonly causeCode?: string,
  ) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

export interface DeterministicEmbedderOptions {
  readonly dimensions?: number;
  readonly model?: string;
  readonly maxTokens?: number;
  readonly batchSize?: number;
}

export interface LocalBgeM3EmbedderOptions {
  readonly modelPath: string;
  readonly modelId?: string;
  readonly batchSize?: number;
  readonly maxTokens?: number;
  readonly dimensions?: number;
  readonly loader?: BgeM3PipelineLoader;
}

export type BgeM3Pipeline = FeatureExtractionPipeline;
export type BgeM3PipelineLoader = (modelPath: string) => Promise<BgeM3Pipeline>;

// One loaded pipeline per model path per process: several embedder instances
// (semantic jobs, consolidation, dedup checks, embed RPC) share the ~2GiB model.
const sharedPipelineCache = new Map<string, Promise<BgeM3Pipeline>>();

export function createLocalBgeM3Embedder(options: LocalBgeM3EmbedderOptions): Embedder {
  const modelId = options.modelId ?? 'Xenova/bge-m3';
  const dimensions = options.dimensions ?? 1024;
  const maxTokens = options.maxTokens ?? 8192;
  const batchSize = options.batchSize ?? 4;
  validatePositiveInteger('dimensions', dimensions);
  validatePositiveInteger('maxTokens', maxTokens);
  validatePositiveInteger('batchSize', batchSize);
  const metadata = createMetadata({
    provider: 'transformers.js',
    model: modelId,
    dimensions,
    maxTokens,
    batchSize,
  });
  const loader = options.loader ?? defaultBgeM3PipelineLoader;
  const sharePipeline = options.loader === undefined;
  let pipelinePromise: Promise<BgeM3Pipeline> | undefined;
  const loadPipeline = async (): Promise<BgeM3Pipeline> => {
    if (pipelinePromise === undefined) {
      const created = (sharePipeline ? sharedPipelineCache.get(options.modelPath) : undefined) ?? loader(options.modelPath);
      if (sharePipeline) sharedPipelineCache.set(options.modelPath, created);
      pipelinePromise = created.catch((error: unknown) => {
        pipelinePromise = undefined;
        if (sharePipeline && sharedPipelineCache.get(options.modelPath) === created) sharedPipelineCache.delete(options.modelPath);
        throw classifyEmbeddingError(error);
      });
    }
    return pipelinePromise;
  };
  return {
    metadata,
    async embed(inputs): Promise<readonly EmbeddingResult[]> {
      validateInputs(inputs, metadata);
      if (inputs.length === 0) return [];
      try {
        const extractor = await loadPipeline();
        const results: EmbeddingResult[] = [];
        for (let offset = 0; offset < inputs.length; offset += batchSize) {
          const batch = inputs.slice(offset, offset + batchSize);
          const output = await extractor(batch.map(({ text }) => text), { pooling: 'mean', normalize: true });
          results.push(...readBgeM3Output(output, batch, dimensions));
        }
        return results;
      } catch (error) {
        throw classifyEmbeddingError(error);
      }
    },
  };
}

export function createDeterministicEmbedder(options: DeterministicEmbedderOptions = {}): Embedder {
  const dimensions = options.dimensions ?? 1024;
  const model = options.model ?? 'deterministic-stub';
  const maxTokens = options.maxTokens ?? 8192;
  const batchSize = options.batchSize ?? 32;
  validatePositiveInteger('dimensions', dimensions);
  validatePositiveInteger('maxTokens', maxTokens);
  validatePositiveInteger('batchSize', batchSize);
  const metadata = createMetadata({
    provider: 'deterministic',
    model,
    dimensions,
    maxTokens,
    batchSize,
  });
  return {
    metadata,
    embed(inputs): Promise<readonly EmbeddingResult[]> {
      return Promise.resolve().then(() => {
        validateInputs(inputs, metadata);
        return inputs.map(({ id, text }) => ({ id, vector: deterministicVector(text, dimensions) }));
      });
    },
  };
}

export interface MemoryChunk {
  readonly id: string;
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly index: number;
}

export interface ChunkTextOptions {
  readonly maxCharacters?: number;
  readonly overlapCharacters?: number;
}

export function chunkText(text: string, options: ChunkTextOptions = {}): readonly MemoryChunk[] {
  const maxCharacters = options.maxCharacters ?? 1800;
  const overlapCharacters = options.overlapCharacters ?? 200;
  validatePositiveInteger('maxCharacters', maxCharacters);
  if (!Number.isInteger(overlapCharacters) || overlapCharacters < 0 || overlapCharacters >= maxCharacters) {
    throw new EmbeddingError('invalid-input', 'overlapCharacters must be between zero and maxCharacters - 1');
  }
  if (text.length === 0) return [];

  const chunks: MemoryChunk[] = [];
  let start = 0;
  while (start < text.length) {
    const preferredEnd = Math.min(start + maxCharacters, text.length);
    const end = preferredEnd === text.length ? preferredEnd : findBoundary(text, start, preferredEnd);
    const chunkTextValue = text.slice(start, end);
    chunks.push({
      id: `chunk-${chunks.length}-${hashText(`${start}:${end}:${chunkTextValue}`).slice(0, 16)}`,
      text: chunkTextValue,
      start,
      end,
      index: chunks.length,
    });
    if (end >= text.length) break;
    const nextStart = Math.max(start + 1, end - overlapCharacters);
    start = nextStart;
  }
  return chunks;
}

export function embeddingFingerprint(metadata: Pick<EmbedderMetadata, 'provider' | 'model' | 'dimensions' | 'pooling' | 'normalized' | 'maxTokens' | 'batchSize' | 'implementationVersion'>): string {
  return hashText(JSON.stringify({
    provider: metadata.provider,
    model: metadata.model,
    dimensions: metadata.dimensions,
    pooling: metadata.pooling,
    normalized: metadata.normalized,
    maxTokens: metadata.maxTokens,
    batchSize: metadata.batchSize,
    implementationVersion: metadata.implementationVersion,
  }));
}

function createMetadata(input: Omit<EmbedderMetadata, 'normalized' | 'pooling' | 'fingerprint' | 'implementationVersion'>): EmbedderMetadata {
  const metadata = {
    ...input,
    pooling: 'mean' as const,
    normalized: true as const,
    implementationVersion: EMBEDDING_IMPLEMENTATION_VERSION,
  };
  return { ...metadata, fingerprint: embeddingFingerprint(metadata) };
}

async function defaultBgeM3PipelineLoader(modelPath: string): Promise<BgeM3Pipeline> {
  if (!await pathExists(modelPath)) {
    throw new EmbeddingError('unavailable', 'configured local embedding model path does not exist');
  }
  const transformers: { readonly pipeline: typeof transformersPipeline } = await import('@huggingface/transformers');
  return transformers.pipeline('feature-extraction', modelPath, {
    dtype: 'fp32',
    local_files_only: true,
  });
}

function readBgeM3Output(
  output: { readonly dims: readonly number[]; readonly data: { readonly length: number; readonly [index: number]: number | bigint } },
  inputs: readonly EmbeddingInput[],
  dimensions: number,
): readonly EmbeddingResult[] {
  const expectedLength = inputs.length * dimensions;
  if (output.dims.length !== 2 || output.dims[0] !== inputs.length || output.dims[1] !== dimensions || output.data.length !== expectedLength) {
    throw new EmbeddingError('incompatible', 'local embedding model returned an incompatible tensor shape');
  }
  return inputs.map(({ id }, index) => ({
    id,
    vector: normalizeVector(Array.from({ length: dimensions }, (_, dimension) => Number(output.data[index * dimensions + dimension]))),
  }));
}

function normalizeVector(vector: readonly number[]): readonly number[] {
  const sumSquares = vector.reduce((sum, value) => {
    if (!Number.isFinite(value)) throw new EmbeddingError('incompatible', 'local embedding model returned a non-finite value');
    return sum + value * value;
  }, 0);
  const norm = Math.sqrt(sumSquares);
  if (!Number.isFinite(norm) || norm === 0) throw new EmbeddingError('incompatible', 'local embedding model returned a zero vector');
  return vector.map((value) => value / norm);
}

export function classifyEmbeddingError(error: unknown): EmbeddingError {
  if (error instanceof EmbeddingError) return error;
  const message = errorMessage(error);
  const causeCode = errorCode(error);
  const normalized = `${causeCode ?? ''} ${message}`.toLocaleLowerCase();
  if (/enoent|not found|allowremotemodels|local_files_only|model path/.test(normalized)) {
    return new EmbeddingError('unavailable', 'local embedding model is unavailable', causeCode);
  }
  if (/onnx|tensor|shape|dimension|incompatible|invalid model|model file/.test(normalized)) {
    return new EmbeddingError('incompatible', 'local embedding model is incompatible', causeCode);
  }
  return new EmbeddingError('unknown', 'local embedding provider failed', causeCode);
}

function validateInputs(inputs: readonly EmbeddingInput[], metadata: EmbedderMetadata): void {
  for (const input of inputs) {
    if (input.id.length === 0 || input.text.length === 0) {
      throw new EmbeddingError('invalid-input', 'embedding input id and text must be non-empty');
    }
    if (input.text.length > metadata.maxTokens * 4) {
      throw new EmbeddingError('invalid-input', 'embedding input exceeds the configured text limit');
    }
  }
}

function deterministicVector(text: string, dimensions: number): readonly number[] {
  const values = new Array<number>(dimensions);
  let offset = 0;
  let sumSquares = 0;
  while (offset < dimensions) {
    const digest = createHash('sha256').update(`${text}:${offset}`).digest();
    for (const byte of digest) {
      if (offset >= dimensions) break;
      const value = (byte / 127.5) - 1;
      values[offset] = value;
      sumSquares += value * value;
      offset += 1;
    }
  }
  const norm = Math.sqrt(sumSquares);
  return values.map((value) => value / norm);
}

function findBoundary(text: string, start: number, preferredEnd: number): number {
  const window = text.slice(start, preferredEnd);
  const boundaryPattern = /[。！？.!?\n]\s*|\s+/gu;
  let boundary = -1;
  for (const match of window.matchAll(boundaryPattern)) {
    boundary = match.index + match[0].length;
  }
  if (boundary <= 0) return preferredEnd;
  return start + boundary;
}

function validatePositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) throw new EmbeddingError('invalid-input', `${name} must be a positive integer`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') return error.message;
  return String(error);
}

function hashText(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export * from './rpc.js';
