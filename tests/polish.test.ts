import { describe, expect, it } from 'vitest';
import {
  FakeDistiller,
  InMemoryCandidateRepository,
  LlmAdjudicator,
  LlmDistiller,
  PolishService,
  ReviewService,
  classifyLlmError,
  type StructuredCompletionProvider,
} from '../packages/distillation/src/index.js';
import { InMemoryAuditLog, InMemoryMemoryRepository, SqliteAuditLog } from '../packages/application/src/index.js';
import { checkReflectOnAccept } from '../apps/daemon/src/index.js';
import { AgentIngestionService, AutomaticSourceRuntime } from '../apps/daemon/src/index.js';
import { AgentAdapterRegistry, PiAgentAdapter } from '../packages/adapters/src/index.js';
import { MetricsService } from '../packages/metrics/src/index.js';
import { normalizeEvidence } from '../packages/redaction/src/index.js';
import { DatabaseStore, type JobRecord } from '../packages/storage/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';

const polishedDraft = JSON.stringify({ title: '泛化后的标题', summary: '泛化后的摘要，含适用边界。', confidence: 0.9 });

function stubProvider(response: string | Error): { provider: StructuredCompletionProvider; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    provider: {
      complete: (request) => {
        calls.push(request.user);
        return response instanceof Error ? Promise.reject(response) : Promise.resolve({ text: response, latencyMs: 1 });
      },
    },
  };
}

async function draftCandidate() {
  const evidence = normalizeEvidence({
    id: 'evidence-polish-1',
    source: 'hook',
    raw: 'tests passed after fixing EPERM',
    occurredAt: '2026-11-27T00:00:00.000Z',
    capturedAt: '2026-11-27T00:00:00.000Z',
    refs: [{ kind: 'test', locator: 'pnpm test' }],
  }).event;
  const observation = {
    id: 'observation-polish-1',
    evidenceIds: [evidence.id],
    kind: 'problem' as const,
    summary: 'tests passed after fixing EPERM',
    novelty: 0.8,
    reuse: 0.8,
    evidenceQuality: 0.9,
    sensitivityRisk: 0,
    createdAt: '2026-11-27T00:00:00.000Z',
  };
  return new FakeDistiller().distill({ observation, evidence: [evidence], verified: true });
}

describe('L2 polish on acceptance', () => {
  it('rewrites accepted deterministic drafts into generalized memories', async () => {
    const candidate = await draftCandidate();
    const candidates = new InMemoryCandidateRepository();
    candidates.save(candidate);
    const { provider, calls } = stubProvider(polishedDraft);
    const review = new ReviewService(candidates, new InMemoryMemoryRepository(), new InMemoryAuditLog(), undefined, new PolishService(provider, 'test-model', 1000));
    const memory = await review.accept(candidate.id, { actor: 'user' }, 'accept for polish');
    expect(calls).toHaveLength(1);
    expect(memory.title).toBe('泛化后的标题');
    expect(memory.summary).toBe('泛化后的摘要，含适用边界。');
  });

  it('keeps the draft when polishing fails and never blocks acceptance', async () => {
    const candidate = await draftCandidate();
    const candidates = new InMemoryCandidateRepository();
    candidates.save(candidate);
    const { provider, calls } = stubProvider(new Error('LLM provider returned HTTP 429'));
    const review = new ReviewService(candidates, new InMemoryMemoryRepository(), new InMemoryAuditLog(), undefined, new PolishService(provider, 'test-model', 1000));
    const memory = await review.accept(candidate.id, { actor: 'user' }, 'accept with polish failure');
    expect(calls).toHaveLength(1);
    expect(memory.title).toBe(candidate.title);
    expect(memory.summary).toBe(candidate.summary);
  });

  it('never polishes LLM-authored candidates', async () => {
    const candidate = await draftCandidate();
    const llmCandidate = { ...candidate, model: { ...candidate.model!, mode: 'llm' as const } };
    const candidates = new InMemoryCandidateRepository();
    candidates.save(llmCandidate);
    const { provider, calls } = stubProvider(polishedDraft);
    const review = new ReviewService(candidates, new InMemoryMemoryRepository(), new InMemoryAuditLog(), undefined, new PolishService(provider, 'test-model', 1000));
    const memory = await review.accept(llmCandidate.id, { actor: 'user' }, 'accept llm candidate');
    expect(calls).toHaveLength(0);
    expect(memory.title).toBe(candidate.title);
  });
});

describe('LLM discipline', () => {
  it('marks oversized prompt payloads as elided and keeps the slim output contract', async () => {
    const evidence = normalizeEvidence({
      id: 'evidence-elide-1',
      source: 'hook',
      raw: 'x'.repeat(20_000) + ' tests passed',
      occurredAt: '2026-11-27T00:00:00.000Z',
      capturedAt: '2026-11-27T00:00:00.000Z',
      refs: [{ kind: 'test', locator: 'pnpm test' }],
    }).event;
    const observation = {
      id: 'observation-elide-1',
      evidenceIds: [evidence.id],
      kind: 'problem' as const,
      summary: 'oversized',
      novelty: 0.8,
      reuse: 0.8,
      evidenceQuality: 0.9,
      sensitivityRisk: 0,
      createdAt: '2026-11-27T00:00:00.000Z',
    };
    const { provider, calls } = stubProvider(JSON.stringify({ memoryType: 'lessons', title: 'T', summary: 'S', body: 'B', confidence: 0.9 }));
    await new LlmDistiller({ provider, providerName: 'test', model: 'test-model' }).distill({ observation, evidence: [evidence], verified: true });
    expect(calls[0]).toContain('<elided chars=');
    expect(calls[0]).not.toContain('temporalFacts');
    expect(calls[0]).not.toContain('causalLinks');
  });

  it('classifies LLM failures for the no-retry discipline', () => {
    expect(classifyLlmError('LLM provider returned HTTP 429')).toBe('rate-limit');
    expect(classifyLlmError('LLM provider returned HTTP 402')).toBe('quota');
    expect(classifyLlmError('The operation was aborted due to timeout')).toBe('timeout');
    expect(classifyLlmError('LLM output did not contain a JSON object')).toBe('output');
  });
});

