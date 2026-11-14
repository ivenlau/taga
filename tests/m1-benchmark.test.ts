import { describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { DatabaseStore } from '../packages/storage/src/index.js';
import { FtsRetrievalProvider } from '../packages/retrieval/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';
import type { Memory } from '../packages/domain/src/index.js';

function memory(id: string): Memory {
  return {
    schemaVersion: 1, id, type: 'lessons', scope: { kind: 'global' }, projectId: null, status: 'active', title: 'Retry fixture',
    summary: 'Retry transient failures with a bounded delay.', confidence: 0.8, sourceTrust: 'observed', visibility: 'private',
    created: '2026-11-10T00:00:00.000Z', updated: '2026-11-10T00:00:00.000Z', lastVerified: null, lastRecalled: null,
    reviewCount: 0, usefulCount: 0, notUsefulCount: 0, expiresAt: null, contentHash: `sha256:${id}`,
    sources: [{ kind: 'test', locator: 'm1-benchmark.test.ts' }], anchors: [], tags: ['retry'], supersedes: null,
  };
}

describe('M1 performance gate', () => {
  it('rebuilds 10,000 memories and keeps search p95 within the local budget', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(`${fixture.path}/taga.db`);
    const provider = new FtsRetrievalProvider(database);
    const entries = Array.from({ length: 10_000 }, (_, index) => ({ memory: memory(`benchmark-${index}`), body: `retry fixture ${index}` }));
    const rebuildStarted = performance.now();
    provider.rebuild(entries);
    const rebuildMs = performance.now() - rebuildStarted;
    expect(provider.search({ query: 'retry', limit: 10 })).toHaveLength(10);
    const durations = Array.from({ length: 20 }, () => {
      const started = performance.now();
      expect(provider.search({ query: 'retry', limit: 10 })).toHaveLength(10);
      return performance.now() - started;
    }).sort((left, right) => left - right);
    const p95 = durations[Math.ceil(durations.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
    expect(rebuildMs).toBeLessThan(5000);
    expect(p95).toBeLessThan(250);
    database.close();
    await fixture.cleanup();
  });
});
