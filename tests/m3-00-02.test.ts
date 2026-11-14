import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROACTIVE_POLICY,
  InMemoryAuditLog,
  InMemoryMemoryRepository,
  ProactivePolicyService,
  evaluateProactivePolicy,
} from '../packages/application/src/index.js';
import { AutomaticSourceRuntime, AgentIngestionService } from '../apps/daemon/src/index.js';
import { AgentAdapterRegistry, PiAgentAdapter } from '../packages/adapters/src/index.js';
import { AutomaticDistillationService, InMemoryCandidateRepository } from '../packages/distillation/src/index.js';
import { normalizeEvidence } from '../packages/redaction/src/index.js';
import { parseMemory } from '../packages/domain/src/index.js';
import { DatabaseStore } from '../packages/storage/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';

const timestamp = '2026-11-11T00:00:00.000Z';

describe('M3-00 proactive policy', () => {
  it('classifies collection, review, and external actions deterministically', () => {
    expect(evaluateProactivePolicy({ action: 'collect', subjectType: 'source', subjectId: 's' }).level).toBe('L0');
    expect(evaluateProactivePolicy({ action: 'activate', subjectType: 'candidate', subjectId: 'c', memoryType: 'preferences', confidence: 1, evidenceGatePassed: true }).outcome).toBe('review_required');
    expect(evaluateProactivePolicy({ action: 'activate', subjectType: 'candidate', subjectId: 'c', memoryType: 'lessons', confidence: 0.95, evidenceGatePassed: true }, { ...DEFAULT_PROACTIVE_POLICY, autoActivateLessons: true }).allowed).toBe(true);
    expect(evaluateProactivePolicy({ action: 'external', subjectType: 'action', subjectId: 'a', timedOut: true }).reason).toBe('approval-timeout');
  });

  it('audits every policy decision', async () => {
    const audit = new InMemoryAuditLog();
    await new ProactivePolicyService(audit).decide({ action: 'distill', subjectType: 'run', subjectId: 'run-1' });
    expect((await audit.list())[0]?.payload).toMatchObject({ level: 'L0', action: 'distill' });
  });
});

describe('M3-01 automatic source runtime', () => {
  it('queues debounced durable source jobs and keeps hook collection redacted', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(`${fixture.path}/taga.db`);
    const registry = new AgentAdapterRegistry([new PiAgentAdapter({ commandPath: null, sourcePaths: [] })]);
    const ingestion = new AgentIngestionService(database, registry, { clock: () => new Date(timestamp) });
    const runtime = new AutomaticSourceRuntime(database, ingestion, { clock: () => new Date(timestamp), debounceMs: 1000 });
    const first = await runtime.trigger({ agentId: 'pi', event: 'session-end', sessionId: 's-1' });
    const second = await runtime.trigger({ agentId: 'pi', event: 'session-end', sessionId: 's-1' });
    expect(first.queued).toBe(true);
    expect(second.reason).toBe('debounced');
    await runtime.handle({ ...database.getJob(first.jobId)!, status: 'running', leaseOwner: 'test', leaseUntil: timestamp, attempts: 1, lastError: null, availableAt: timestamp, kind: 'source.ingest', payload: JSON.stringify({ agentId: 'pi', event: 'hook', sessionId: 's-2', raw: 'password=hidden; tests passed' }), id: first.jobId });
    expect(JSON.stringify(database.listEvidence())).not.toContain('hidden');
    expect(database.listJobs().some((job) => job.kind === 'distill.auto')).toBe(true);
    database.close();
    await fixture.cleanup();
  });
});

