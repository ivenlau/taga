import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { runCli } from '../apps/cli/src/index.js';
import {
  createSemanticDuplicateChecker,
  runLearn,
  type LearnOptions,
} from '../packages/learning/src/index.js';
import { AutomaticDistillationService, type SemanticDuplicateVerdict } from '../packages/distillation/src/index.js';
import { DatabaseStore } from '../packages/storage/src/index.js';
import { normalizeEvidence } from '../packages/redaction/src/index.js';
import { InMemoryAuditLog, type LlmConfig } from '../packages/application/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';

const DETERMINISTIC_LLM: LlmConfig = { mode: 'off', endpoint: '', model: '', timeoutMs: 1_000, providerName: 'test' };

function learnOptions(brainPath: string, overrides: Partial<LearnOptions> = {}): LearnOptions {
  return { brainPath, llm: DETERMINISTIC_LLM, ...overrides };
}

describe('runLearn', () => {
  it('learns from text into reviewable candidates with provenance and audit', async () => {
    const fixture = await createTemporaryDirectory();
    const audit = new InMemoryAuditLog();
    const report = await runLearn(
      { text: 'Bounded retries with exponential backoff fix transient network test failures. Always verify with pnpm test after changing retry logic.', type: 'lessons' },
      learnOptions(fixture.path, { audit }),
    );
    try {
      expect(report.source).toBe('text');
      expect(report.blocks).toBe(1);
      expect(report.candidates).toBeGreaterThanOrEqual(1);
      expect(report.skippedRedacted).toBe(0);
      const events = await audit.list();
      expect(events.some((event) => event.eventType === 'learn.completed')).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it('records file provenance on learned evidence', async () => {
    const fixture = await createTemporaryDirectory();
    const notePath = join(fixture.path, 'notes', 'arch.md');
    await mkdir(join(fixture.path, 'notes'), { recursive: true });
    await writeFile(notePath, 'The API gateway uses token bucket rate limiting at 100 rps per tenant.', 'utf8');
    try {
      const report = await runLearn({ file: notePath }, learnOptions(fixture.path));
      expect(report.blocks).toBe(1);
      expect(report.candidates).toBeGreaterThanOrEqual(1);
      const database = new DatabaseStore(join(fixture.path, 'taga.db'));
      try {
        const evidence = database.listEvidence();
        const learned = evidence.find((event) => event.id.startsWith('evidence-learn-'));
        expect(learned).toBeDefined();
        expect(JSON.stringify(learned)).toContain('arch.md');
      } finally {
        database.close();
      }
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it('ignores dependency folders and honors include filters when learning a directory', async () => {
    const fixture = await createTemporaryDirectory();
    const docs = join(fixture.path, 'docs');
    await mkdir(join(docs, 'node_modules'), { recursive: true });
    await mkdir(join(docs, '.hidden'), { recursive: true });
    await writeFile(join(docs, 'real.md'), 'Deploy flow: build, test, release gate, ship.', 'utf8');
    await writeFile(join(docs, 'node_modules', 'junk.md'), 'should be ignored', 'utf8');
    await writeFile(join(docs, '.hidden', 'secret.md'), 'should be ignored', 'utf8');
    await writeFile(join(docs, 'log.txt'), 'plain text learning content', 'utf8');
    try {
      const report = await runLearn({ dir: docs }, learnOptions(fixture.path));
      expect(report.blocks).toBe(2);
      const reportMdOnly = await runLearn({ dir: docs, include: '.md' }, learnOptions(fixture.path));
      expect(reportMdOnly.blocks).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it('enforces per-file size limits', async () => {
    const fixture = await createTemporaryDirectory();
    const big = join(fixture.path, 'big.md');
    await writeFile(big, 'x'.repeat(2000), 'utf8');
    try {
      const report = await runLearn({ file: big }, learnOptions(fixture.path, { maxFileBytes: 1000 }));
      expect(report.blocks).toBe(0);
      expect(report.errors.join(' ')).toContain('larger than');
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it('blocks url learning without explicit network opt-in and allows it with a stubbed fetch', async () => {
    const fixture = await createTemporaryDirectory();
    try {
      const blocked = await runLearn({ url: 'https://example.com/post' }, learnOptions(fixture.path));
      expect(blocked.errors.join(' ')).toContain('network fetch is disabled');
      expect(blocked.blocks).toBe(0);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = () => Promise.resolve(new Response('<html><body><p>Web knowledge content for learning.</p></body></html>', { status: 200, headers: { 'content-type': 'text/html' } }));
      try {
        const allowed = await runLearn({ url: 'https://example.com/post', allowNetwork: true }, learnOptions(fixture.path));
        expect(allowed.blocks).toBe(1);
        expect(allowed.candidates).toBeGreaterThanOrEqual(1);
        const database = new DatabaseStore(join(fixture.path, 'taga.db'));
        try {
          const evidence = database.listEvidence().find((event) => event.id.startsWith('evidence-learn-'));
          expect(JSON.stringify(evidence)).toContain('https://example.com/post');
        } finally {
          database.close();
        }
      } finally {
        globalThis.fetch = originalFetch;
      }
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it('blocks redacted-private-key content before it becomes evidence', async () => {
    const fixture = await createTemporaryDirectory();
    const secret = '-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----';
    const report = await runLearn({ text: secret }, learnOptions(fixture.path));
    try {
      expect(report.skippedRedacted).toBe(1);
      expect(report.candidates).toBe(0);
      const database = new DatabaseStore(join(fixture.path, 'taga.db'));
      try {
        expect(database.listEvidence().some((event) => event.id.startsWith('evidence-learn-'))).toBe(false);
      } finally {
        database.close();
      }
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it('returns an undefined checker when the embedding model is not configured', () => {
    const previous = process.env.TAGA_BGE_M3_MODEL_PATH;
    delete process.env.TAGA_BGE_M3_MODEL_PATH;
    try {
      expect(createSemanticDuplicateChecker('C:/does-not-matter')).toBeUndefined();
    } finally {
      if (previous !== undefined) process.env.TAGA_BGE_M3_MODEL_PATH = previous;
    }
  });
});

describe('semantic duplicate gate', () => {
  it('rejects candidates flagged as semantic duplicates and records the decision', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(join(fixture.path, 'taga.db'));
    const audit = new InMemoryAuditLog();
    database.saveEvidence(normalizeEvidence({
      id: 'evidence-dup-gate',
      source: 'hook',
      projectId: 'project-dup',
      sessionId: 'session-dup',
      raw: 'Use bounded retries; tests passed',
      occurredAt: '2026-11-14T00:00:00.000Z',
      capturedAt: '2026-11-14T00:00:00.000Z',
      refs: [{ kind: 'test', locator: 'pnpm test' }],
    }).event);
    const gateCalls: string[] = [];
    try {
      const report = await new AutomaticDistillationService(database, undefined, undefined, {
        audit,
        clock: () => new Date('2026-11-14T01:00:00.000Z'),
        duplicateGate: (candidate) => {
          gateCalls.push(candidate.title);
          const verdict: SemanticDuplicateVerdict = { duplicate: true, duplicateOf: 'mem-existing', score: 0.96 };
          return Promise.resolve(verdict);
        },
      }).run({ projectId: 'project-dup' });
      expect(report.candidates).toBe(0);
      expect(report.duplicates).toBe(1);
      expect(gateCalls.length).toBe(1);
      const events = await audit.list();
      expect(events.some((event) => event.eventType === 'distillation.semantic_duplicate')).toBe(true);
      database.close();
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it('keeps candidates when the gate reports them as novel', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(join(fixture.path, 'taga.db'));
    database.saveEvidence(normalizeEvidence({
      id: 'evidence-dup-gate-2',
      source: 'hook',
      projectId: 'project-dup',
      sessionId: 'session-dup',
      raw: 'Use bounded retries; tests passed',
      occurredAt: '2026-11-14T00:00:00.000Z',
      capturedAt: '2026-11-14T00:00:00.000Z',
      refs: [{ kind: 'test', locator: 'pnpm test' }],
    }).event);
    try {
      const report = await new AutomaticDistillationService(database, undefined, undefined, {
        clock: () => new Date('2026-11-14T01:00:00.000Z'),
        duplicateGate: () => Promise.resolve({ duplicate: false, score: 0.42 }),
      }).run({ projectId: 'project-dup' });
      expect(report.candidates).toBe(1);
      expect(report.duplicates).toBe(0);
      database.close();
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);
});

describe('learn CLI', () => {
  it('learns from --text and surfaces candidates in the review queue', async () => {
    const fixture = await createTemporaryDirectory();
    const streams = { stdout: process.stdout, stderr: process.stderr } as const;
    try {
      expect(await runCli(['learn', '--text=Token bucket rate limiting protects the gateway.', '--type=environment', '--json', `--brain=${join(fixture.path, 'brain')}`], { cwd: fixture.path, streams })).toBe(0);
      expect(await runCli(['review', 'ls', '--json', `--brain=${join(fixture.path, 'brain')}`], { cwd: fixture.path, streams })).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it('rejects unsupported types', async () => {
    const fixture = await createTemporaryDirectory();
    const streams = { stdout: process.stdout, stderr: process.stderr } as const;
    try {
      expect(await runCli(['learn', '--text=x', '--type=nonsense', '--json', `--brain=${join(fixture.path, 'brain')}`], { cwd: fixture.path, streams })).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);
});
