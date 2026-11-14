import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { LiteMcpServer } from '../apps/mcp/src/index.js';
import { runConsolidationScan } from '../apps/daemon/src/consolidation.js';
import { LlmMergeJudge } from '../apps/daemon/src/consolidation-llm.js';
import {
  contentHash,
  DatabaseStore,
  MarkdownMemoryRepository,
  writeMarkdownDocument,
} from '../packages/storage/src/index.js';
import { FtsRetrievalProvider } from '../packages/retrieval/src/index.js';
import {
  DEFAULT_PROACTIVE_POLICY,
  SqliteAuditLog,
  evaluateProactivePolicy,
  enqueueConsolidationScan,
} from '../packages/application/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';
import type { Memory } from '../packages/domain/src/index.js';
import type { StructuredCompletionProvider } from '../packages/distillation/src/index.js';

let memoryCounter = 0;

function memory(overrides: Partial<Memory> = {}): Memory {
  memoryCounter += 1;
  const id = overrides.id ?? `mem-consolidation-${memoryCounter}`;
  const timestamp = '2026-11-14T00:00:00.000Z';
  return {
    schemaVersion: 1,
    id,
    type: 'lessons',
    scope: { kind: 'global' },
    projectId: null,
    status: 'draft',
    title: `Consolidation fixture ${memoryCounter}`,
    summary: 'Retry transient failures with a bounded delay.',
    confidence: 0.5,
    sourceTrust: 'observed',
    visibility: 'private',
    created: timestamp,
    updated: timestamp,
    lastVerified: null,
    lastRecalled: null,
    reviewCount: 0,
    usefulCount: 0,
    notUsefulCount: 0,
    expiresAt: null,
    contentHash: contentHash('retry body'),
    sources: [{ kind: 'test', locator: 'consolidation.test.ts' }],
    anchors: [],
    tags: ['retry'],
    supersedes: null,
    ...overrides,
  };
}

async function setup(items: readonly Memory[]): Promise<{ fixture: Awaited<ReturnType<typeof createTemporaryDirectory>>; database: DatabaseStore }> {
  const fixture = await createTemporaryDirectory();
  const database = new DatabaseStore(join(fixture.path, 'taga.db'));
  const provider = new FtsRetrievalProvider(database);
  for (const item of items) {
    await writeMarkdownDocument(join(fixture.path, 'lessons', 'global', `${item.id}.md`), item, 'retry body');
    provider.upsert(item, 'retry body');
  }
  return { fixture, database };
}

const ENV_KEYS = ['TAGA_CONSOLIDATION_MODE', 'TAGA_AUTO_PROMOTE_USEFUL_COUNT', 'TAGA_AUTO_PROMOTE_MAX_NOT_USEFUL'] as const;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: (typeof ENV_KEYS)[number], value: string | undefined): void {
  savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete savedEnv[key];
  }
}

describe('draft soft recall', () => {
  it('excludes drafts by default and recalls them with the unverified marker when requested', async () => {
    const active = memory({ id: 'mem-active-retry', status: 'active', sourceTrust: 'user_authored', confidence: 0.9 });
    const draft = memory({ id: 'mem-draft-retry', status: 'draft' });
    const { fixture, database } = await setup([active, draft]);
    try {
      const provider = new FtsRetrievalProvider(database);
      const withoutDrafts = provider.search({ query: 'retry' });
      expect(withoutDrafts.map((item) => item.memory.id)).toEqual(['mem-active-retry']);
      const withDrafts = provider.search({ query: 'retry', includeDraft: true });
      const draftItem = withDrafts.find((item) => item.memory.id === 'mem-draft-retry');
      expect(draftItem).toBeDefined();
      expect(draftItem?.matchReason).toContain('status:draft:unverified');
      expect(draftItem?.matchReason).not.toContain('status:active');
      const activeItem = withDrafts.find((item) => item.memory.id === 'mem-active-retry');
      expect(activeItem?.matchReason).toContain('status:active');
      expect((draftItem?.score ?? 0)).toBeLessThan(activeItem?.score ?? 0);
    } finally {
      database.close();
      await fixture.cleanup();
    }
  });

  it('keeps drafts out of hybrid recall unless includeDraft is set', async () => {
    const active = memory({ id: 'mem-active-hybrid', status: 'active', sourceTrust: 'user_authored', confidence: 0.9 });
    const draft = memory({ id: 'mem-draft-hybrid', status: 'draft' });
    const { fixture, database } = await setup([active, draft]);
    try {
      const provider = new FtsRetrievalProvider(database);
      const plain = await provider.searchHybrid({ query: 'retry', limit: 5 }, undefined);
      expect(plain.items.map((item) => item.memory.id)).toEqual(['mem-active-hybrid']);
      const withDrafts = await provider.searchHybrid({ query: 'retry', limit: 5, includeDraft: true }, undefined);
      expect(withDrafts.items.some((item) => item.memory.id === 'mem-draft-hybrid')).toBe(true);
    } finally {
      database.close();
      await fixture.cleanup();
    }
  });

  it('surfaces draft results through MCP memory_search only with include_draft', async () => {
    const active = memory({ id: 'mem-active-mcp', status: 'active', sourceTrust: 'user_authored', confidence: 0.9 });
    const draft = memory({ id: 'mem-draft-mcp', status: 'draft', usefulCount: 3 });
    const { fixture, database } = await setup([active, draft]);
    try {
      const server = new LiteMcpServer(fixture.path);
      const plain = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'retry', k: 5 } } });
      const plainData = (plain.result as { structuredContent: { data: { results: ReadonlyArray<{ id: string }> } } }).structuredContent.data;
      expect(plainData.results.map((item) => item.id)).toEqual(['mem-active-mcp']);
      const withDrafts = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'retry', k: 5, include_draft: true } } });
      const draftData = (withDrafts.result as { structuredContent: { data: { results: ReadonlyArray<{ id: string; match_reason: readonly string[]; proof: { useful_count: number } }> } } }).structuredContent.data;
      const draftResult = draftData.results.find((item) => item.id === 'mem-draft-mcp');
      expect(draftResult).toBeDefined();
      expect(draftResult?.match_reason).toContain('status:draft:unverified');
      expect(draftResult?.proof.useful_count).toBe(3);
    } finally {
      database.close();
      await fixture.cleanup();
    }
  });
});

