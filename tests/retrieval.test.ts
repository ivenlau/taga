import { describe, expect, it } from 'vitest';
import { evaluateOfflineRetrieval, FtsRetrievalProvider } from '../packages/retrieval/src/index.js';
import { DatabaseStore } from '../packages/storage/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';
import type { Memory } from '../packages/domain/src/index.js';

function createMemory(id: string, scope: Memory['scope'], status: Memory['status'] = 'active'): Memory {
  return {
    schemaVersion: 1,
    id,
    type: 'lessons',
    scope,
    projectId: scope.kind === 'project' ? scope.id : null,
    status,
    title: 'Retry network request',
    summary: 'Retry transient network failures with a bounded delay.',
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
    sources: [{ kind: 'test', locator: 'retrieval.test.ts' }],
    anchors: [],
    tags: ['network'],
    supersedes: null,
  };
}

describe('FTS retrieval', () => {
  it('filters draft memories and ranks project scope above global', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(`${fixture.path}/taga.db`);
    const provider = new FtsRetrievalProvider(database);
    provider.upsert(createMemory('global', { kind: 'global' }), 'global retry guidance');
    provider.upsert(createMemory('project', { kind: 'project', id: 'project-1' }), 'project retry guidance');
    provider.upsert(createMemory('draft', { kind: 'project', id: 'project-1' }, 'draft'), 'draft retry guidance');

    const results = provider.search({ query: 'retry', scope: { kind: 'project', id: 'project-1' } });
    expect(results.map((result) => result.memory.id)).toEqual(['project', 'global']);
    expect(results[0]?.matchReason).toContain('scope:project');

    database.close();
    await fixture.cleanup();
  });

  it('includes domain memories for project recall and filters unrelated domains', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(`${fixture.path}/taga.db`);
    const provider = new FtsRetrievalProvider(database);
    provider.upsert(createMemory('domain-shared', { kind: 'domain', id: 'engineering' }), 'domain retry guidance');
    provider.upsert(createMemory('project-other', { kind: 'project', id: 'project-2' }), 'project retry guidance');
    const results = provider.search({ query: 'retry', scope: { kind: 'project', id: 'project-1' } });
    expect(results.map((result) => result.memory.id)).toContain('domain-shared');
    expect(results.map((result) => result.memory.id)).not.toContain('project-other');
    database.close();
    await fixture.cleanup();
  });

  it('fuses alternate wordings into lexical recall across languages', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(`${fixture.path}/taga.db`);
    const provider = new FtsRetrievalProvider(database);
    provider.upsert(createMemory('deploy-en', { kind: 'global' }), 'deploy process runs through the release pipeline');
    provider.upsert(createMemory('deploy-zh', { kind: 'global' }), '部署流程走发布流水线');

    const results = provider.search({ query: '部署', alternates: ['deploy process', 'release pipeline'] });
    expect(results.map((result) => result.memory.id)).toContain('deploy-zh');
    expect(results.map((result) => result.memory.id)).toContain('deploy-en');
    const englishHit = results.find((result) => result.memory.id === 'deploy-en');
    expect(englishHit?.matchReason.some((reason) => reason.startsWith('match:alternate:'))).toBe(true);

    database.close();
    await fixture.cleanup();
  });

  it('returns stable search, timeline, and why data with controlled FTS input', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(`${fixture.path}/taga.db`);
    const provider = new FtsRetrievalProvider(database);
    provider.upsert(createMemory('memory-1', { kind: 'global' }), 'retry controlled content');

    expect(provider.search({ query: 'retry OR *', limit: 1 })).toHaveLength(1);
    expect(provider.get('memory-1')?.id).toBe('memory-1');
    expect(provider.timeline('memory-1')).toEqual([
      { memoryId: 'memory-1', event: 'indexed', occurredAt: '2026-11-10T00:00:00.000Z' },
    ]);
    expect(provider.why('memory-1', 'retry')).toContain('status:active');

    database.close();
    await fixture.cleanup();
  });

  it('rebuilds and searches a 10,000-memory fixture', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(`${fixture.path}/taga.db`);
    const provider = new FtsRetrievalProvider(database);
    const entries = Array.from({ length: 10_000 }, (_, index) => ({
      memory: createMemory(`memory-${index}`, { kind: 'global' }),
      body: `retry fixture ${index}`,
    }));

    provider.rebuild(entries);

    expect(provider.search({ query: 'retry', limit: 10 })).toHaveLength(10);
    database.close();
    await fixture.cleanup();
  });
});
describe('offline lexical retrieval upgrades', () => {
  it('keeps exact multi-term matches ahead of relaxed candidates', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(`${fixture.path}/taga.db`);
    const provider = new FtsRetrievalProvider(database);
    provider.upsert({ ...createMemory('exact', { kind: 'global' }), title: 'SQLite migration rollback' }, 'rollback the SQLite migration safely');
    provider.upsert({ ...createMemory('partial', { kind: 'global' }), title: 'Migration notes' }, 'rollback guidance');

    const results = provider.search({ query: 'SQLite rollback', limit: 10 });
    expect(results.map((result) => result.memory.id)).toEqual(['exact', 'partial']);
    expect(results[0]?.matchReason).toContain('match:strict');

    database.close();
    await fixture.cleanup();
  });

  it('uses aliases and trigram fallback without requiring a model', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(`${fixture.path}/taga.db`);
    const provider = new FtsRetrievalProvider(database);
    provider.upsert({ ...createMemory('permission', { kind: 'global' }), title: 'Permission denied' }, 'Access denied while opening the file');
    provider.upsert({ ...createMemory('retry', { kind: 'global' }), title: 'Retry policy' }, 'Retry transient failures');

    const alias = provider.search({ query: 'access denied', limit: 5 });
    expect(alias.map((result) => result.memory.id)).toContain('permission');
    expect(alias.find((result) => result.memory.id === 'permission')?.matchReason).toContain('match:alias');

    const typo = provider.search({ query: 'retriy', limit: 5 });
    expect(typo[0]?.memory.id).toBe('retry');
    expect(typo[0]?.matchReason).toContain('match:trigram');

    database.close();
    await fixture.cleanup();
  });

  it('prioritizes structured paths and preference/time hints', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(`${fixture.path}/taga.db`);
    const provider = new FtsRetrievalProvider(database);
    provider.upsert({
      ...createMemory('procedure', { kind: 'global' }),
      type: 'procedures',
      title: 'Migration procedure',
      updated: '2026-11-12T00:00:00.000Z',
      sources: [{ kind: 'file', locator: 'packages/retrieval/src/fts.ts' }],
    }, 'Run the migration procedure');
    provider.upsert({
      ...createMemory('preference', { kind: 'global' }),
      type: 'preferences',
      title: 'Default migration preference',
      updated: '2026-11-12T00:00:00.000Z',
    }, 'Always prefer the local migration path');

    const identifier = provider.search({ query: 'packages/retrieval/src/fts.ts', limit: 5 });
    expect(identifier[0]?.memory.id).toBe('procedure');
    expect(identifier[0]?.matchReason).toContain('match:identifier');

    const preference = provider.search({ query: 'default migration recent', now: '2026-11-12T12:00:00.000Z', limit: 5 });
    expect(preference[0]?.memory.id).toBe('preference');
    expect(preference[0]?.matchReason).toContain('type:match');
    expect(preference[0]?.matchReason).toContain('time:match');

    database.close();
    await fixture.cleanup();
  });
});
  it('reports offline retrieval quality metrics', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(`${fixture.path}/taga.db`);
    const provider = new FtsRetrievalProvider(database);
    provider.upsert({ ...createMemory('metric-memory', { kind: 'global' }), title: 'SQLite migration guide' }, 'Use the migration guide');

    const report = evaluateOfflineRetrieval(provider, [{ query: 'SQLite migration', relevantIds: ['metric-memory'] }]);
    expect(report).toMatchObject({ queries: 1, recallAt5: 1, recallAt10: 1, precisionAt5: 1, mrr: 1, ndcgAt10: 1, zeroResultRate: 0 });
    expect(report.averageLatencyMs).toBeGreaterThanOrEqual(0);

    database.close();
    await fixture.cleanup();
  });