describe('M3-02 automatic distillation', () => {
  it('creates anchored candidates only for verifiable, valuable segments', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(`${fixture.path}/taga.db`);
    const evidence = normalizeEvidence({
      id: 'evidence-m3',
      source: 'hook',
      projectId: 'project-1',
      sessionId: 'session-1',
      raw: 'Use bounded retries; tests passed',
      occurredAt: timestamp,
      capturedAt: timestamp,
      refs: [{ kind: 'test', locator: 'pnpm test' }],
    }).event;
    database.saveEvidence(evidence);
    const candidates = new InMemoryCandidateRepository();
    const report = await new AutomaticDistillationService(database, undefined, candidates).run();
    expect(report.candidates).toBe(1);
    expect(candidates.list()[0]?.anchors).toEqual([{ kind: 'test', locator: 'pnpm test' }]);
    expect(candidates.list()[0]?.confidence).toBeGreaterThan(0.7);
    expect(candidates.list()[0]?.decisionReason).toBe('candidate-created');
    expect(candidates.list()[0]?.decision).toBe('pending');
    database.close();
    await fixture.cleanup();
  });

  it('keeps default lesson activation disabled and rejects source-less inference', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(`${fixture.path}/taga.db`);
    const evidence = normalizeEvidence({ id: 'evidence-m3-no-proof', source: 'watcher', raw: 'Maybe use bounded retries', occurredAt: timestamp, capturedAt: timestamp }).event;
    database.saveEvidence(evidence);
    const memories = new InMemoryMemoryRepository();
    const audit = new InMemoryAuditLog();
    const report = await new AutomaticDistillationService(database, undefined, new InMemoryCandidateRepository(), { memories, audit }).run();
    expect(report.candidates).toBe(0);
    expect(report.rejected).toBe(1);
    expect(await memories.list()).toHaveLength(0);
    expect((await audit.list()).some((event) => event.eventType === 'proactive.policy_decision')).toBe(true);
    database.close();
    await fixture.cleanup();
  });

  it('emits duplicate proposals and only auto-activates opted-in lessons through governance', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(`${fixture.path}/taga.db`);
    const evidence = normalizeEvidence({ id: 'evidence-m3-duplicate', source: 'hook', projectId: 'project-1', sessionId: 'session-2', raw: 'Use bounded retries; tests passed', occurredAt: timestamp, capturedAt: timestamp, refs: [{ kind: 'test', locator: 'pnpm test' }] }).event;
    database.saveEvidence(evidence);
    const existing = parseMemory({
      schemaVersion: 1,
      id: 'memory-existing',
      type: 'procedures',
      scope: { kind: 'project', id: 'project-1' },
      projectId: 'project-1',
      status: 'active',
      title: 'Existing',
      summary: 'Use bounded retries; tests passed',
      confidence: 0.9,
      sourceTrust: 'observed',
      visibility: 'private',
      created: timestamp,
      updated: timestamp,
      sources: [{ kind: 'test', locator: 'existing' }],
      contentHash: 'sha256:existing',
    });
    const memories = new InMemoryMemoryRepository();
    await memories.save(existing);
    const duplicateCandidates = new InMemoryCandidateRepository();
    const duplicateReport = await new AutomaticDistillationService(database, undefined, duplicateCandidates, { memories, audit: new InMemoryAuditLog() }).run();
    expect(duplicateReport.duplicates).toBe(1);
    expect(duplicateCandidates.list()[0]?.duplicateOf).toBe('memory-existing');

    const lessonDatabase = new DatabaseStore(`${fixture.path}/lesson.db`);
    lessonDatabase.saveEvidence({ ...evidence, id: 'evidence-m3-lesson', sessionId: 'session-3', payload: { summary: 'Resolved intermittent failure; tests passed', text: 'Resolved intermittent failure; tests passed' } });
    const lessonMemories = new InMemoryMemoryRepository();
    const lessonAudit = new InMemoryAuditLog();
    const lessonReport = await new AutomaticDistillationService(lessonDatabase, undefined, new InMemoryCandidateRepository(), {
      memories: lessonMemories,
      audit: lessonAudit,
      policy: { ...DEFAULT_PROACTIVE_POLICY, autoActivateLessons: true },
    }).run();
    expect(lessonReport.activated).toBe(1);
    expect((await lessonMemories.list())[0]?.status).toBe('active');
    lessonDatabase.close();
    database.close();
    await fixture.cleanup();
  });
});