describe('proof signals', () => {
  it('annotates useful and verified proof in match reasons', async () => {
    const proven = memory({ id: 'mem-proof', status: 'active', sourceTrust: 'user_authored', usefulCount: 2, lastVerified: '2026-11-13T00:00:00.000Z' });
    const plain = memory({ id: 'mem-no-proof', status: 'active', sourceTrust: 'user_authored' });
    const { fixture, database } = await setup([proven, plain]);
    try {
      const provider = new FtsRetrievalProvider(database);
      const reasons = provider.search({ query: 'retry' }).find((item) => item.memory.id === 'mem-proof')?.matchReason ?? [];
      expect(reasons).toContain('proof:useful:2');
      expect(reasons).toContain('proof:verified');
      const plainReasons = provider.search({ query: 'retry' }).find((item) => item.memory.id === 'mem-no-proof')?.matchReason ?? [];
      expect(plainReasons.some((reason) => reason.startsWith('proof:'))).toBe(false);
    } finally {
      database.close();
      await fixture.cleanup();
    }
  });
});

describe('feedback activation policy', () => {
  it('activates on sufficient useful feedback with a clean dedup verdict', () => {
    const decision = evaluateProactivePolicy(
      { action: 'activate', subjectType: 'memory', subjectId: 'mem-1', memoryType: 'lessons', usefulCount: 2, dedupVerdict: 'novel' },
      { ...DEFAULT_PROACTIVE_POLICY, autoActivateFeedback: true },
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('feedback-auto-activation-allowed');
  });

  it('blocks flagged duplicates and insufficient feedback', () => {
    const flagged = evaluateProactivePolicy(
      { action: 'activate', subjectType: 'memory', subjectId: 'mem-1', memoryType: 'lessons', usefulCount: 5, dedupVerdict: 'duplicate' },
      { ...DEFAULT_PROACTIVE_POLICY, autoActivateFeedback: true },
    );
    expect(flagged.allowed).toBe(false);
    expect(flagged.reason).toBe('dedup-flagged-requires-review');
    const insufficient = evaluateProactivePolicy(
      { action: 'activate', subjectType: 'memory', subjectId: 'mem-1', memoryType: 'lessons', usefulCount: 1, dedupVerdict: 'novel' },
      { ...DEFAULT_PROACTIVE_POLICY, autoActivateFeedback: true },
    );
    expect(insufficient.allowed).toBe(false);
    expect(insufficient.reason).toBe('activation-eligibility-not-met');
    expect(evaluateProactivePolicy(
      { action: 'activate', subjectType: 'memory', subjectId: 'mem-1', memoryType: 'lessons', usefulCount: 5, dedupVerdict: 'novel' },
      DEFAULT_PROACTIVE_POLICY,
    ).allowed).toBe(false);
  });
});

describe('consolidation scan', () => {
  it('promotes drafts with enough useful feedback and records daemon audit', async () => {
    setEnv('TAGA_CONSOLIDATION_MODE', 'on');
    const draft = memory({ id: 'mem-promote', status: 'draft', usefulCount: 2 });
    const { fixture, database } = await setup([draft]);
    try {
      await runConsolidationScan(fixture.path, database);
      const repository = new MarkdownMemoryRepository(fixture.path);
      const updated = await repository.get('mem-promote');
      expect(updated?.status).toBe('active');
      const provider = new FtsRetrievalProvider(database);
      expect(provider.get('mem-promote')?.status).toBe('active');
      const audit = await new SqliteAuditLog(database).list();
      expect(audit.some((event) => event.eventType === 'memory.activate' && event.actor === 'daemon')).toBe(true);
    } finally {
      restoreEnv();
      database.close();
      await fixture.cleanup();
    }
  }, 20_000);

  it('keeps duplicates as drafts and files a garden proposal', async () => {
    setEnv('TAGA_CONSOLIDATION_MODE', 'on');
    const draft = memory({ id: 'mem-duplicate', status: 'draft', usefulCount: 4 });
    const existing = memory({ id: 'mem-existing', status: 'active', sourceTrust: 'user_authored' });
    const { fixture, database } = await setup([draft, existing]);
    database.upsertMetadata(`consolidation:dedup:${draft.id}:${draft.contentHash}`, JSON.stringify({
      schemaVersion: 1,
      memoryId: draft.id,
      contentHash: draft.contentHash,
      verdict: 'duplicate',
      bestMatchId: existing.id,
      score: 0.97,
      at: '2026-11-14T00:00:00.000Z',
    }));
    try {
      await runConsolidationScan(fixture.path, database);
      const repository = new MarkdownMemoryRepository(fixture.path);
      expect((await repository.get('mem-duplicate'))?.status).toBe('draft');
      const proposals = database.listMetadata('garden:proposal:').map((entry) => JSON.parse(entry.value) as { category?: string });
      expect(proposals.length).toBeGreaterThanOrEqual(1);
      expect(proposals.some((item) => item.category === 'duplicate')).toBe(true);
    } finally {
      restoreEnv();
      database.close();
      await fixture.cleanup();
    }
  }, 20_000);

  it('does nothing when consolidation is disabled', async () => {
    setEnv('TAGA_CONSOLIDATION_MODE', undefined);
    const draft = memory({ id: 'mem-disabled', status: 'draft', usefulCount: 9 });
    const { fixture, database } = await setup([draft]);
    try {
      await runConsolidationScan(fixture.path, database);
      const repository = new MarkdownMemoryRepository(fixture.path);
      expect((await repository.get('mem-disabled'))?.status).toBe('draft');
    } finally {
      restoreEnv();
      database.close();
      await fixture.cleanup();
    }
  }, 20_000);
});

describe('enqueueConsolidationScan', () => {
  it('dedupes scans within the same bucket', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(join(fixture.path, 'taga.db'));
    try {
      const now = new Date('2026-11-14T12:00:00.000Z');
      expect(enqueueConsolidationScan(database, { now })).toBe(true);
      expect(enqueueConsolidationScan(database, { now })).toBe(false);
      const later = new Date(now.getTime() + 120_000);
      expect(enqueueConsolidationScan(database, { now: later })).toBe(true);
    } finally {
      database.close();
      await fixture.cleanup();
    }
  });
});

