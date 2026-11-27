import { describe, expect, it } from 'vitest';
import {
  AutomaticDistillationService,
  InMemoryCandidateRepository,
  MiningDraftDistiller,
  classifyEvidenceSignal,
  extractProseSummary,
} from '../packages/distillation/src/index.js';
import { AgentIngestionService, AutomaticSourceRuntime } from '../apps/daemon/src/index.js';
import { AgentAdapterRegistry, PiAgentAdapter } from '../packages/adapters/src/index.js';
import { createDefaultConfig } from '../packages/config/src/index.js';
import { DatabaseStore } from '../packages/storage/src/index.js';
import { normalizeEvidence } from '../packages/redaction/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';

const timestamp = '2026-11-27T00:00:00.000Z';

function event(id: string, raw: string) {
  return normalizeEvidence({
    id,
    source: 'hook',
    projectId: 'project-mining',
    sessionId: 'session-mining',
    raw,
    occurredAt: timestamp,
    capturedAt: timestamp,
  }).event;
}

describe('L0 signal classification', () => {
  it('classifies telemetry JSONL as noise and curated prose as instruction', () => {
    expect(classifyEvidenceSignal('{"timestamp":"2026-11-16T01:50:39Z","type":"token_usage_record","payload":{"total_tokens":42}}').kind).toBe('noise');
    expect(classifyEvidenceSignal('{"type":"file-history-snapshot","messageId":"c12d"}').kind).toBe('noise');
    expect(classifyEvidenceSignal('帮我看看这个报错').kind).toBe('instruction');
    expect(classifyEvidenceSignal('Please review the design doc').kind).toBe('instruction');
  });

  it('classifies outcome events from fix, decision and correction signals', () => {
    const fix = classifyEvidenceSignal('tests failed with EPERM, fixed by retrying the build');
    expect(fix.kind).toBe('outcome');
    expect(fix.flags).toContain('error');
    expect(fix.flags).toContain('fix');
    const decision = classifyEvidenceSignal('decided to use pnpm run build for CI');
    expect(decision.kind).toBe('outcome');
    expect(decision.flags).toContain('decision');
    const correction = classifyEvidenceSignal('不对，以后都用单引号');
    expect(correction.kind).toBe('outcome');
    expect(correction.flags).toContain('user-correction');
  });

  it('classifies environment facts without outcome signals', () => {
    const signal = classifyEvidenceSignal('D:\\cache\\huggingface stores the bge-m3 model for node 22');
    expect(signal.kind).toBe('fact');
    expect(signal.flags).toContain('env-fact');
  });

  it('extracts prose summaries instead of raw JSON lines', () => {
    const summary = extractProseSummary('{"timestamp":"2026-07-06T02:45:33Z","type":"session_meta","message":"hello world session"}');
    expect(summary).toBe('hello world session');
    expect(extractProseSummary('Use bounded retries')).toBe('Use bounded retries');
  });

  it('treats tool plumbing as noise and assistant advice as non-corrective', () => {
    expect(classifyEvidenceSignal('{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"pnpm run build"}}]}}').kind).toBe('noise');
    expect(classifyEvidenceSignal('{"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"git status"}}').kind).toBe('noise');
    const advice = classifyEvidenceSignal('{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"以后应该使用单引号"}]}}');
    expect(advice.kind).not.toBe('outcome');
    const correction = classifyEvidenceSignal('{"type":"user","message":{"role":"user","content":"不对，以后都用单引号"}}');
    expect(correction.kind).toBe('outcome');
  });

  it('keeps envelope bookkeeping values from faking environment facts', () => {
    const record = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Enough evidence. The answer is in the related list."}]},"cwd":"C:\\\\Users\\\\admin\\\\workdir","sessionId":"abc"}';
    expect(classifyEvidenceSignal(record).kind).toBe('instruction');
  });

  it('unwraps nested JSON in summaries', () => {
    const summary = extractProseSummary('{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"{\\"result\\": \\"order related info found in table\\"}"}]}}');
    expect(summary.startsWith('{')).toBe(false);
    expect(summary).toContain('order related info');
  });
});

