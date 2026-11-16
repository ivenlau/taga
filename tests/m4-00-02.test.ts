import { describe, expect, it } from 'vitest';
import {
  DistillationService,
  FakeDistiller,
  FallbackDistiller,
  InMemoryCandidateRepository,
  LlmDistiller,
  ShadowDistiller,
  proposeConsolidation,
  rankCandidates,
  type DistillationInput,
  type StructuredCompletionProvider,
} from '../packages/distillation/src/index.js';
import { normalizeEvidence } from '../packages/redaction/src/index.js';
import { FtsRetrievalProvider, ProgressiveRecallService, type SemanticRetriever } from '../packages/retrieval/src/index.js';
import { DatabaseStore, type MemoryIndexEntry } from '../packages/storage/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';
import type { Memory, Observation } from '../packages/domain/src/index.js';

const observation: Observation = {
  id: 'observation-m4',
  evidenceIds: ['evidence-m4'],
  projectId: 'project-m4',
  sessionId: 'session-m4',
  kind: 'problem',
  summary: 'Bounded retries fixed the transient network test failure',
  novelty: 0.8,
  reuse: 0.8,
  evidenceQuality: 0.9,
  sensitivityRisk: 0,
  createdAt: '2026-11-12T00:00:00.000Z',
};

const evidence = normalizeEvidence({
  id: 'evidence-m4',
  source: 'watcher',
  projectId: 'project-m4',
  sessionId: 'session-m4',
  raw: 'Use bounded retries; tests passed.',
  occurredAt: '2026-11-12T00:00:00.000Z',
  capturedAt: '2026-11-12T00:00:00.000Z',
  refs: [{ kind: 'test', locator: 'pnpm test' }],
}).event;

const input: DistillationInput = { observation, evidence: [evidence], verified: true };

class FixtureProvider implements StructuredCompletionProvider {
  constructor(private readonly output: string, private readonly delayMs = 0) {}

  async complete(): Promise<{ text: string; latencyMs: number }> {
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return { text: this.output, latencyMs: this.delayMs };
  }
}

function llmOutput(evidenceId = 'evidence-m4'): string {
  return JSON.stringify({
    memoryType: 'lessons',
    title: 'Bounded retries fix transient failures',
    summary: 'Use bounded retries for transient network failures.',
    body: 'Bound retries and verify the outcome with tests.',
    confidence: 0.92,
    facts: [{ text: 'Bounded retries fix transient network failures.', evidenceIds: [evidenceId], confidence: 0.9 }],
    entities: [{ name: 'pnpm test', type: 'test-command', evidenceIds: [evidenceId] }],
    temporalFacts: [],
    causalLinks: [],
    applicability: { conditions: ['transient network failures'], exclusions: [] },
  });
}

describe('M4 structured distillation', () => {
  it('creates a schema-validated LLM candidate with provenance', async () => {
    const provider = new LlmDistiller({
      provider: new FixtureProvider(llmOutput()),
      providerName: 'fixture-llm',
      model: 'fixture-model',
    });
    const candidate = await provider.distill(input);
    expect(candidate.memoryType).toBe('lessons');
    expect(candidate.facts?.[0]).toMatchObject({ text: 'Bounded retries fix transient network failures.', evidenceIds: ['evidence-m4'] });
    expect(candidate.model).toMatchObject({ provider: 'fixture-llm', mode: 'llm', schemaVersion: 'candidate-v2' });
  });

  it('rejects unsupported Evidence references from the model', async () => {
    const provider = new LlmDistiller({
      provider: new FixtureProvider(llmOutput('evidence-not-allowed')),
      providerName: 'fixture-llm',
      model: 'fixture-model',
    });
    await expect(provider.distill(input)).rejects.toThrow('unsupported evidence reference');
  });

  it('falls back deterministically and keeps shadow output out of persistence', async () => {
    const fallbackReasons: string[] = [];
    const fallback = new FallbackDistiller(
      new LlmDistiller({ provider: new FixtureProvider('{bad-json'), providerName: 'fixture-llm', model: 'fixture-model' }),
      new FakeDistiller(),
      (event) => fallbackReasons.push(event.reason),
    );
    const candidates = new InMemoryCandidateRepository();
    const candidate = await new DistillationService(fallback, candidates).createCandidate(input);
    expect(candidate?.model?.fallbackReason).toContain('JSON');
    expect(fallbackReasons).toHaveLength(1);

    const comparisons: unknown[] = [];
    const shadow = new ShadowDistiller(new FakeDistiller(), new LlmDistiller({ provider: new FixtureProvider(llmOutput()), providerName: 'fixture-llm', model: 'fixture-model' }), (comparison) => comparisons.push(comparison));
    const shadowCandidate = await shadow.distill(input);
    expect(shadowCandidate.model?.mode).toBe('deterministic');
    expect(comparisons).toHaveLength(1);
  });
});

