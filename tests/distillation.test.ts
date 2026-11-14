import { describe, expect, it } from 'vitest';
import { DistillationService, FakeDistiller, InMemoryCandidateRepository, JsonCandidateRepository, ReviewService, evaluateGate } from '../packages/distillation/src/index.js';
import { InMemoryAuditLog, InMemoryMemoryRepository } from '../packages/application/src/index.js';
import { normalizeEvidence } from '../packages/redaction/src/index.js';
import type { Observation } from '../packages/domain/src/index.js';
import { join } from 'node:path';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';

function observation(): Observation {
  return {
    id: 'observation-1',
    evidenceIds: ['evidence-1'],
    kind: 'procedure',
    summary: 'Use bounded retries',
    novelty: 0.8,
    reuse: 0.8,
    evidenceQuality: 0.9,
    sensitivityRisk: 0,
    createdAt: '2026-11-10T00:00:00.000Z',
  };
}

describe('distillation and review', () => {
  it('rejects no-source input and creates reviewable candidates for valid evidence', async () => {
    const evidence = normalizeEvidence({ id: 'evidence-1', source: 'watcher', raw: 'Use bounded retries', occurredAt: '2026-11-10T00:00:00.000Z', capturedAt: '2026-11-10T00:00:00.000Z' }).event;
    expect(evaluateGate({ observation: { ...observation(), evidenceIds: [] }, evidence: [] }).accepted).toBe(false);
    const candidates = new InMemoryCandidateRepository();
    const service = new DistillationService(new FakeDistiller(), candidates);
    const candidate = await service.createCandidate({ observation: observation(), evidence: [evidence] });
    expect(candidate?.decision).toBe('pending');
    expect(candidate?.memoryType).toBe('procedures');
  });

  it('accepts only through review and creates active memory with evidence sources', async () => {
    const evidence = normalizeEvidence({ id: 'evidence-1', source: 'watcher', raw: 'Use bounded retries', occurredAt: '2026-11-10T00:00:00.000Z', capturedAt: '2026-11-10T00:00:00.000Z' }).event;
    const candidates = new InMemoryCandidateRepository();
    const candidate = await new DistillationService(new FakeDistiller(), candidates).createCandidate({ observation: observation(), evidence: [evidence] });
    const review = new ReviewService(candidates, new InMemoryMemoryRepository(), new InMemoryAuditLog(), () => new Date('2026-11-10T01:00:00.000Z'));
    const memory = await review.accept(candidate!.id, { actor: 'user' }, 'accept fixture');
    expect(memory.status).toBe('active');
    expect(review.list()).toHaveLength(0);
  });

  it('persists pending review candidates across repository instances', async () => {
    const fixture = await createTemporaryDirectory();
    const evidence = normalizeEvidence({ id: 'evidence-persistent', source: 'watcher', raw: 'Use bounded retries', occurredAt: '2026-11-10T00:00:00.000Z', capturedAt: '2026-11-10T00:00:00.000Z' }).event;
    const path = join(fixture.path, 'candidates.json');
    const first = new JsonCandidateRepository(path);
    const service = new DistillationService(new FakeDistiller(), first);
    const input = { observation: observation(), evidence: [{ ...evidence, id: 'evidence-persistent' }] };
    const candidate = await service.createCandidate(input);
    expect(candidate).not.toBeNull();
    expect(new JsonCandidateRepository(path).get(candidate!.id)?.decision).toBe('pending');
    expect((await service.createCandidate(input))?.id).toBe(candidate?.id);
    const review = new ReviewService(first, new InMemoryMemoryRepository(), new InMemoryAuditLog());
    expect(review.edit(candidate!.id, { title: 'Edited retry lesson' }).title).toBe('Edited retry lesson');
    await fixture.cleanup();
  });
});
