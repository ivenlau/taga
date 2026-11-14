import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createDeterministicEmbedder } from '../packages/embedding/src/index.js';
import { ZvecMemoryIndex, type MemoryChunkRecord } from '../packages/semantic-index/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';
import { ZvecRuntimeAdapter } from '../packages/zvec/src/index.js';

vi.setConfig({ testTimeout: 30_000 });

function chunk(id: string, memoryId: string, vector: readonly number[], scopeId: string | null = 'project-1'): MemoryChunkRecord {
  return {
    id,
    memoryId,
    chunkIndex: 0,
    chunkStart: 0,
    chunkEnd: 20,
    scopeKind: scopeId === null ? 'global' : 'project',
    scopeId,
    status: 'active',
    visibility: 'private',
    sourceTrust: 'observed',
    contentHash: `sha256:${memoryId}`,
    vector,
  };
}

describe('Zvec memory index', () => {
  it('creates a generation, stores metadata-only chunks, queries, removes, and reopens', async () => {
    const fixture = await createTemporaryDirectory();
    let index: ZvecMemoryIndex | undefined;
    try {
      const embedder = createDeterministicEmbedder({ dimensions: 4 });
      index = new ZvecMemoryIndex(join(fixture.path, 'semantic'));
      const generation = await index.initialize(embedder.metadata.fingerprint, 4);
      const vector = (await embedder.embed([{ id: 'query', text: 'retry network failure' }]))[0]?.vector ?? [];
      await index.upsert([
        chunk('memory-1:0', 'memory-1', vector),
        { ...chunk('memory-1:1', 'memory-1', vector), chunkIndex: 1, chunkStart: 20, chunkEnd: 40 },
        chunk('memory-2:0', 'memory-2', [0, 1, 0, 0], null),
      ]);

      expect((await index.activeMetadata()).generationId).toBe(generation.generationId);
      expect((await index.stats()).docCount).toBe(3);
      expect((await index.query({ vector, topK: 3, scopeKind: 'project', scopeId: 'project-1' })).map((hit) => hit.memoryId)).toEqual(['memory-1', 'memory-1']);
      await index.removeMemory('memory-1');
      expect((await index.stats()).docCount).toBe(1);
      await expect(new ZvecMemoryIndex(join(fixture.path, 'semantic')).stats()).resolves.toMatchObject({ docCount: 1 });
    } finally {
      index?.close();
      await fixture.cleanup();
    }
  });

  it('keeps the active generation when a new generation is not activated', async () => {
    const fixture = await createTemporaryDirectory();
    let index: ZvecMemoryIndex | undefined;
    try {
      index = new ZvecMemoryIndex(join(fixture.path, 'semantic'));
      const first = await index.initialize('sha256:first', 4);
      const second = await index.createGeneration('sha256:second', 4);
      expect(second.generationId).not.toBe(first.generationId);
      expect((await index.activeMetadata()).generationId).toBe(first.generationId);
      await index.activateGeneration(second.generationId);
      expect((await index.activeMetadata()).generationId).toBe(second.generationId);
    } finally {
      index?.close();
      await fixture.cleanup();
    }
  });

  it('writes and validates a staging generation before activation', async () => {
    const fixture = await createTemporaryDirectory();
    let index: ZvecMemoryIndex | undefined;
    try {
      index = new ZvecMemoryIndex(join(fixture.path, 'semantic'));
      const first = await index.initialize('sha256:first', 4);
      await index.upsert([chunk('old:0', 'old', [1, 0, 0, 0])]);
      const staged = await index.initialize('sha256:second', 4);
      expect((await index.activeMetadata()).generationId).toBe(first.generationId);
      await index.upsertToGeneration(staged.generationId, [chunk('new:0', 'new', [0, 1, 0, 0])]);
      expect((await index.stats()).docCount).toBe(1);
      await index.activateGeneration(staged.generationId);
      expect((await index.stats()).docCount).toBe(1);
      expect((await index.query({ vector: [0, 1, 0, 0], topK: 1 }))[0]?.memoryId).toBe('new');
    } finally {
      index?.close();
      await fixture.cleanup();
    }
  });

  it('reuses the active reader until it is closed', async () => {
    const fixture = await createTemporaryDirectory();
    const index = new ZvecMemoryIndex(join(fixture.path, 'semantic'));
    const open = vi.spyOn(ZvecRuntimeAdapter.prototype, 'open');
    try {
      await index.initialize('sha256:first', 4);
      await index.upsert([chunk('memory-1:0', 'memory-1', [1, 0, 0, 0])]);
      open.mockClear();

      await index.query({ vector: [1, 0, 0, 0], topK: 1 });
      await index.query({ vector: [1, 0, 0, 0], topK: 1 });
      expect(open).toHaveBeenCalledTimes(1);

      index.close();
      await index.query({ vector: [1, 0, 0, 0], topK: 1 });
      expect(open).toHaveBeenCalledTimes(2);
    } finally {
      index.close();
      open.mockRestore();
      await fixture.cleanup();
    }
  });

  it('reports malformed generation metadata as corruption', async () => {
    const fixture = await createTemporaryDirectory();
    let index: ZvecMemoryIndex | undefined;
    try {
      index = new ZvecMemoryIndex(join(fixture.path, 'semantic'));
      await index.initialize('sha256:first', 4);
      await writeFile(join(fixture.path, 'semantic', 'active.json'), '{not-json', 'utf8');
      const report = await index.integrity();
      expect(report.ok).toBe(false);
      expect(report.issues.some((issue) => issue.includes('malformed'))).toBe(true);
    } finally {
      index?.close();
      await fixture.cleanup();
    }
  });
});
