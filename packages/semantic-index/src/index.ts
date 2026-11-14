import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ZVecCollection, ZVecDocInput, ZVecStatus } from '@zvec/zvec';
import { ZvecRuntimeAdapter, type ZvecRuntimeModule } from '../../zvec/src/index.js';
export {
  enqueueSemanticOptimize,
  enqueueSemanticRebuild,
  enqueueSemanticRemove,
  enqueueSemanticUpsert,
  type SemanticJobPayload,
  type SemanticRebuildJobPayload,
} from './jobs.js';
export { ZvecSemanticRetriever, type ZvecSemanticRetrieverOptions } from './retriever.js';

const schemaVersion = 1;

export interface MemoryChunkRecord {
  readonly id: string;
  readonly memoryId: string;
  readonly chunkIndex: number;
  readonly chunkStart: number;
  readonly chunkEnd: number;
  readonly scopeKind: string;
  readonly scopeId: string | null;
  readonly status: string;
  readonly visibility: string;
  readonly sourceTrust: string;
  readonly contentHash: string;
  readonly vector: readonly number[];
}

export interface SemanticIndexMetadata {
  readonly generationId: string;
  readonly schemaVersion: number;
  readonly embeddingFingerprint: string;
  readonly dimensions: number;
  readonly createdAt: string;
}

export interface SemanticIndexHit {
  readonly id: string;
  readonly memoryId: string;
  readonly chunkIndex: number;
  readonly chunkStart: number;
  readonly chunkEnd: number;
  readonly scopeKind: string;
  readonly scopeId: string | null;
  readonly status: string;
  readonly visibility: string;
  readonly sourceTrust: string;
  readonly contentHash: string;
  readonly score: number;
}

export interface SemanticIndexQuery {
  readonly vector: readonly number[];
  readonly topK?: number;
  readonly scopeKind?: string;
  readonly scopeId?: string | null;
  readonly status?: string;
}

export interface SemanticIndexIntegrityReport {
  readonly ok: boolean;
  readonly activeGeneration: SemanticIndexMetadata | null;
  readonly generations: readonly SemanticIndexMetadata[];
  readonly issues: readonly string[];
}

export class SemanticIndexError extends Error {
  constructor(readonly code: 'not-configured' | 'invalid' | 'corrupt' | 'busy' | 'unknown', message: string) {
    super(message);
    this.name = 'SemanticIndexError';
  }
}

export class ZvecMemoryIndex {
  private cachedReader: { readonly generationId: string; readonly collection: ZVecCollection } | undefined;

  constructor(
    private readonly rootPath: string,
    private readonly adapter = new ZvecRuntimeAdapter(),
  ) {}

  close(): void {
    this.closeCachedReader();
  }

  async initialize(embeddingFingerprint: string, dimensions: number): Promise<SemanticIndexMetadata> {
    const active = await this.readActiveMetadata();
    if (active !== null && active.embeddingFingerprint === embeddingFingerprint && active.dimensions === dimensions) return active;
    const generation = await this.createGeneration(embeddingFingerprint, dimensions);
    if (active === null) await this.activateGeneration(generation.generationId);
    return generation;
  }

  async createGeneration(embeddingFingerprint: string, dimensions: number): Promise<SemanticIndexMetadata> {
    validateDimensions(dimensions);
    const generationId = `generation-${Date.now()}-${randomUUID()}`;
    const metadata: SemanticIndexMetadata = {
      generationId,
      schemaVersion,
      embeddingFingerprint,
      dimensions,
      createdAt: new Date().toISOString(),
    };
    const generationPath = this.generationPath(generationId);
    await mkdir(generationPath, { recursive: true });
    try {
      const runtime = await this.adapter.load();
      const collection = this.openNewCollection(runtime, generationPath, dimensions);
      try {
        collection.createIndexSync({
          fieldName: 'embedding',
          indexParams: { indexType: runtime.ZVecIndexType.HNSW, metricType: runtime.ZVecMetricType.COSINE },
        });
      } finally {
        collection.closeSync();
      }
      await writeJson(this.metadataPath(generationId), metadata);
      return metadata;
    } catch (error) {
      await rm(generationPath, { recursive: true, force: true });
      throw error;
    }
  }

  async activateGeneration(generationId: string): Promise<void> {
    const metadata = await this.readGenerationMetadata(generationId);
    if (metadata === null) throw new SemanticIndexError('not-configured', `generation ${generationId} does not exist`);
    await this.validateGeneration(generationId);
    this.closeCachedReader();
    await writeJson(this.activePath(), metadata);
  }

  async activeMetadata(): Promise<SemanticIndexMetadata> {
    const metadata = await this.readActiveMetadata();
    if (metadata === null) throw new SemanticIndexError('not-configured', 'semantic index is not initialized');
    return metadata;
  }