describe('mining draft distillation', () => {
  it('produces a deterministic template draft with facts and no LLM', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(`${fixture.path}/taga.db`);
    const evidence = event('evidence-mining-1', '{"type":"message","content":"tests failed with EPERM, fixed by running pnpm run build --force"}');
    database.saveEvidence(evidence);
    const candidates = new InMemoryCandidateRepository();
    const report = await new AutomaticDistillationService(database, new MiningDraftDistiller(), candidates).run();
    expect(report.candidates).toBe(1);
    const candidate = candidates.list()[0];
    expect(candidate?.model?.mode).toBe('deterministic');
    expect(candidate?.model?.provider).toBe('mining-template');
    expect(candidate?.summary.startsWith('{')).toBe(false);
    expect(candidate?.title).toContain('EPERM');
    const facts = candidate?.facts ?? [];
    expect(facts.some((fact) => fact.text.includes('EPERM'))).toBe(true);
    expect(facts.some((fact) => fact.text.includes('pnpm'))).toBe(true);
    expect(facts.every((fact) => fact.evidenceIds.includes('evidence-mining-1'))).toBe(true);
    database.close();
    await fixture.cleanup();
  });

  it('rejects noise-only segments at the gate without producing candidates', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(`${fixture.path}/taga.db`);
    database.saveEvidence(event('evidence-mining-noise', '{"type":"token_usage_record","payload":{"total_tokens":42}}'));
    const candidates = new InMemoryCandidateRepository();
    const report = await new AutomaticDistillationService(database, new MiningDraftDistiller(), candidates).run();
    expect(report.candidates).toBe(0);
    expect(report.rejected).toBe(1);
    expect(candidates.list()).toHaveLength(0);
    database.close();
    await fixture.cleanup();
  });
});

describe('mining collection gate', () => {
  it('enqueues distill only for outcome events and skips telemetry', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(`${fixture.path}/taga.db`);
    const registry = new AgentAdapterRegistry([new PiAgentAdapter({ commandPath: null, sourcePaths: [] })]);
    const ingestion = new AgentIngestionService(database, registry, { clock: () => new Date(timestamp) });
    const runtime = new AutomaticSourceRuntime(database, ingestion, { clock: () => new Date(timestamp), debounceMs: 1000 });

    const noise = await runtime.trigger({ agentId: 'pi', event: 'hook', sessionId: 's-noise', raw: '{"type":"token_usage_record","payload":{"total_tokens":42}}' });
    await runtime.handle({ ...database.getJob(noise.jobId)!, status: 'running', leaseOwner: 'test', leaseUntil: timestamp, attempts: 1, lastError: null, availableAt: timestamp });
    expect(database.listJobs().some((job) => job.kind === 'distill.auto')).toBe(false);

    const outcome = await runtime.trigger({ agentId: 'pi', event: 'hook', sessionId: 's-outcome', raw: 'tests passed after fixing EPERM' });
    await runtime.handle({ ...database.getJob(outcome.jobId)!, status: 'running', leaseOwner: 'test', leaseUntil: timestamp, attempts: 1, lastError: null, availableAt: timestamp });
    const distill = database.listJobs().find((job) => job.kind === 'distill.auto');
    expect(distill).toBeDefined();
    const payload = JSON.parse(distill?.payload ?? '{}') as { eventIds?: string[] };
    expect(payload.eventIds).toHaveLength(1);
    database.close();
    await fixture.cleanup();
  });

  it('skips records older than the lookback window', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(`${fixture.path}/taga.db`);
    const registry = new AgentAdapterRegistry([new PiAgentAdapter({ commandPath: null, sourcePaths: [] })]);
    const ingestion = new AgentIngestionService(database, registry, { clock: () => new Date(timestamp), lookbackDays: 7 });
    const runtime = new AutomaticSourceRuntime(database, ingestion, { clock: () => new Date(timestamp), debounceMs: 1000, lookbackDays: 7 });

    const old = await runtime.trigger({ agentId: 'pi', event: 'hook', sessionId: 's-old', raw: 'tests passed', occurredAt: '2026-10-01T00:00:00.000Z' });
    await runtime.handle({ ...database.getJob(old.jobId)!, status: 'running', leaseOwner: 'test', leaseUntil: timestamp, attempts: 1, lastError: null, availableAt: timestamp });
    expect(database.listEvidence()).toHaveLength(0);
    expect(database.listJobs().some((job) => job.kind === 'distill.auto')).toBe(false);

    const fresh = await runtime.trigger({ agentId: 'pi', event: 'hook', sessionId: 's-fresh', raw: 'tests passed', occurredAt: '2026-11-27T00:00:00.000Z' });
    await runtime.handle({ ...database.getJob(fresh.jobId)!, status: 'running', leaseOwner: 'test', leaseUntil: timestamp, attempts: 1, lastError: null, availableAt: timestamp });
    expect(database.listEvidence()).toHaveLength(1);
    database.close();
    await fixture.cleanup();
  });

  it('defaults the collection lookback window to 7 days', () => {
    expect(createDefaultConfig().collection.lookbackDays).toBe(7);
  });
});
