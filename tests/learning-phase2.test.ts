import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { runCli } from '../apps/cli/src/index.js';
import {
  enqueueLearnCorrection,
  runCorrectionLearn,
  runLearn,
  type LearnOptions,
} from '../packages/learning/src/index.js';
import {
  withDailyCap,
  withLlmBudget,
  buildDistillerChain,
  DatabaseCandidateRepository,
  metadataLlmBudgetState,
  type DistillationInput,
  type LlmBudgetUsage,
  type StructuredCompletionProvider,
} from '../packages/distillation/src/index.js';
import { MetricsService } from '../packages/metrics/src/index.js';
import { DatabaseStore, writeMarkdownDocument, contentHash } from '../packages/storage/src/index.js';
import { normalizeEvidence } from '../packages/redaction/src/index.js';
import { InMemoryAuditLog, SqliteAuditLog, type LlmConfig as AppLlmConfig } from '../packages/application/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';

const DETERMINISTIC_LLM: AppLlmConfig = { mode: 'off', endpoint: '', model: '', timeoutMs: 1_000, providerName: 'test' };

function learnOptions(brainPath: string, overrides: Partial<LearnOptions> = {}): LearnOptions {
  return { brainPath, llm: DETERMINISTIC_LLM, ...overrides };
}

function llmChain(audit: InMemoryAuditLog, overrides: Partial<AppLlmConfig> = {}): { llm: AppLlmConfig; audit: InMemoryAuditLog } {
  return {
    audit,
    llm: { mode: 'on', endpoint: 'http://fixture', model: 'fixture-model', timeoutMs: 1_000, providerName: 'fixture-llm', ...overrides },
  };
}

function draftOutput(evidenceId = 'evidence-phase2'): string {
  return JSON.stringify({
    memoryType: 'lessons',
    title: 'Bounded retries fix transient failures',
    summary: 'Use bounded retries for transient network failures.',
    body: 'Bound retries and verify the outcome with tests.',
    confidence: 0.92,
    facts: [{ text: 'Bounded retries fix transient network failures.', evidenceIds: [evidenceId], confidence: 0.9 }],
    entities: [],
    temporalFacts: [],
    causalLinks: [],
    applicability: { conditions: [], exclusions: [] },
  });
}

const input: DistillationInput = {
  observation: {
    id: 'observation-phase2',
    evidenceIds: ['evidence-phase2'],
    projectId: 'project-phase2',
    sessionId: 'session-phase2',
    kind: 'problem',
    summary: 'Bounded retries fixed the transient network test failure',
    novelty: 0.8,
    reuse: 0.8,
    evidenceQuality: 0.9,
    sensitivityRisk: 0,
    createdAt: '2026-11-14T00:00:00.000Z',
  },
  evidence: [normalizeEvidence({
    id: 'evidence-phase2',
    source: 'watcher',
    projectId: 'project-phase2',
    sessionId: 'session-phase2',
    raw: 'Use bounded retries; tests passed.',
    occurredAt: '2026-11-14T00:00:00.000Z',
    capturedAt: '2026-11-14T00:00:00.000Z',
    refs: [{ kind: 'test', locator: 'pnpm test' }],
  }).event],
  verified: true,
};

describe('withDailyCap', () => {
  it('rejects calls beyond the cap and resets on date rollover', async () => {
    let now = Date.parse('2026-11-14T10:00:00.000Z');
    const clock = (): Date => new Date(now);
    const inner: StructuredCompletionProvider = {
      complete: () => Promise.resolve({ text: '{"ok":true}', latencyMs: 1 }),
    };
    const capped = withDailyCap(inner, 2, clock);
    await capped.complete({ system: 's', user: 'u', model: 'm', timeoutMs: 100 });
    await capped.complete({ system: 's', user: 'u', model: 'm', timeoutMs: 100 });
    await expect(capped.complete({ system: 's', user: 'u', model: 'm', timeoutMs: 100 })).rejects.toThrow('llm daily cap reached (2 calls on 2026-11-14)');
    now = Date.parse('2026-11-15T10:00:00.000Z');
    const response = await capped.complete({ system: 's', user: 'u', model: 'm', timeoutMs: 100 });
    expect(response.text).toBe('{"ok":true}');
  });

  it('shares the daily cap across wrapper instances through persisted state', async () => {
    const now = Date.parse('2026-11-14T10:00:00.000Z');
    const clock = (): Date => new Date(now);
    const counts = new Map<string, number>();
    const state = {
      load: (day: string): number => counts.get(day) ?? 0,
      save: (day: string, count: number): void => { counts.set(day, count); },
    };
    const inner: StructuredCompletionProvider = {
      complete: () => Promise.resolve({ text: '{"ok":true}', latencyMs: 1 }),
    };
    await withDailyCap(inner, 2, clock, state).complete({ system: 's', user: 'u', model: 'm', timeoutMs: 100 });
    await withDailyCap(inner, 2, clock, state).complete({ system: 's', user: 'u', model: 'm', timeoutMs: 100 });
    await expect(withDailyCap(inner, 2, clock, state).complete({ system: 's', user: 'u', model: 'm', timeoutMs: 100 })).rejects.toThrow('llm daily cap reached (2 calls on 2026-11-14)');
  });
});

