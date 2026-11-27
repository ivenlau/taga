import { describe, expect, it } from 'vitest';
import {
  AutomaticDistillationService,
  InMemoryCandidateRepository,
  LlmDistiller,
  type StructuredCompletionProvider,
  type StructuredCompletionRequest,
} from '../packages/distillation/src/index.js';
import { AgentIngestionService, AutomaticSourceRuntime } from '../apps/daemon/src/index.js';
import { AgentAdapterRegistry, PiAgentAdapter } from '../packages/adapters/src/index.js';
import { DatabaseStore } from '../packages/storage/src/index.js';
import { normalizeEvidence } from '../packages/redaction/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';

const timestamp = '2026-11-26T00:00:00.000Z';

function countingProvider(): { provider: StructuredCompletionProvider; requests: StructuredCompletionRequest[] } {
  const requests: StructuredCompletionRequest[] = [];
  return {
    requests,
    provider: {
      complete: (request: StructuredCompletionRequest) => {
        requests.push(request);
        return Promise.resolve({
          text: JSON.stringify({ memoryType: 'lessons', title: 'T', summary: 'S', body: 'B', confidence: 0.9 }),
          latencyMs: 1,
        });
      },
    },
  };
}

function hookEvidence(id: string, raw: string) {
  return normalizeEvidence({
    id,
    source: 'hook',
    projectId: 'project-inc',
    sessionId: 'session-inc',
    raw,
    occurredAt: timestamp,
    capturedAt: timestamp,
    refs: [{ kind: 'test', locator: 'pnpm test' }],
  }).event;
}

describe('incremental automatic distillation', () => {
  it('distills only the requested eventIds', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(`${fixture.path}/taga.db`);
    const e1 = hookEvidence('evidence-inc-1', 'e1-marker tests passed');
    const e2 = hookEvidence('evidence-inc-2', 'e2-marker tests passed');
    const e3 = hookEvidence('evidence-inc-3', 'e3-marker tests passed');
    database.saveEvidence(e1);
    database.saveEvidence(e2);
    database.saveEvidence(e3);
    const { provider, requests } = countingProvider();
    const service = new AutomaticDistillationService(database, new LlmDistiller({ provider, providerName: 'test', model: 'test-model' }), new InMemoryCandidateRepository());
    const report = await service.run({ eventIds: [e1.id] });
    expect(report.candidates).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.user).toContain('e1-marker');
    expect(requests[0]?.user).not.toContain('e2-marker');
    expect(requests[0]?.user).not.toContain('e3-marker');
    database.close();
    await fixture.cleanup();
  });

  it('skips already-distilled segments without calling the LLM again', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(`${fixture.path}/taga.db`);
    const e1 = hookEvidence('evidence-inc-1', 'e1-marker tests passed');
    const e2 = hookEvidence('evidence-inc-2', 'e2-marker tests passed');
    database.saveEvidence(e1);
    database.saveEvidence(e2);
    const { provider, requests } = countingProvider();
    const service = new AutomaticDistillationService(database, new LlmDistiller({ provider, providerName: 'test', model: 'test-model' }), new InMemoryCandidateRepository());
    const first = await service.run({ eventIds: [e1.id, e2.id] });
    expect(first.candidates).toBe(1);
    expect(requests).toHaveLength(1);
    const second = await service.run({ eventIds: [e1.id, e2.id] });
    expect(second.candidates).toBe(0);
    expect(requests).toHaveLength(1);
    database.close();
    await fixture.cleanup();
  });

  it('bounds the LLM prompt for oversized evidence text', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(`${fixture.path}/taga.db`);
    const evidence = hookEvidence('evidence-inc-long', 'x'.repeat(20_000) + ' tests passed');
    database.saveEvidence(evidence);
    const { provider, requests } = countingProvider();
    const service = new AutomaticDistillationService(database, new LlmDistiller({ provider, providerName: 'test', model: 'test-model' }), new InMemoryCandidateRepository());
    await service.run({ eventIds: [evidence.id] });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.user).toContain('x'.repeat(4000));
    expect(requests[0]?.user).not.toContain('x'.repeat(4001));
    database.close();
    await fixture.cleanup();
  });
});

describe('distill.auto job payload', () => {
  it('carries the triggering eventIds for hook captures', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(`${fixture.path}/taga.db`);
    const registry = new AgentAdapterRegistry([new PiAgentAdapter({ commandPath: null, sourcePaths: [] })]);
    const ingestion = new AgentIngestionService(database, registry, { clock: () => new Date(timestamp) });
    const runtime = new AutomaticSourceRuntime(database, ingestion, { clock: () => new Date(timestamp), debounceMs: 1000 });
    const trigger = await runtime.trigger({ agentId: 'pi', event: 'hook', sessionId: 's-2', raw: 'tests passed' });
    expect(trigger.queued).toBe(true);
    await runtime.handle({ ...database.getJob(trigger.jobId)!, status: 'running', leaseOwner: 'test', leaseUntil: timestamp, attempts: 1, lastError: null, availableAt: timestamp });
    const distillJob = database.listJobs().find((job) => job.kind === 'distill.auto');
    expect(distillJob).toBeDefined();
    const payload = JSON.parse(distillJob?.payload ?? '{}') as { eventIds?: string[] };
    expect(payload.eventIds).toHaveLength(1);
    expect(payload.eventIds?.[0]).toBe(database.listEvidence()[0]?.id);
    database.close();
    await fixture.cleanup();
  });
});