describe('LlmMergeJudge', () => {
  const input = { draftTitle: 'Draft', draftBody: 'draft text', existingTitle: 'Existing', existingBody: 'existing text' };

  it('parses keep and merge decisions', async () => {
    const provider: StructuredCompletionProvider = {
      complete: () => Promise.resolve(({ text: '{"action":"keep","reason":"draft adds new facts"}', latencyMs: 1 })),
    };
    const judge = new LlmMergeJudge(provider, 'test-model', 100);
    const decision = await judge.judge(input);
    expect(decision.action).toBe('keep');
    expect(decision.reason).toBe('draft adds new facts');
  });

  it('captures merged text on merge verdicts', async () => {
    const provider: StructuredCompletionProvider = {
      complete: () => Promise.resolve(({ text: '{"action":"merge","reason":"same fact","merged_text":"combined text"}', latencyMs: 1 })),
    };
    const judge = new LlmMergeJudge(provider, 'test-model', 100);
    const decision = await judge.judge(input);
    expect(decision.action).toBe('merge');
    expect(decision.mergedText).toBe('combined text');
  });

  it('tolerates markdown fences and rejects non-JSON output', async () => {
    const fenced: StructuredCompletionProvider = {
      complete: () => Promise.resolve(({ text: '```json\n{"action":"keep","reason":"ok"}\n```', latencyMs: 1 })),
    };
    expect((await new LlmMergeJudge(fenced, 'm', 100).judge(input)).action).toBe('keep');
    const garbage: StructuredCompletionProvider = { complete: () => Promise.resolve({ text: 'not json', latencyMs: 1 }) };
    await expect(new LlmMergeJudge(garbage, 'm', 100).judge(input)).rejects.toThrow();
  });
});