  async upsert(chunks: readonly MemoryChunkRecord[]): Promise<void> {
    if (chunks.length === 0) return;
    const metadata = await this.activeMetadata();
    await this.upsertToGeneration(metadata.generationId, chunks);
  }

  async upsertToGeneration(generationId: string, chunks: readonly MemoryChunkRecord[]): Promise<void> {
    if (chunks.length === 0) return;
    const metadata = await this.requireGeneration(generationId);
    validateChunks(chunks, metadata);
    this.closeCachedReader(generationId);
    const collection = await this.openWriter(metadata);
    try {
      assertStatuses(collection.upsertSync(chunks.map(toDocument)));
    } finally {
      collection.closeSync();
    }
  }

  async removeMemory(memoryId: string): Promise<void> {
    const metadata = await this.activeMetadata();
    await this.removeMemoryFromGeneration(metadata.generationId, memoryId);
  }

  async removeMemoryFromGeneration(generationId: string, memoryId: string): Promise<void> {
    const metadata = await this.requireGeneration(generationId);
    this.closeCachedReader(generationId);
    const reader = await this.openReader(metadata);
    let ids: string[] = [];
    try {
      ids = [...reader.iterDocsSync({ includeVector: false, outputFields: ['memory_id'] })]
        .filter((document) => document.fields.memory_id === memoryId)
        .map(({ id }) => id);
    } finally {
      reader.closeSync();
    }
    if (ids.length === 0) return;
    const writer = await this.openWriter(metadata);
    try {
      assertStatuses(writer.deleteSync(ids));
    } finally {
      writer.closeSync();
    }
  }

  async query(input: SemanticIndexQuery): Promise<readonly SemanticIndexHit[]> {
    const metadata = await this.activeMetadata();
    if (input.vector.length !== metadata.dimensions) throw new SemanticIndexError('invalid', 'query vector dimensions do not match the active index');
    const reader = await this.openCachedReader(metadata);
    return queryCollection(reader, input);
  }

  async queryGeneration(generationId: string, input: SemanticIndexQuery): Promise<readonly SemanticIndexHit[]> {
    const metadata = await this.requireGeneration(generationId);
    if (input.vector.length !== metadata.dimensions) throw new SemanticIndexError('invalid', 'query vector dimensions do not match the active index');
    const reader = await this.openReader(metadata);
    try {
      return queryCollection(reader, input);
    } finally {
      reader.closeSync();
    }
  }

  async stats(): Promise<{ readonly generation: SemanticIndexMetadata; readonly docCount: number }> {
    const metadata = await this.activeMetadata();
    return this.statsGeneration(metadata.generationId);
  }

  async statsGeneration(generationId: string): Promise<{ readonly generation: SemanticIndexMetadata; readonly docCount: number }> {
    const metadata = await this.requireGeneration(generationId);
    const reader = await this.openReader(metadata);
    try {
      return { generation: metadata, docCount: reader.stats.docCount };
    } finally {
      reader.closeSync();
    }
  }