describe('event-driven reflect', () => {
  it('triggers reflect once three new memories exist and then resets', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(`${fixture.path}/taga.db`);
    const audit = new SqliteAuditLog(database);
    const record = (id: string, at: string): Promise<unknown> => audit.append({
      eventType: 'memory.created',
      actor: 'user',
      subjectType: 'memory',
      subjectId: id,
      occurredAt: at,
      reason: 'test',
      payload: {},
    });
    await record('m1', '2026-11-27T01:00:00.000Z');
    await record('m2', '2026-11-27T02:00:00.000Z');
    expect(await checkReflectOnAccept(database)).toBe(false);
    await record('m3', '2026-11-27T03:00:00.000Z');
    database.upsertMetadata('reflect:accept-scan', '0'); // bypass the 60s scan throttle
    expect(await checkReflectOnAccept(database)).toBe(true);
    expect(database.listJobs().some((job) => job.kind === 'reflect.run')).toBe(true);
    // watermark moved after the trigger: same memories must not trigger again
    database.upsertMetadata('reflect:accept-scan', '0');
    expect(await checkReflectOnAccept(database)).toBe(false);
    database.close();
    await fixture.cleanup();
  });
});

describe('L2 conflict adjudication', () => {
  const pair = {
    a: { id: 'mem-a', title: '路径比较用小写', summary: 'Windows 上比较路径前先转小写。' },
    b: { id: 'mem-b', title: '路径比较区分大小写', summary: 'Linux 上路径比较必须区分大小写。' },
  };

  it('returns the model verdict and persists nothing on failure', async () => {
    const { provider, calls } = stubProvider(JSON.stringify({ verdict: 'merge', reason: '同一约束的平台分支', merged_text: '路径比较按平台选择大小写策略。' }));
    const ok = await new LlmAdjudicator(provider, 'test-model', 1000).adjudicate(pair);
    expect(calls).toHaveLength(1);
    expect(ok).toMatchObject({ verdict: 'merge', adjudicated: true });
    const failing = await new LlmAdjudicator(stubProvider(new Error('HTTP 429')).provider, 'test-model', 1000).adjudicate(pair);
    expect(failing).toMatchObject({ verdict: 'keep-both', adjudicated: false });
  });
});

describe('distill job batching', () => {
  it('merges same-bucket events into one job with all eventIds', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(`${fixture.path}/taga.db`);
    const registry = new AgentAdapterRegistry([new PiAgentAdapter({ commandPath: null, sourcePaths: [] })]);
    const ingestion = new AgentIngestionService(database, registry, { clock: () => new Date('2026-11-27T00:00:00.000Z') });
    const runtime = new AutomaticSourceRuntime(database, ingestion, { clock: () => new Date('2026-11-27T00:00:00.000Z'), debounceMs: 1000 });
    const job = (raw: string): JobRecord => ({
      id: `job-${raw.length}`,
      kind: 'source.ingest',
      payload: JSON.stringify({ agentId: 'pi', event: 'hook', sessionId: 's-batch', raw }),
      status: 'running',
      attempts: 1,
      availableAt: '2026-11-27T00:00:00.000Z',
      leaseOwner: 'test',
      leaseUntil: '2026-11-27T00:01:00.000Z',
      lastError: null,
      createdAt: '2026-11-27T00:00:00.000Z',
      updatedAt: '2026-11-27T00:00:00.000Z',
    });
    await runtime.handle(job('tests passed one'));
    await runtime.handle(job('tests passed two'));
    const distillJobs = database.listJobs().filter((entry) => entry.kind === 'distill.auto');
    expect(distillJobs).toHaveLength(1);
    const payload = JSON.parse(distillJobs[0]!.payload) as { eventIds?: string[] };
    expect(payload.eventIds).toHaveLength(2);
    database.close();
    await fixture.cleanup();
  });
});

describe('learning metrics', () => {
  it('reports draft acceptance and polish rates with raw numerator/denominator', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(`${fixture.path}/taga.db`);
    const draft = await draftCandidate();
    database.saveCandidate({ ...draft, id: 'candidate-draft-1', decision: 'accepted' });
    database.saveCandidate({ ...draft, id: 'candidate-draft-2', decision: 'rejected' });
    const audit = new SqliteAuditLog(database);
    await audit.append({ eventType: 'candidate.accepted', actor: 'user', subjectType: 'candidate', subjectId: 'candidate-draft-1', occurredAt: '2026-11-27T01:00:00.000Z', reason: 'ok', payload: { polished: true } });
    const report = await new MetricsService(database).learningEffectiveness();
    expect(report.drafts).toEqual({ created: 2, accepted: 1, acceptanceRate: 0.5 });
    expect(report.polish).toEqual({ attempted: 1, applied: 1, rate: 1 });
    database.close();
    await fixture.cleanup();
  });
});
