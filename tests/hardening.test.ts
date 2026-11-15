import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { runCli } from '../apps/cli/src/index.js';
import { runReflect } from '../packages/learning/src/index.js';
import { ReviewService } from '../packages/distillation/src/index.js';
import { GardenService } from '../packages/garden/src/index.js';
import { DatabaseCandidateRepository } from '../packages/distillation/src/index.js';
import { DatabaseStore, contentHash, parseMarkdownDocument, writeMarkdownDocument } from '../packages/storage/src/index.js';
import { InMemoryAuditLog, SqliteAuditLog } from '../packages/application/src/index.js';
import { transitionMemory, parseCandidate } from '../packages/domain/src/index.js';
import { MarkdownMemoryRepository } from '../packages/storage/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';
import type { Memory } from '../packages/domain/src/index.js';

function memory(overrides: Partial<Memory> = {}): Memory {
  const timestamp = '2026-11-15T00:00:00.000Z';
  return {
    schemaVersion: 1,
    id: 'mem-hardening',
    type: 'lessons',
    scope: { kind: 'global' },
    projectId: null,
    status: 'active',
    title: 'Hardening fixture memory',
    summary: 'Fixture summary for hardening tests.',
    confidence: 0.9,
    sourceTrust: 'user_authored',
    visibility: 'private',
    created: timestamp,
    updated: timestamp,
    lastVerified: null,
    lastRecalled: null,
    reviewCount: 0,
    usefulCount: 0,
    notUsefulCount: 0,
    expiresAt: null,
    contentHash: contentHash('hardening body'),
    sources: [{ kind: 'test', locator: 'hardening.test.ts' }],
    anchors: [],
    tags: [],
    supersedes: null,
    ...overrides,
  };
}