describe('daily cap in distiller chain', () => {
  it('falls back to deterministic once the cap is exhausted, with audit', async () => {
    const audit = new InMemoryAuditLog();
    const provider: StructuredCompletionProvider = {
      complete: () => Promise.resolve({ text: draftOutput(), latencyMs: 1 }),
    };
    const chain = buildDistillerChain({ ...llmChain(audit, { dailyCap: 1 }), provider });
    const first = await chain.distill(input);
    expect(first.model?.mode).toBe('llm');
    const second = await chain.distill(input);
    expect(second.model?.mode).toBe('deterministic');
    expect(second.model?.fallbackReason).toContain('llm daily cap reached');
    const events = await audit.list();
    expect(events.some((event) => event.eventType === 'distill.llm_fallback' && event.reason.includes('llm daily cap reached'))).toBe(true);
  });

  it('keeps the cap across buildDistillerChain instances via budgetState', async () => {
    const audit = new InMemoryAuditLog();
    const provider: StructuredCompletionProvider = {
      complete: () => Promise.resolve({ text: draftOutput(), latencyMs: 1 }),
    };
    const store = new Map<string, LlmBudgetUsage>();
    const budgetState = {
      load: (day: string): LlmBudgetUsage | null => store.get(day) ?? null,
      save: (day: string, usage: LlmBudgetUsage): void => { store.set(day, usage); },
    };
    const first = buildDistillerChain({ ...llmChain(audit, { dailyCap: 2 }), provider, budgetState });
    const firstResult = await first.distill(input);
    expect(firstResult.model?.mode).toBe('llm');
    await first.distill(input);
    const second = buildDistillerChain({ ...llmChain(audit, { dailyCap: 2 }), provider, budgetState });
    const secondResult = await second.distill(input);
    expect(secondResult.model?.mode).toBe('deterministic');
    expect(secondResult.model?.fallbackReason).toContain('llm daily cap reached');
  });
});

describe('shadow audit token accounting', () => {
  it('records shadow tokens and latency in the comparison audit event', async () => {
    const audit = new InMemoryAuditLog();
    const provider: StructuredCompletionProvider = {
      complete: () => Promise.resolve({ text: draftOutput(), inputTokens: 42, outputTokens: 512, latencyMs: 123 }),
    };
    const chain = buildDistillerChain({ ...llmChain(audit, { mode: 'shadow' }), provider });
    await chain.distill(input);
    const events = await audit.list();
    const shadow = events.find((event) => event.eventType === 'distill.llm_shadow');
    expect(shadow).toBeDefined();
    expect(shadow?.payload).toMatchObject({ shadowInputTokens: 42, shadowOutputTokens: 512, shadowLatencyMs: 123 });
  });
});

