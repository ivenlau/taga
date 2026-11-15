import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { runCli } from '../apps/cli/src/index.js';
import {
  enqueueScheduledReflectScan,
  reflectConfigFromEnv,
  runLearnWatch,
  runReflect,
  type LearnOptions,
  type ReflectConfig,
} from '../packages/learning/src/index.js';
import { DatabaseCandidateRepository } from '../packages/distillation/src/index.js';
import { DatabaseStore, writeMarkdownDocument, contentHash } from '../packages/storage/src/index.js';
import { InMemoryAuditLog, type LlmConfig as AppLlmConfig } from '../packages/application/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';
import type { StructuredCompletionProvider } from '../packages/distillation/src/index.js';

const DETERMINISTIC_LLM: AppLlmConfig = { mode: 'off', endpoint: '', model: '', timeoutMs: 1_000, providerName: 'test' };

function learnOptions(brainPath: string, overrides: Partial<LearnOptions> = {}): LearnOptions {
  return { brainPath, llm: DETERMINISTIC_LLM, ...overrides };
}

function reflectOptions(brainPath: string, config: Partial<ReflectConfig>, audit?: InMemoryAuditLog) {
  const provider: StructuredCompletionProvider = {
    complete: () => Promise.resolve({ text: JSON.stringify({
      memoryType: 'lessons',
      title: 'Retry discipline is the shared theme of these lessons',
      summary: 'All recent lessons converge on bounded, verified retries over transient failures.',
      body: 'Prefer bounded exponential backoff with test verification; never retry without a cap.',
      confidence: 0.9,
      facts: [],
      entities: [],
      temporalFacts: [],
      causalLinks: [],
      applicability: { conditions: [], exclusions: [] },
    }), inputTokens: 300, outputTokens: 180, latencyMs: 40 }),
  };
  return {
    brainPath,
    audit,
    provider,
    llm: { mode: 'on', endpoint: 'http://fixture', model: 'fixture-model', timeoutMs: 1_000, providerName: 'fixture-llm' },
    config: { mode: 'on', intervalMs: 604_800_000, windowDays: 7, minGroupSize: 3, maxGroups: 5, ...config },
    clock: () => new Date('2026-11-15T00:00:00.000Z'),
  };
}

async function seedLessons(brain: string, count: number, updatedAt = '2026-11-14T12:00:00.000Z'): Promise<readonly string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `mem-reflect-${index}`;
    ids.push(id);
    await writeMarkdownDocument(join(brain, 'lessons', 'global', `${id}.md`), {
      schemaVersion: 1,
      id,
      type: 'lessons',
      scope: { kind: 'global' },
      projectId: null,
      status: 'active',
      title: `Lesson ${index}: bound retries before shipping`,
      summary: `Lesson ${index} summary about bounded retries.`,
      confidence: 0.9,
      sourceTrust: 'user_authored',
      visibility: 'private',
      created: updatedAt,
      updated: updatedAt,
      lastVerified: null,
      lastRecalled: null,
      reviewCount: 0,
      usefulCount: 1,
      notUsefulCount: 0,
      expiresAt: null,
      contentHash: contentHash(`lesson ${index}`),
      sources: [{ kind: 'test', locator: 'learning-phase3.test.ts' }],
      anchors: [],
      tags: [],
      supersedes: null,
    }, `Lesson ${index} body.`);
  }
  return ids;
}