describe('crlf tolerance', () => {
  it('parses markdown documents with CRLF line endings', async () => {
    const fixture = await createTemporaryDirectory();
    const brain = fixture.path;
    const item = memory({ id: 'mem-crlf' });
    const lfPath = join(brain, 'lessons', 'global', 'mem-lf.md');
    await writeMarkdownDocument(lfPath, item, 'lf body');
    const crlfPath = join(brain, 'lessons', 'global', 'mem-crlf.md');
    const raw = await readFile(lfPath, 'utf8');
    await writeFile(crlfPath, raw.replace(/\n/gu, '\r\n'), 'utf8');
    try {
      const repository = new MarkdownMemoryRepository(brain);
      const records = await repository.records();
      const learned = records.find((record) => record.memory.id === 'mem-crlf');
      expect(learned).toBeDefined();
      expect(learned?.memory.status).toBe('active');
      expect(learned?.body.replace(/\r\n/gu, '\n')).toContain('lf body');
      await fixture.cleanup();
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it('parses a bare CRLF document string directly', () => {
    const parsed = parseMarkdownDocument('---\r\nid: mem-x\r\nstatus: draft\r\n---\r\nbody line\r\n');
    expect(parsed.frontmatter.id).toBe('mem-x');
    expect(parsed.body).toContain('body line');
  });
});

describe('candidate state machine', () => {
  it('allows candidate to activate and forget, rejects other transitions', () => {
    const base = memory({ id: 'mem-state', status: 'candidate' });
    expect(transitionMemory(base, { type: 'activate' }).status).toBe('active');
    const again = memory({ id: 'mem-state', status: 'candidate' });
    expect(transitionMemory(again, { type: 'forget', confirmed: true }).status).toBe('forgotten');
    const locked = memory({ id: 'mem-state', status: 'candidate' });
    expect(() => transitionMemory(locked, { type: 'supersede', replacementId: 'mem-other' })).toThrow();
  });
});

describe('review reject', () => {
  it('rejects a distillation candidate with audit', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(join(fixture.path, 'taga.db'));
    const audit = new SqliteAuditLog(database);
    new DatabaseCandidateRepository(database).save(parseCandidate({
      schemaVersion: 1,
      id: 'candidate-reject-me',
      observationId: 'observation-reject-me',
      agentId: 'claude-code',
      projectId: 'project-reject',
      memoryType: 'lessons',
      title: 'Noisy candidate',
      summary: 'Should be rejectable.',
      body: 'Body.',
      scopeSuggestion: { kind: 'project', id: 'project-reject' },
      worthLearning: true,
      evidenceIds: ['evidence-1'],
      anchors: [],
      confidence: 0.6,
      createdAt: '2026-11-15T00:00:00.000Z',
      decision: 'pending',
      model: { provider: 'deterministic-auto', model: 'm3', mode: 'deterministic', promptVersion: 'p', schemaVersion: 'candidate-v2', inputEvidenceIds: ['evidence-1'], latencyMs: 0 },
    }));
    try {
      const repository = new MarkdownMemoryRepository(fixture.path);
      const rejected = await new ReviewService(new DatabaseCandidateRepository(database), repository, audit).reject('candidate-reject-me', { actor: 'user' }, 'review reject from CLI');
      expect(rejected.decision).toBe('rejected');
      const events = await audit.list();
      expect(events.some((event) => event.eventType === 'candidate.rejected')).toBe(true);
      database.close();
      await fixture.cleanup();
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it('forgets draft memories on reject through the CLI', async () => {
    const fixture = await createTemporaryDirectory();
    const brain = join(fixture.path, 'brain');
    await mkdir(brain, { recursive: true });
    const draft = memory({ id: 'mem-draft-reject', status: 'draft' });
    await writeMarkdownDocument(join(brain, 'lessons', 'global', `${draft.id}.md`), draft, 'draft body');
    const streams = { stdout: process.stdout, stderr: process.stderr } as const;
    try {
      expect(await runCli(['review', 'reject', `--memory=${draft.id}`, '--json', `--brain=${brain}`], { cwd: fixture.path, streams })).toBe(0);
      const repository = new MarkdownMemoryRepository(brain);
      const forgotten = await repository.get(draft.id);
      expect(forgotten?.status).toBe('forgotten');
      await fixture.cleanup();
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);
});

describe('garden record proposal', () => {
  it('files idempotent generic proposals', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(join(fixture.path, 'taga.db'));
    try {
      const garden = new GardenService(database);
      const first = garden.recordProposal({
        category: 'duplicate',
        affectedIds: ['mem-a', 'mem-b'],
        evidence: { memoryIds: ['mem-a', 'mem-b'], contentHashes: ['h1', 'h2'], sourceCount: 2 },
        score: 1,
        threshold: 1,
        reason: 'reflect insight suggests consolidation',
        suggestedAction: 'review_duplicate',
      });
      const second = garden.recordProposal({
        category: 'duplicate',
        affectedIds: ['mem-a', 'mem-b'],
        evidence: { memoryIds: ['mem-a', 'mem-b'], contentHashes: ['h1', 'h2'], sourceCount: 2 },
        score: 1,
        threshold: 1,
        reason: 'reflect insight suggests consolidation',
        suggestedAction: 'review_duplicate',
      });
      expect(first.id).toBe(second.id);
      expect(garden.list('pending')).toHaveLength(1);
      database.close();
      await fixture.cleanup();
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('reflect files redundancy proposals', () => {
  it('files a consolidation proposal for each reflected group', async () => {
    const fixture = await createTemporaryDirectory();
    const brain = fixture.path;
    await mkdir(brain, { recursive: true });
    for (let index = 0; index < 3; index += 1) {
      const item = memory({ id: `mem-reflect-prop-${index}`, title: `Lesson ${index}` });
      await writeMarkdownDocument(join(brain, 'lessons', 'global', `${item.id}.md`), item, `body ${index}`);
    }
    const provider = {
      complete: () => Promise.resolve({ text: JSON.stringify({
        memoryType: 'lessons',
        title: 'Consolidated insight for the group',
        summary: 'These lessons share bounded retry discipline.',
        body: 'Bounded retries with verification.',
        confidence: 0.9,
        facts: [],
        entities: [],
        temporalFacts: [],
        causalLinks: [],
        applicability: { conditions: [], exclusions: [] },
      }), latencyMs: 1 }),
    };
    const audit = new InMemoryAuditLog();
    const report = await runReflect({}, {
      brainPath: fixture.path,
      audit,
      provider,
      llm: { mode: 'on', endpoint: 'http://fixture', model: 'fixture', timeoutMs: 1_000, providerName: 'fixture' },
      config: { mode: 'on', intervalMs: 604_800_000, windowDays: 7, minGroupSize: 3, maxGroups: 5 },
      clock: () => new Date('2026-11-15T00:00:00.000Z'),
    });
    try {
      expect(report.candidates).toBe(1);
      const database = new DatabaseStore(join(brain, 'taga.db'));
      try {
        const proposals = new GardenService(database).list('pending');
        expect(proposals.some((proposal) => proposal.reason.includes('same-theme memories'))).toBe(true);
      } finally {
        database.close();
      }
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);
});
