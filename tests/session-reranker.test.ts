import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDeterministicReranker, FtsRetrievalProvider, type SemanticRetriever } from '../packages/retrieval/src/index.js';
import { SessionContextService, observationContentHash } from '../packages/session/src/index.js';
import { contentHash, DatabaseStore } from '../packages/storage/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';
import type { Memory } from '../packages/domain/src/index.js';

function memory(id: string, title: string, body: string): Memory {
  return {
    schemaVersion: 1,
    id,
    type: 'lessons',
    scope: { kind: 'project', id: 'taga' },
    projectId: 'taga',
    status: 'active',
    title,
    summary: body,
    confidence: 0.9,
    sourceTrust: 'observed',
    visibility: 'private',
    created: '2026-11-13T00:00:00.000Z',
    updated: '2026-11-13T00:00:00.000Z',
    lastVerified: null,
    lastRecalled: null,
    reviewCount: 0,
    usefulCount: 0,
    notUsefulCount: 0,
    expiresAt: null,
    contentHash: contentHash(body),
    sources: [{ kind: 'test', locator: 'session-reranker.test.ts' }],
    anchors: [],
    tags: [],
    supersedes: null,
  };
}

describe('session context and reranker', () => {
  it('caches session-start packs and hides observation bodies by default', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(join(fixture.path, 'taga.db'));
    const item = memory('memory-1', 'Zvec writer', 'Use one daemon writer for Zvec.');
    const provider = new FtsRetrievalProvider(database);
    provider.upsert(item, item.summary);
    const service = new SessionContextService(fixture.path, database);
    const records = [{ memory: item, body: item.summary }];

    const first = await service.start({ agentId: 'claude', sessionId: 'session-1', projectId: 'taga', task: 'Zvec writer' }, records);
    const second = await service.start({ agentId: 'claude', sessionId: 'session-1', projectId: 'taga', task: 'Zvec writer' }, records);
    expect(first.source).toBe('fts5');
    expect(second.source).toBe('cache');

    const observation = {
      id: 'observation-1',
      sessionId: 'session-1',
      projectId: 'taga',
      occurredAt: '2026-11-13T01:00:00.000Z',
      sequence: 1,
      kind: 'tool_call',
      summary: 'Ran the focused semantic test.',
      body: 'secret command output',
      memoryIds: [item.id],
      sourceRefs: ['tests/semantic-retriever.test.ts'],
      contentHash: observationContentHash({ sessionId: 'session-1', sequence: 1, kind: 'tool_call', summary: 'Ran the focused semantic test.' }),
    } as const;
    expect(service.recordObservation(observation)).toBe(true);
    expect(service.recordObservation({ ...observation, id: 'observation-duplicate' })).toBe(false);
    expect(service.timeline({ memoryId: item.id })[0]?.body).toBeUndefined();
    expect(service.timeline({ memoryId: item.id, includeBody: true })[0]?.body).toContain('secret');

    database.close();
    await fixture.cleanup();
  });

  it('marks reranked hybrid results and keeps a deterministic fallback contract', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(join(fixture.path, 'taga.db'));
    const first = memory('memory-1', 'Retry policy', 'Use bounded retries for transient failures.');
    const second = memory('memory-2', 'Zvec writer', 'Use one daemon writer for native vector writes.');
    const provider = new FtsRetrievalProvider(database);
    provider.upsert(first, first.summary);
    provider.upsert(second, second.summary);
    const semantic: SemanticRetriever = {
      search: () => Promise.resolve([
        { memory: database.getMemoryIndex(first.id)!, score: 0.9 },
        { memory: database.getMemoryIndex(second.id)!, score: 0.8 },
      ]),
    };
    const result = await provider.searchHybrid({ query: 'bounded retry policy', limit: 2 }, semantic, {
      reranker: createDeterministicReranker(),
      rerankTopK: 2,
    });
    expect(result.rerankerAvailable).toBe(true);
    expect(result.rerankerDegraded).toBe(false);
    expect(result.items[0]?.matchReason).toContain('rerank:cross-encoder');

    database.close();
    await fixture.cleanup();
  });
});