describe('runReflect', () => {
  it('creates an insight candidate for a qualifying memory group', async () => {
    const fixture = await createTemporaryDirectory();
    const brain = fixture.path;
    await seedLessons(brain, 4);
    const audit = new InMemoryAuditLog();
    const report = await runReflect({}, reflectOptions(brain, {}, audit));
    try {
      expect(report.mode).toBe('on');
      expect(report.groupsConsidered).toBe(1);
      expect(report.groupsReflected).toBe(1);
      expect(report.candidates).toBe(1);
      const database = new DatabaseStore(join(brain, 'taga.db'));
      try {
        const stored = new DatabaseCandidateRepository(database).list();
        expect(stored.some((candidate) => candidate.title.includes('Retry discipline'))).toBe(true);
        expect(stored.some((candidate) => candidate.memoryType === 'lessons')).toBe(true);
      } finally {
        database.close();
      }
      const events = await audit.list();
      expect(events.some((event) => event.eventType === 'reflect.completed')).toBe(true);
      expect(events.some((event) => event.eventType === 'reflect.group')).toBe(true);
      await fixture.cleanup();
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it('skips groups below the minimum size', async () => {
    const fixture = await createTemporaryDirectory();
    await seedLessons(fixture.path, 2);
    const report = await runReflect({}, reflectOptions(fixture.path, { minGroupSize: 3 }));
    try {
      expect(report.groupsConsidered).toBe(0);
      expect(report.candidates).toBe(0);
      await fixture.cleanup();
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it('honors project filters', async () => {
    const fixture = await createTemporaryDirectory();
    await seedLessons(fixture.path, 4);
    const report = await runReflect({ project: 'project-other' }, reflectOptions(fixture.path, {}));
    try {
      expect(report.groupsConsidered).toBe(0);
      await fixture.cleanup();
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it('reports disabled mode and missing llm', async () => {
    const fixture = await createTemporaryDirectory();
    await seedLessons(fixture.path, 4);
    const off = await runReflect({}, reflectOptions(fixture.path, { mode: 'off' }));
    expect(off.mode).toBe('off');
    expect(off.errors.join(' ')).toContain('disabled');
    const noLlm = await runReflect({}, { ...reflectOptions(fixture.path, {}), llm: DETERMINISTIC_LLM, provider: undefined });
    expect(noLlm.errors.join(' ')).toContain('requires the LLM adapter');
    await fixture.cleanup();
  }, 30_000);

  it('skips stale memories outside the reflection window', async () => {
    const fixture = await createTemporaryDirectory();
    await seedLessons(fixture.path, 4, '2026-01-01T00:00:00.000Z');
    const report = await runReflect({}, reflectOptions(fixture.path, { windowDays: 7 }));
    try {
      expect(report.groupsConsidered).toBe(0);
      await fixture.cleanup();
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);
});

describe('reflect scheduling', () => {
  it('gates scheduled scans on mode and dedupes within the interval', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(join(fixture.path, 'taga.db'));
    const now = new Date('2026-11-15T00:00:00.000Z');
    try {
      expect(enqueueScheduledReflectScan(database, reflectConfigFromEnv({ TAGA_REFLECT_MODE: 'off' }), now)).toBe(false);
      const on: ReflectConfig = reflectConfigFromEnv({ TAGA_REFLECT_MODE: 'on', TAGA_REFLECT_INTERVAL_MS: `${7 * 24 * 60 * 60 * 1000}` });
      expect(on.mode).toBe('on');
      expect(on.intervalMs).toBe(7 * 24 * 60 * 60 * 1000);
      expect(enqueueScheduledReflectScan(database, on, now)).toBe(true);
      expect(enqueueScheduledReflectScan(database, on, new Date(now.getTime() + 1000))).toBe(false);
      expect(enqueueScheduledReflectScan(database, on, new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000))).toBe(true);
      database.close();
      await fixture.cleanup();
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('learn watch', () => {
  it('learns new files once, skips unchanged, and relearns modifications', async () => {
    const fixture = await createTemporaryDirectory();
    const docs = join(fixture.path, 'docs');
    await mkdir(docs, { recursive: true });
    const note = join(docs, 'note.md');
    await writeFile(note, 'Watch learning probe content round one.', 'utf8');
    try {
      const first = await runLearnWatch({ dir: docs, type: 'environment' }, { ...learnOptions(fixture.path), maxCycles: 1, intervalMs: 1 });
      expect(first).toHaveLength(1);
      expect(first[0]?.blocks).toBe(1);
      expect(first[0]?.candidates).toBeGreaterThanOrEqual(1);

      const second = await runLearnWatch({ dir: docs, type: 'environment' }, { ...learnOptions(fixture.path), maxCycles: 1, intervalMs: 1 });
      expect(second).toHaveLength(0);

      await writeFile(note, 'Watch learning probe content round two with new facts.', 'utf8');
      const third = await runLearnWatch({ dir: docs, type: 'environment' }, { ...learnOptions(fixture.path), maxCycles: 1, intervalMs: 1 });
      expect(third).toHaveLength(1);
      expect(third[0]?.blocks).toBe(1);

      await fixture.cleanup();
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it('exposes watch through the CLI and aggregates cycle reports', async () => {
    const fixture = await createTemporaryDirectory();
    const docs = join(fixture.path, 'docs');
    await mkdir(docs, { recursive: true });
    await writeFile(join(docs, 'cli-watch.md'), 'CLI watch probe content.', 'utf8');
    const streams = { stdout: process.stdout, stderr: process.stderr } as const;
    const previousMode = process.env.TAGA_LLM_MODE;
    process.env.TAGA_LLM_MODE = 'off';
    try {
      const code = await runCli(['learn', '--watch', '--dir=' + docs, '--interval-ms=1', '--max-cycles=1', '--json', `--brain=${join(fixture.path, 'brain')}`], { cwd: fixture.path, streams });
      expect(code).toBe(0);
    } finally {
      if (previousMode === undefined) delete process.env.TAGA_LLM_MODE;
      else process.env.TAGA_LLM_MODE = previousMode;
      await fixture.cleanup();
    }
  }, 30_000);
});