describe('correction learning', () => {
  it('distills a lessons candidate from a conflict correction note', async () => {
    const fixture = await createTemporaryDirectory();
    const brain = fixture.path;
    const item = {
      schemaVersion: 1,
      id: 'mem-conflict-fix',
      type: 'lessons',
      scope: { kind: 'global' },
      projectId: null,
      status: 'active',
      title: 'Always retry immediately without delay',
      summary: 'Retry transient failures immediately.',
      confidence: 0.9,
      sourceTrust: 'user_authored',
      visibility: 'private',
      created: '2026-11-14T00:00:00.000Z',
      updated: '2026-11-14T00:00:00.000Z',
      lastVerified: null,
      lastRecalled: null,
      reviewCount: 0,
      usefulCount: 0,
      notUsefulCount: 0,
      expiresAt: null,
      contentHash: contentHash('retry body'),
      sources: [{ kind: 'test', locator: 'learning-phase2.test.ts' }],
      anchors: [],
      tags: [],
      supersedes: null,
    };
    await writeMarkdownDocument(join(brain, 'lessons', 'global', `${item.id}.md`), item, 'Retry transient failures immediately.');
    const audit = new InMemoryAuditLog();
    const report = await runCorrectionLearn(
      { memoryId: item.id, note: 'immediate retry caused a storm; must use bounded exponential backoff', project: 'project-1' },
      learnOptions(brain, { audit }),
    );
    expect(report.candidates).toBe(1);
    const database = new DatabaseStore(join(brain, 'taga.db'));
    try {
      const stored = new DatabaseCandidateRepository(database).list();
      expect(stored.length).toBeGreaterThanOrEqual(1);
      expect(stored.some((candidate) => candidate.title.includes('冲突记忆标题'))).toBe(true);
    } finally {
      database.close();
    }
    const events = await audit.list();
    expect(events.some((event) => event.eventType === 'learn.completed')).toBe(true);
    await fixture.cleanup();
  }, 30_000);

  it('throws for a missing memory', async () => {
    const fixture = await createTemporaryDirectory();
    await expect(runCorrectionLearn({ memoryId: 'mem-missing' }, learnOptions(fixture.path))).rejects.toThrow('memory not found');
    await fixture.cleanup();
  }, 30_000);

  it('enqueues at most one correction per memory, note and day', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(join(fixture.path, 'taga.db'));
    try {
      expect(enqueueLearnCorrection(database, { memoryId: 'mem-1', note: 'a' }, () => new Date('2026-11-14T10:00:00.000Z'))).toBe(true);
      expect(enqueueLearnCorrection(database, { memoryId: 'mem-1', note: 'a' }, () => new Date('2026-11-14T11:00:00.000Z'))).toBe(false);
      expect(enqueueLearnCorrection(database, { memoryId: 'mem-1', note: 'b' }, () => new Date('2026-11-14T12:00:00.000Z'))).toBe(true);
      database.close();
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('learning effectiveness in digest', () => {
  it('reports candidate decisions by mode plus learn and llm audit counts', async () => {
    const fixture = await createTemporaryDirectory();
    const brain = fixture.path;
    const auditDatabase = new DatabaseStore(join(brain, 'taga.db'));
    const audit = new SqliteAuditLog(auditDatabase);
    await runLearn({ text: 'Learning effectiveness probe one for digest stats.', type: 'lessons' }, learnOptions(brain, { audit }));
    await runLearn({ text: 'Learning effectiveness probe two for digest stats.', type: 'lessons' }, learnOptions(brain, { audit }));
    const metricsDatabase = new DatabaseStore(join(brain, 'taga.db'));
    const metrics = new MetricsService(metricsDatabase);
    const learning = await metrics.learningEffectiveness({ windowDays: 30 });
    expect(learning.candidates.total).toBeGreaterThanOrEqual(2);
    expect(learning.learnRuns).toBeGreaterThanOrEqual(2);
    const deterministicMode = learning.byMode.find((entry) => entry.mode === 'deterministic');
    expect(deterministicMode?.created).toBeGreaterThanOrEqual(2);
    const digest = await metrics.digest({ windowDays: 30 });
    expect(digest.learning.candidates.total).toBeGreaterThanOrEqual(2);
    metricsDatabase.close();
    auditDatabase.close();
    await fixture.cleanup();
  }, 30_000);

  it('surfaces the learning section through the CLI digest command', async () => {
    const fixture = await createTemporaryDirectory();
    const streams = { stdout: process.stdout, stderr: process.stderr } as const;
    const previousMode = process.env.TAGA_LLM_MODE;
    process.env.TAGA_LLM_MODE = 'off';
    try {
      expect(await runCli(['learn', '--text=Digest CLI verification content for the learning section.', '--json', `--brain=${join(fixture.path, 'brain')}`], { cwd: fixture.path, streams })).toBe(0);
      expect(await runCli(['digest', 'refresh', '--json', `--brain=${join(fixture.path, 'brain')}`], { cwd: fixture.path, streams })).toBe(0);
      expect(await runCli(['digest', 'show', '--json', `--brain=${join(fixture.path, 'brain')}`], { cwd: fixture.path, streams })).toBe(0);
    } finally {
      if (previousMode === undefined) delete process.env.TAGA_LLM_MODE;
      else process.env.TAGA_LLM_MODE = previousMode;
      await fixture.cleanup();
    }
  }, 30_000);
});

describe('withLlmBudget', () => {
  const request = { system: 's', user: 'u', model: 'm', timeoutMs: 100 };

  function countingProvider(): { provider: StructuredCompletionProvider; requests: typeof request[] } {
    const requests: typeof request[] = [];
    return {
      requests,
      provider: {
        complete: (req: typeof request) => {
          requests.push(req);
          return Promise.resolve({ text: '{"ok":true}', inputTokens: 30, outputTokens: 20, latencyMs: 1 });
        },
      },
    };
  }

  it('rejects once the daily token budget is exhausted and records usage', async () => {
    const { provider, requests } = countingProvider();
    const store = new Map<string, LlmBudgetUsage>();
    const state = {
      load: (day: string): LlmBudgetUsage | null => store.get(day) ?? null,
      save: (day: string, usage: LlmBudgetUsage): void => { store.set(day, usage); },
    };
    const day = new Date().toISOString().slice(0, 10);
    const capped = withLlmBudget(provider, { dailyTokens: 80 }, 'distill', state);
    await capped.complete(request);
    await capped.complete(request);
    expect(store.get(day)).toMatchObject({ calls: 2, tokens: 100 });
    await expect(capped.complete(request)).rejects.toThrow('llm daily token budget reached (80 tokens');
    expect(requests).toHaveLength(2);
  });

  it('isolates consumers by share without blocking other consumers', async () => {
    const { provider } = countingProvider();
    const store = new Map<string, LlmBudgetUsage>();
    const state = {
      load: (day: string): LlmBudgetUsage | null => store.get(day) ?? null,
      save: (day: string, usage: LlmBudgetUsage): void => { store.set(day, usage); },
    };
    const learn = withLlmBudget(provider, { dailyCalls: 4, perConsumerShare: 0.5 }, 'learn', state);
    const distill = withLlmBudget(provider, { dailyCalls: 4, perConsumerShare: 0.5 }, 'distill', state);
    await learn.complete(request);
    await learn.complete(request);
    await expect(learn.complete(request)).rejects.toThrow('llm consumer budget reached (learn');
    await expect(distill.complete(request)).resolves.toBeDefined();
  });

  it('persists usage across wrapper instances through metadata state', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(`${fixture.path}/taga.db`);
    const state = metadataLlmBudgetState(database);
    const { provider } = countingProvider();
    await withLlmBudget(provider, { dailyCalls: 2 }, 'distill', state).complete(request);
    await withLlmBudget(provider, { dailyCalls: 2 }, 'learn', state).complete(request);
    const usage = state.load(new Date().toISOString().slice(0, 10));
    expect(usage?.calls).toBe(2);
    expect(usage?.consumers).toMatchObject({ distill: { calls: 1 }, learn: { calls: 1 } });
    await expect(withLlmBudget(provider, { dailyCalls: 2 }, 'reflect', state).complete(request)).rejects.toThrow('llm daily cap reached (2 calls');
    database.close();
    await fixture.cleanup();
  });
});

describe('learn incremental watermark', () => {
  it('does not resubmit already-learned chunks to the LLM', async () => {
    const fixture = await createTemporaryDirectory();
    const brain = fixture.path;
    const requests: string[] = [];
    const provider: StructuredCompletionProvider = {
      complete: (req) => {
        requests.push(req.user);
        return Promise.resolve({ text: JSON.stringify({ memoryType: 'lessons', title: 'T', summary: 'S', body: 'B', confidence: 0.9 }), latencyMs: 1 });
      },
    };
    const options = { brainPath: brain, llm: { mode: 'on' as const, endpoint: 'http://fixture', model: 'fixture-model', timeoutMs: 1_000, providerName: 'fixture-llm' }, provider };
    const first = await runLearn({ text: 'Watermark probe content; tests passed.', type: 'lessons' }, options);
    expect(first.candidates).toBe(1);
    expect(requests).toHaveLength(1);
    const second = await runLearn({ text: 'Watermark probe content; tests passed.', type: 'lessons' }, options);
    expect(second.candidates).toBe(0);
    expect(second.duplicates).toBe(1);
    expect(requests).toHaveLength(1);
    await fixture.cleanup();
  }, 30_000);
});
