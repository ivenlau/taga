import { existsSync } from 'node:fs';
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LiteMcpServer } from '../apps/mcp/src/index.js';
import { FtsRetrievalProvider, type SemanticRetriever } from '../packages/retrieval/src/index.js';
import { selectContextCandidates, SessionContextService, type SessionMemoryRecord } from '../packages/session/src/index.js';
import { DatabaseStore, type MemoryIndexEntry } from '../packages/storage/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';
import type { Memory } from '../packages/domain/src/index.js';

function createMemory(id: string, title: string): Memory {
  return {
    schemaVersion: 1,
    id,
    type: 'lessons',
    scope: { kind: 'global' },
    projectId: null,
    status: 'active',
    title,
    summary: 'Retry transient network failures.',
    confidence: 0.8,
    sourceTrust: 'observed',
    visibility: 'private',
    created: '2026-11-10T00:00:00.000Z',
    updated: '2026-11-10T00:00:00.000Z',
    lastVerified: null,
    lastRecalled: null,
    reviewCount: 0,
    usefulCount: 0,
    notUsefulCount: 0,
    expiresAt: null,
    contentHash: `sha256:${id}`,
    sources: [{ kind: 'test', locator: 'session-context.test.ts' }],
    anchors: [],
    tags: [],
    supersedes: null,
  };
}

function createRecords(): SessionMemoryRecord[] {
  return [
    { memory: createMemory('memory-retry', 'Retry network request'), body: 'retry guidance' },
    { memory: createMemory('memory-unrelated', 'Unrelated topic'), body: 'something else' },
  ];
}

describe('selectContextCandidates', () => {
  it('reports all, fts5, and hybrid sources per selection path', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(`${fixture.path}/taga.db`);
    const provider = new FtsRetrievalProvider(database);
    const records = createRecords();
    for (const record of records) provider.upsert(record.memory, record.body);

    const all = await selectContextCandidates(database, {}, records);
    expect(all.source).toBe('all');
    expect(all.candidates).toHaveLength(2);

    const lexical = await selectContextCandidates(database, { task: 'retry' }, records);
    expect(lexical.source).toBe('fts5');
    expect(lexical.candidates.map((candidate) => candidate.memory.id)).toContain('memory-retry');

    const entry: MemoryIndexEntry = {
      id: 'memory-retry',
      type: 'lessons',
      status: 'active',
      visibility: 'private',
      scopeKind: 'global',
      scopeId: null,
      title: 'Retry network request',
      summary: 'Retry transient network failures.',
      body: 'retry guidance',
      tags: [],
      confidence: 0.8,
      sourceTrust: 'observed',
      contentHash: 'sha256:memory-retry',
      updatedAt: '2026-11-10T00:00:00.000Z',
    };
    const semantic: SemanticRetriever = {
      search: () => Promise.resolve([{ memory: entry, score: 0.9 }]),
    };
    const hybrid = await selectContextCandidates(database, { task: 'retry' }, records, semantic);
    expect(hybrid.source).toBe('hybrid');
    expect(hybrid.candidates.map((candidate) => candidate.memory.id)).toContain('memory-retry');
    expect(hybrid.candidates.find((candidate) => candidate.memory.id === 'memory-retry')?.score).toBeGreaterThan(0);

    const miss = await selectContextCandidates(database, { task: 'quantum zebra xyzzy' }, records);
    expect(miss.source).toBe('all');

    database.close();
    await fixture.cleanup();
  });
});

describe('SessionContextService cache', () => {
  it('rebuilds on invalid cache entries and evicts stale cache files', async () => {
    const fixture = await createTemporaryDirectory();
    const brain = join(fixture.path, 'brain');
    await mkdir(brain, { recursive: true });
    const database = new DatabaseStore(join(fixture.path, 'taga.db'));
    const service = new SessionContextService(brain, database);
    const records = createRecords();
    const input = { agentId: 'claude', sessionId: 'session-1' };

    const stalePath = join(brain, '.taga', 'context', 'stale-cache.json');
    await mkdir(join(brain, '.taga', 'context'), { recursive: true });
    await writeFile(stalePath, '{}\n', 'utf8');
    const oldTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(stalePath, oldTime, oldTime);

    const first = await service.start(input, records);
    expect(first.source).toBe('all');
    const cachePath = join(brain, '.taga', 'context', `${first.cacheKey}.json`);
    expect(existsSync(cachePath)).toBe(true);
    expect(existsSync(stalePath)).toBe(false);

    const cached = await service.start(input, records);
    expect(cached.source).toBe('cache');

    await writeFile(cachePath, '{"broken":', 'utf8');
    const rebuilt = await service.start(input, records);
    expect(rebuilt.source).not.toBe('cache');

    database.close();
    await fixture.cleanup();
  });
});

describe('session start audit', () => {
  it('records pack stats in the session-start audit payload', async () => {
    const fixture = await createTemporaryDirectory();
    const brain = join(fixture.path, 'brain');
    await mkdir(brain, { recursive: true });
    const server = new LiteMcpServer(brain);
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'memory_session_start', arguments: { session_id: 'audit-1', cwd: fixture.path } },
    });
    expect(response).not.toBeNull();
    server.close();
    const database = new DatabaseStore(join(brain, 'taga.db'));
    const event = database.listAuditEvents().find((item) => item.eventType === 'context.session_started');
    database.close();
    const payload = JSON.parse(event?.payload ?? '{}') as { stats?: { included: number; truncated: number; excluded: number; tokenEstimate: number } };
    const stats = payload.stats;
    expect(stats).toBeDefined();
    expect(typeof stats?.included).toBe('number');
    expect(typeof stats?.truncated).toBe('number');
    expect(typeof stats?.excluded).toBe('number');
    expect(typeof stats?.tokenEstimate).toBe('number');
    await fixture.cleanup();
  });
});
