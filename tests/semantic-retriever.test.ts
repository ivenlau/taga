import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { createDeterministicEmbedder } from '../packages/embedding/src/index.js';
import type { Memory } from '../packages/domain/src/index.js';
import { FtsRetrievalProvider } from '../packages/retrieval/src/index.js';
import { DatabaseStore, contentHash } from '../packages/storage/src/index.js';
import { ZvecMemoryIndex, ZvecSemanticRetriever, type MemoryChunkRecord } from '../packages/semantic-index/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';

function memory(id: string, scope: Memory['scope'], status: Memory['status'] = 'active'): Memory {
  return {
    schemaVersion: 1,
    id,
    type: 'lessons',
    scope,
    projectId: scope.kind === 'project' ? scope.id : null,
    status,
    title: id,
    summary: 'semantic test memory',
    confidence: 0.9,
    sourceTrust: 'user_authored',
    visibility: 'private',
    created: '2026-11-13T00:00:00.000Z',
    updated: '2026-11-13T00:00:00.000Z',
    lastVerified: null,
    lastRecalled: null,
    reviewCount: 0,
    usefulCount: 0,
    notUsefulCount: 0,
    expiresAt: null,
    contentHash: contentHash(id + ':body'),
    sources: [{ kind: 'test', locator: 'semantic-retriever.test.ts' }],
    anchors: [],
    tags: [],
    supersedes: null,
  };
}

function chunk(memoryId: string, vector: readonly number[], contentHashValue: string, chunkIndex: number): MemoryChunkRecord {
  return {
    id: memoryId + ':' + chunkIndex,
    memoryId,
    chunkIndex,
    chunkStart: chunkIndex * 10,
    chunkEnd: chunkIndex * 10 + 10,
    scopeKind: 'project',
    scopeId: 'project-1',
    status: 'active',
    visibility: 'private',
    sourceTrust: 'user_authored',
    contentHash: contentHashValue,
    vector,
  };
}

describe('Zvec semantic retriever', () => {
  it('aggregates chunks and re-applies authoritative scope and hash filters', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(join(fixture.path, 'taga.db'));
    let index: ZvecMemoryIndex | undefined;
    try {
      const first = memory('memory-1', { kind: 'project', id: 'project-1' });
      const second = memory('memory-2', { kind: 'project', id: 'project-2' });
      const global = memory('memory-global', { kind: 'global' });
      const fts = new FtsRetrievalProvider(database);
      fts.upsert(first, 'first');
      fts.upsert(second, 'second');
      fts.upsert(global, 'global');
      const embedder = createDeterministicEmbedder({ dimensions: 4 });
      const [query] = await embedder.embed([{ id: 'query', text: 'semantic query' }]);
      if (query === undefined) throw new Error('query vector missing');
      index = new ZvecMemoryIndex(join(fixture.path, 'semantic'));
      await index.initialize(embedder.metadata.fingerprint, 4);
      await index.upsert([
        chunk(first.id, query.vector, first.contentHash, 0),
        chunk(first.id, query.vector.map((value) => -value), first.contentHash, 1),
        { ...chunk(second.id, query.vector, second.contentHash, 0), scopeId: 'project-2' },
        { ...chunk(global.id, query.vector, 'sha256:stale', 0), scopeKind: 'global', scopeId: null },
      ]);
      const retriever = new ZvecSemanticRetriever({ database, index, embedder });
      const results = await retriever.search({ query: 'semantic query', scope: { kind: 'project', id: 'project-1' }, limit: 10 });
      expect(results.map((result) => result.memory.id)).toEqual(['memory-1']);
      expect(results[0]?.bestChunk).toEqual({ index: 0, start: 0, end: 10 });
    } finally {
      index?.close();
      database.close();
      await fixture.cleanup();
    }
  });
});
