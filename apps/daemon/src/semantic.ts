import { join } from 'node:path';
import { chunkText, createLocalBgeM3Embedder, type EmbeddingInput } from '../../../packages/embedding/src/index.js';
import { enqueueSemanticRebuild, ZvecMemoryIndex, type MemoryChunkRecord } from '../../../packages/semantic-index/src/index.js';
import { MarkdownMemoryRepository, type DatabaseStore, type JobRecord, type StoredMemory } from '../../../packages/storage/src/index.js';

export function semanticJobHandlers(brainPath: string, database: DatabaseStore, modelPath = ''): ReadonlyMap<string, (job: JobRecord) => Promise<void>> {
  const semanticRoot = join(brainPath, '.taga', 'semantic');
  let sharedEmbedder: ReturnType<typeof createLocalBgeM3Embedder> | undefined;
  let sharedIndex: ZvecMemoryIndex | undefined;
  const getEmbedder = (): ReturnType<typeof createLocalBgeM3Embedder> => {
    if (modelPath.length === 0) throw new Error('retrieval.semantic.modelPath is not configured');
    sharedEmbedder ??= createLocalBgeM3Embedder({ modelPath, batchSize: 4 });
    return sharedEmbedder;
  };
  const getIndex = (): ZvecMemoryIndex => {
    sharedIndex ??= new ZvecMemoryIndex(semanticRoot);
    return sharedIndex;
  };
  const handlers = new Map([
    ['semantic.upsert', async (job: JobRecord) => {
      const payload = JSON.parse(job.payload) as { memoryId?: unknown; contentHash?: unknown };
      if (typeof payload.memoryId !== 'string') throw new Error('semantic.upsert payload memoryId is invalid');
      const record = (await new MarkdownMemoryRepository(brainPath).records()).find(({ memory }) => memory.id === payload.memoryId);
      const index = getIndex();
      if (record === undefined) {
        await index.removeMemory(payload.memoryId);
        return;
      }
      if (typeof payload.contentHash === 'string' && payload.contentHash !== record.memory.contentHash) return;
      const embedder = getEmbedder();
      const chunks = chunkText(`${record.memory.title}\n\n${record.memory.summary}\n\n${record.body}`);
      const inputs: readonly EmbeddingInput[] = chunks.map((chunk) => ({ id: `${record.memory.id}:${chunk.index}`, text: chunk.text }));
      const vectors = await embedder.embed(inputs);
      const integrity = await index.integrity();
      if (integrity.activeGeneration !== null
        && (integrity.activeGeneration.embeddingFingerprint !== embedder.metadata.fingerprint || integrity.activeGeneration.dimensions !== embedder.metadata.dimensions)) {
        enqueueSemanticRebuild(database);
        return;
      }
      await index.initialize(embedder.metadata.fingerprint, embedder.metadata.dimensions);
      const records: readonly MemoryChunkRecord[] = chunks.map((chunk, index) => ({
        id: `${record.memory.id}:${chunk.index}`,
        memoryId: record.memory.id,
        chunkIndex: chunk.index,
        chunkStart: chunk.start,
        chunkEnd: chunk.end,
        scopeKind: record.memory.scope.kind,
        scopeId: record.memory.scope.kind === 'global' ? null : record.memory.scope.id,
        status: record.memory.status,
        visibility: record.memory.visibility,
        sourceTrust: record.memory.sourceTrust,
        contentHash: record.memory.contentHash,
        vector: vectors[index]?.vector ?? [],
      }));
      await index.removeMemory(record.memory.id);
      await index.upsert(records);
    }],
    ['semantic.remove', async (job: JobRecord) => {
      const payload = JSON.parse(job.payload) as { memoryId?: unknown };
      if (typeof payload.memoryId !== 'string') throw new Error('semantic.remove payload memoryId is invalid');
      const index = getIndex();
      const integrity = await index.integrity();
      if (integrity.activeGeneration !== null) await index.removeMemory(payload.memoryId);
    }],
    ['semantic.rebuild', async () => {
      const embedder = getEmbedder();
      const repository = new MarkdownMemoryRepository(brainPath);
      const index = getIndex();
      let records = await repository.records();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const chunks = await embedRecords(records, embedder);
        const latest = await repository.records();
        if (!sameContent(records, latest)) {
          records = latest;
          continue;
        }
        await index.rebuild(embedder.metadata.fingerprint, embedder.metadata.dimensions, chunks);
        await index.cleanupGenerations();
        for (const record of latest) database.enqueueJobIfAbsent({
          id: `semantic-upsert-${record.memory.id}-${record.memory.contentHash}`,
          kind: 'semantic.upsert',
          payload: JSON.stringify({ memoryId: record.memory.id, contentHash: record.memory.contentHash }),
        });
        return;
      }
      throw new Error('Markdown changed continuously during semantic rebuild');
    }],
    ['semantic.optimize', async () => {
      const index = getIndex();
      const integrity = await index.integrity();
      if (integrity.activeGeneration !== null) await index.optimize();
    }],
  ]);
  return new Map([...handlers].map(([kind, handler]) => [kind, async (job: JobRecord) => {
    try {
      await handler(job);
    } finally {
      sharedIndex?.close();
    }
  }]));
}

async function embedRecords(records: readonly StoredMemory[], embedder: ReturnType<typeof createLocalBgeM3Embedder>): Promise<readonly MemoryChunkRecord[]> {
  const chunks = records.flatMap((record) => {
    const parts = chunkText(`${record.memory.title}\n\n${record.memory.summary}\n\n${record.body}`);
    return parts.map((chunk) => ({ record, chunk }));
  });
  const inputs: readonly EmbeddingInput[] = chunks.map(({ record, chunk }) => ({ id: `${record.memory.id}:${chunk.index}`, text: chunk.text }));
  const vectors = await embedder.embed(inputs);
  return chunks.map(({ record, chunk }, index) => ({
    id: `${record.memory.id}:${chunk.index}`,
    memoryId: record.memory.id,
    chunkIndex: chunk.index,
    chunkStart: chunk.start,
    chunkEnd: chunk.end,
    scopeKind: record.memory.scope.kind,
    scopeId: record.memory.scope.kind === 'global' ? null : record.memory.scope.id,
    status: record.memory.status,
    visibility: record.memory.visibility,
    sourceTrust: record.memory.sourceTrust,
    contentHash: record.memory.contentHash,
    vector: vectors[index]?.vector ?? [],
  }));
}

function sameContent(left: readonly StoredMemory[], right: readonly StoredMemory[]): boolean {
  if (left.length !== right.length) return false;
  const rightHashes = new Map(right.map((record) => [record.memory.id, record.memory.contentHash]));
  return left.every((record) => rightHashes.get(record.memory.id) === record.memory.contentHash);
}