  async integrity(): Promise<SemanticIndexIntegrityReport> {
    const issues: string[] = [];
    let active: SemanticIndexMetadata | null = null;
    try {
      active = await this.readActiveMetadata();
    } catch (error) {
      issues.push(errorMessage(error));
    }
    const generations: SemanticIndexMetadata[] = [];
    try {
      for (const entry of await readdir(join(this.rootPath, 'generations'), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        try {
          const metadata = await this.readGenerationMetadata(entry.name);
          if (metadata !== null) generations.push(metadata);
        } catch (error) {
          issues.push(`generation ${entry.name}: ${errorMessage(error)}`);
        }
      }
    } catch (error) {
      if (!isMissing(error)) issues.push(errorMessage(error));
    }
    if (active !== null && !generations.some(({ generationId }) => generationId === active.generationId)) issues.push('active generation metadata is missing');
    if (active !== null) {
      try {
        await this.validateGeneration(active.generationId);
      } catch (error) {
        issues.push(`active generation collection cannot be opened: ${errorMessage(error)}`);
      }
    }
    return { ok: issues.length === 0, activeGeneration: active, generations, issues };
  }

  async validateGeneration(generationId: string): Promise<void> {
    const metadata = await this.requireGeneration(generationId);
    const reader = await this.openReader(metadata);
    reader.closeSync();
  }

  async optimize(): Promise<void> {
    const metadata = await this.activeMetadata();
    this.closeCachedReader(metadata.generationId);
    const writer = await this.openWriter(metadata);
    try {
      writer.optimizeSync();
    } finally {
      writer.closeSync();
    }
  }

  async cleanupGenerations(maxGenerations = 2): Promise<readonly string[]> {
    if (!Number.isInteger(maxGenerations) || maxGenerations < 1) throw new SemanticIndexError('invalid', 'maxGenerations must be a positive integer');
    const active = await this.readActiveMetadata();
    const generations = [...await this.listGenerationMetadata()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const keep = new Set(generations.slice(0, maxGenerations).map(({ generationId }) => generationId));
    if (active !== null) keep.add(active.generationId);
    const removed: string[] = [];
    for (const generation of generations) {
      if (keep.has(generation.generationId)) continue;
      this.closeCachedReader(generation.generationId);
      await rm(this.generationPath(generation.generationId), { recursive: true, force: true });
      removed.push(generation.generationId);
    }
    return removed;
  }

  private async requireGeneration(generationId: string): Promise<SemanticIndexMetadata> {
    const metadata = await this.readGenerationMetadata(generationId);
    if (metadata === null) throw new SemanticIndexError('not-configured', 'generation ' + generationId + ' does not exist');
    return metadata;
  }

  private async listGenerationMetadata(): Promise<readonly SemanticIndexMetadata[]> {
    try {
      const entries = await readdir(join(this.rootPath, 'generations'), { withFileTypes: true });
      const result: SemanticIndexMetadata[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const metadata = await this.readGenerationMetadata(entry.name);
        if (metadata !== null) result.push(metadata);
      }
      return result;
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  private async openReader(metadata: SemanticIndexMetadata): Promise<ZVecCollection> {
    return this.adapter.open(this.collectionPath(metadata.generationId), 'read-only');
  }

  private async openCachedReader(metadata: SemanticIndexMetadata): Promise<ZVecCollection> {
    if (this.cachedReader?.generationId === metadata.generationId) return this.cachedReader.collection;
    this.closeCachedReader();
    const collection = await this.openReader(metadata);
    this.cachedReader = { generationId: metadata.generationId, collection };
    return collection;
  }

  private closeCachedReader(generationId?: string): void {
    if (this.cachedReader === undefined || generationId !== undefined && this.cachedReader.generationId !== generationId) return;
    this.cachedReader.collection.closeSync();
    this.cachedReader = undefined;
  }

  private async openWriter(metadata: SemanticIndexMetadata): Promise<ZVecCollection> {
    return this.adapter.open(this.collectionPath(metadata.generationId), 'read-write');
  }

  private openNewCollection(runtime: ZvecRuntimeModule, generationPath: string, dimensions: number): ZVecCollection {
    return runtime.ZVecCreateAndOpen(join(generationPath, 'memory_chunks'), new runtime.ZVecCollectionSchema({
      name: 'memory_chunks',
      fields: [
        { name: 'memory_id', dataType: runtime.ZVecDataType.STRING },
        { name: 'chunk_index', dataType: runtime.ZVecDataType.INT64 },
        { name: 'chunk_start', dataType: runtime.ZVecDataType.INT64 },
        { name: 'chunk_end', dataType: runtime.ZVecDataType.INT64 },
        { name: 'scope_kind', dataType: runtime.ZVecDataType.STRING },
        { name: 'scope_id', dataType: runtime.ZVecDataType.STRING, nullable: true },
        { name: 'status', dataType: runtime.ZVecDataType.STRING },
        { name: 'visibility', dataType: runtime.ZVecDataType.STRING },
        { name: 'source_trust', dataType: runtime.ZVecDataType.STRING },
        { name: 'content_hash', dataType: runtime.ZVecDataType.STRING },
      ],
      vectors: { name: 'embedding', dataType: runtime.ZVecDataType.VECTOR_FP32, dimension: dimensions },
    }), { readOnly: false });
  }

  private async buildGeneration(generationId: string, chunks: readonly MemoryChunkRecord[]): Promise<void> {
    await this.upsertToGeneration(generationId, chunks);
    await this.validateGeneration(generationId);
  }

  async rebuild(
    embeddingFingerprint: string,
    dimensions: number,
    chunks: readonly MemoryChunkRecord[],
  ): Promise<SemanticIndexMetadata> {
    const generation = await this.createGeneration(embeddingFingerprint, dimensions);
    try {
      await this.buildGeneration(generation.generationId, chunks);
      await this.activateGeneration(generation.generationId);
      return generation;
    } catch (error) {
      await rm(this.generationPath(generation.generationId), { recursive: true, force: true });
      throw error;
    }
  }

  private async readGenerationMetadata(generationId: string): Promise<SemanticIndexMetadata | null> {
    return readJson<SemanticIndexMetadata>(this.metadataPath(generationId), `generation ${generationId} metadata`);
  }

  private async readActiveMetadata(): Promise<SemanticIndexMetadata | null> {
    return readJson<SemanticIndexMetadata>(this.activePath(), 'active generation metadata');
  }

  private generationPath(generationId: string): string { return join(this.rootPath, 'generations', generationId); }
  private metadataPath(generationId: string): string { return join(this.generationPath(generationId), 'metadata.json'); }
  private collectionPath(generationId: string): string { return join(this.generationPath(generationId), 'memory_chunks'); }
  private activePath(): string { return join(this.rootPath, 'active.json'); }
}

function toDocument(chunk: MemoryChunkRecord): ZVecDocInput {
  return {
    id: chunk.id,
    fields: {
      memory_id: chunk.memoryId,
      chunk_index: chunk.chunkIndex,
      chunk_start: chunk.chunkStart,
      chunk_end: chunk.chunkEnd,
      scope_kind: chunk.scopeKind,
      scope_id: chunk.scopeId ?? '',
      status: chunk.status,
      visibility: chunk.visibility,
      source_trust: chunk.sourceTrust,
      content_hash: chunk.contentHash,
    },
    vectors: { embedding: chunk.vector },
  };
}

function queryCollection(collection: ZVecCollection, input: SemanticIndexQuery): readonly SemanticIndexHit[] {
  const filter = buildFilter(input);
  return collection.querySync({
    fieldName: 'embedding',
    vector: input.vector,
    topk: input.topK ?? 10,
    includeVector: false,
    outputFields: ['memory_id', 'chunk_index', 'chunk_start', 'chunk_end', 'scope_kind', 'scope_id', 'status', 'visibility', 'source_trust', 'content_hash'],
    ...(filter === undefined ? {} : { filter }),
  }).map(toHit);
}

function toHit(document: { id: string; score: number; fields: Record<string, unknown> }): SemanticIndexHit {
  return {
    id: document.id,
    memoryId: String(document.fields.memory_id),
    chunkIndex: Number(document.fields.chunk_index),
    chunkStart: Number(document.fields.chunk_start),
    chunkEnd: Number(document.fields.chunk_end),
    scopeKind: String(document.fields.scope_kind),
    scopeId: scalarString(document.fields.scope_id) === '' ? null : scalarString(document.fields.scope_id),
    status: String(document.fields.status),
    visibility: String(document.fields.visibility),
    sourceTrust: String(document.fields.source_trust),
    contentHash: String(document.fields.content_hash),
    score: document.score,
  };
}

function buildFilter(input: SemanticIndexQuery): string | undefined {
  const filters: string[] = [];
  if (input.scopeKind !== undefined) filters.push(`scope_kind = '${escapeFilterValue(input.scopeKind)}'`);
  if (input.scopeId !== undefined && input.scopeId !== null) filters.push(`scope_id = '${escapeFilterValue(input.scopeId)}'`);
  if (input.status !== undefined) filters.push(`status = '${escapeFilterValue(input.status)}'`);
  return filters.length === 0 ? undefined : filters.join(' AND ');
}

function escapeFilterValue(value: string): string { return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'"); }

function validateChunks(chunks: readonly MemoryChunkRecord[], metadata: SemanticIndexMetadata): void {
  for (const chunk of chunks) {
    if (chunk.vector.length !== metadata.dimensions) throw new SemanticIndexError('invalid', 'chunk vector dimensions do not match the active index');
    if (chunk.id.length === 0 || chunk.memoryId.length === 0) throw new SemanticIndexError('invalid', 'chunk identifiers must be non-empty');
  }
}

function validateDimensions(dimensions: number): void {
  if (!Number.isInteger(dimensions) || dimensions <= 0) throw new SemanticIndexError('invalid', 'embedding dimensions must be a positive integer');
}

function assertStatuses(status: ZVecStatus | readonly ZVecStatus[]): void {
  const statuses: readonly ZVecStatus[] = Array.isArray(status) ? status : [status];
  const failure = statuses.find((item) => !item.ok);
  if (failure !== undefined) throw new SemanticIndexError('unknown', failure.message);
}

function scalarString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, 'utf8');
  await rename(temporaryPath, path);
}

async function readJson<T>(path: string, description: string): Promise<T | null> {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(content);
    if (!isSemanticIndexMetadata(parsed)) throw new Error('required generation metadata fields are missing or invalid');
    return parsed as T;
  } catch (error) {
    throw new SemanticIndexError('corrupt', `${description} is malformed: ${errorMessage(error)}`);
  }
}

function isSemanticIndexMetadata(value: unknown): value is SemanticIndexMetadata {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<SemanticIndexMetadata>;
  return typeof candidate.generationId === 'string'
    && candidate.generationId.length > 0
    && candidate.schemaVersion === schemaVersion
    && typeof candidate.embeddingFingerprint === 'string'
    && candidate.embeddingFingerprint.length > 0
    && typeof candidate.dimensions === 'number'
    && Number.isInteger(candidate.dimensions)
    && candidate.dimensions > 0
    && typeof candidate.createdAt === 'string'
    && candidate.createdAt.length > 0;
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