function createMemory(id: string, title: string, body: string): Memory {
  return {
    schemaVersion: 1,
    id,
    type: 'lessons',
    scope: { kind: 'project', id: 'project-m4' },
    projectId: 'project-m4',
    status: 'active',
    title,
    summary: body,
    confidence: 0.8,
    sourceTrust: 'observed',
    visibility: 'private',
    created: '2026-11-12T00:00:00.000Z',
    updated: '2026-11-12T00:00:00.000Z',
    lastVerified: null,
    lastRecalled: null,
    reviewCount: 0,
    usefulCount: 0,
    notUsefulCount: 0,
    expiresAt: null,
    contentHash: `sha256:${id}`,
    sources: [{ kind: 'test', locator: 'm4.test.ts' }],
    anchors: [],
    tags: ['network'],
    supersedes: null,
  };
}

describe('M4 consolidation and candidate ranking', () => {
  it('creates source-preserving merge and conflict proposals', async () => {
    const first = await new DistillationService(new FakeDistiller(), new InMemoryCandidateRepository()).createCandidate(input);
    const second = await new DistillationService(new FakeDistiller(), new InMemoryCandidateRepository()).createCandidate({
      ...input,
      observation: { ...observation, id: 'observation-m4-2' },
      evidence: [{ ...evidence, id: 'evidence-m4-2' }],
    });
    const proposals = proposeConsolidation([first!, second!], '2026-11-12T01:00:00.000Z');
    expect(proposals[0]).toMatchObject({ kind: 'merge', evidenceIds: ['evidence-m4', 'evidence-m4-2'] });
    const ranked = rankCandidates([
      { candidate: first!, relevance: 0.6, freshness: 0.5, scope: 0.5, sourceTrust: 0.5 },
      { candidate: second!, relevance: 0.9, freshness: 0.5, scope: 0.5, sourceTrust: 0.5 },
    ]);
    expect(ranked[0]?.candidate.id).toBe(second!.id);
  });
});
describe('M4 hybrid and progressive retrieval', () => {
  it('fuses lexical and semantic candidates while preserving explanations', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(`${fixture.path}/taga.db`);
    const provider = new FtsRetrievalProvider(database);
    const exact = createMemory('memory-exact', 'Retry network request', 'Retry transient network failures.');
    const semantic = createMemory('memory-semantic', 'Backoff transient calls', 'Use bounded backoff for temporary failures.');
    provider.upsert(exact, 'retry network failure');
    provider.upsert(semantic, 'backoff temporary failure');
    const semanticEntry = provider.get('memory-semantic') as MemoryIndexEntry;
    const semanticRetriever: SemanticRetriever = { search: () => Promise.resolve([{ memory: semanticEntry, score: 0.96, matchReason: ['embedding:fixture'] }]) };

    const result = await provider.searchHybrid({ query: 'retry failure', scope: { kind: 'project', id: 'project-m4' }, limit: 10 }, semanticRetriever);
    expect(result.semanticAvailable).toBe(true);
    expect(result.items.map((item) => item.memory.id)).toContain('memory-semantic');
    expect(result.items.find((item) => item.memory.id === 'memory-semantic')?.matchReason).toContain('match:semantic');
    expect(result.items.find((item) => item.memory.id === 'memory-exact')?.matchReason).toContain('match:lexical');
    database.close();
    await fixture.cleanup();
  });

  it('falls back to FTS5 and bounds progressive detail fetches', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(`${fixture.path}/taga.db`);
    const provider = new FtsRetrievalProvider(database);
    const memory = createMemory('memory-progressive', 'Retry network request', '0123456789abcdef');
    provider.upsert(memory, '0123456789abcdef');
    const unavailable: SemanticRetriever = { search: () => Promise.reject(new Error('embedding unavailable')) };
    const hybrid = await provider.searchHybrid({ query: 'retry', limit: 1 }, unavailable);
    expect(hybrid.degraded).toBe(true);
    expect(hybrid.items[0]?.matchReason).toContain('semantic:unavailable');

    const progressive = new ProgressiveRecallService(provider);
    expect(progressive.index({ query: 'retry', limit: 1 })[0]).toMatchObject({ id: 'memory-progressive', title: 'Retry network request' });
    expect(progressive.timeline('memory-progressive', 1)).toHaveLength(1);
    expect(progressive.details(['memory-progressive'], 5)[0]).toMatchObject({ body: '01234', truncated: true, sources: ['test:m4.test.ts'] });
    database.close();
    await fixture.cleanup();
  });
});
