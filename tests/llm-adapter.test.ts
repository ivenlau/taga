import { describe, expect, it } from 'vitest';
import { InMemoryAuditLog, llmConfigFromEnv, type LlmConfig } from '../packages/application/src/index.js';
import {
  FetchOpenAiCompatibleProvider,
  createLlmProvider,
  type DistillationInput,
  type StructuredCompletionProvider,
} from '../packages/distillation/src/index.js';
import { buildDistillerChain } from '../apps/daemon/src/llm-chain.js';
import { normalizeEvidence } from '../packages/redaction/src/index.js';
import type { Observation } from '../packages/domain/src/index.js';

function llmConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    mode: 'on',
    endpoint: 'http://127.0.0.1:9/v1/chat/completions',
    model: 'fixture-model',
    timeoutMs: 1_000,
    providerName: 'fixture-llm',
    ...overrides,
  };
}

function failingProvider(): StructuredCompletionProvider {
  return {
    complete: () => Promise.reject(new Error('connection refused')),
  };
}

const observation: Observation = {
  id: 'observation-llm-adapter',
  evidenceIds: ['evidence-llm-adapter'],
  projectId: 'project-llm-adapter',
  sessionId: 'session-llm-adapter',
  kind: 'problem',
  summary: 'Bounded retries fixed the transient network test failure',
  novelty: 0.8,
  reuse: 0.8,
  evidenceQuality: 0.9,
  sensitivityRisk: 0,
  createdAt: '2026-11-14T00:00:00.000Z',
};

const input: DistillationInput = {
  observation,
  evidence: [normalizeEvidence({
    id: 'evidence-llm-adapter',
    source: 'watcher',
    projectId: 'project-llm-adapter',
    sessionId: 'session-llm-adapter',
    raw: 'Use bounded retries; tests passed.',
    occurredAt: '2026-11-14T00:00:00.000Z',
    capturedAt: '2026-11-14T00:00:00.000Z',
    refs: [{ kind: 'test', locator: 'pnpm test' }],
  }).event],
  verified: true,
};

function llmDraftOutput(evidenceId = 'evidence-llm-adapter'): string {
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

describe('llmConfigFromEnv', () => {
  it('defaults to off with all fields absent', () => {
    const config = llmConfigFromEnv({});
    expect(config.mode).toBe('off');
    expect(config.timeoutMs).toBe(30_000);
    expect(config.providerName).toBe('openai-compatible');
  });

  it('resolves on and shadow modes with endpoint and model', () => {
    expect(llmConfigFromEnv({ TAGA_LLM_MODE: 'on', TAGA_LLM_ENDPOINT: 'http://x', TAGA_LLM_MODEL: 'm' }).mode).toBe('on');
    expect(llmConfigFromEnv({ TAGA_LLM_MODE: 'shadow', TAGA_LLM_ENDPOINT: 'http://x', TAGA_LLM_MODEL: 'm' }).mode).toBe('shadow');
  });

  it('falls back to off when endpoint or model is missing, and parses numbers', () => {
    expect(llmConfigFromEnv({ TAGA_LLM_MODE: 'on', TAGA_LLM_MODEL: 'm' }).mode).toBe('off');
    expect(llmConfigFromEnv({ TAGA_LLM_MODE: 'on', TAGA_LLM_ENDPOINT: 'http://x' }).mode).toBe('off');
    const config = llmConfigFromEnv({ TAGA_LLM_MODE: 'on', TAGA_LLM_ENDPOINT: 'http://x', TAGA_LLM_MODEL: 'm', TAGA_LLM_TIMEOUT_MS: '5000', TAGA_LLM_PROVIDER_NAME: 'minimax', TAGA_LLM_API_KEY: 'k' });
    expect(config.timeoutMs).toBe(5_000);
    expect(config.providerName).toBe('minimax');
    expect(config.apiKey).toBe('k');
  });
});

describe('createLlmProvider', () => {
  it('returns undefined for off mode and a provider for on', () => {
    expect(createLlmProvider({ mode: 'off', endpoint: 'http://x' })).toBeUndefined();
    expect(createLlmProvider({ mode: 'on', endpoint: 'http://x' })).toBeDefined();
    expect(createLlmProvider({ mode: 'on', endpoint: '' })).toBeUndefined();
  });
});

describe('FetchOpenAiCompatibleProvider usage extraction', () => {
  it('maps OpenAI usage fields into token counts', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve(new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 11, completion_tokens: 7 },
    }), { status: 200 }));
    try {
      const provider = new FetchOpenAiCompatibleProvider({ endpoint: 'http://fixture/chat' });
      const response = await provider.complete({ system: 's', user: 'u', model: 'm', timeoutMs: 1_000 });
      expect(response.text).toBe('ok');
      expect(response.inputTokens).toBe(11);
      expect(response.outputTokens).toBe(7);
      expect(response.latencyMs).toBeGreaterThanOrEqual(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('buildDistillerChain', () => {
  it('returns the deterministic distiller in off mode even when a provider is supplied', async () => {
    const chain = buildDistillerChain({ llm: llmConfig({ mode: 'off' }), provider: failingProvider() });
    const candidate = await chain.distill(input);
    expect(candidate.model?.mode).toBe('deterministic');
    expect(candidate.model?.provider).toBe('deterministic-auto');
  });

  it('keeps deterministic output in shadow mode and records the comparison audit', async () => {
    const audit = new InMemoryAuditLog();
    const chain = buildDistillerChain({ audit, llm: llmConfig({ mode: 'shadow' }), provider: failingProvider() });
    const candidate = await chain.distill(input);
    expect(candidate.model?.mode).toBe('deterministic');
    const events = await audit.list();
    const shadow = events.find((event) => event.eventType === 'distill.llm_shadow');
    expect(shadow).toBeDefined();
    expect(shadow?.payload).toMatchObject({ error: 'connection refused' });
  });

  it('falls back with a reason and audit event when the llm provider fails in on mode', async () => {
    const audit = new InMemoryAuditLog();
    const chain = buildDistillerChain({ audit, llm: llmConfig({ mode: 'on' }), provider: failingProvider() });
    const candidate = await chain.distill(input);
    expect(candidate.model?.mode).toBe('deterministic');
    expect(candidate.model?.fallbackReason).toBe('connection refused');
    const events = await audit.list();
    const fallback = events.find((event) => event.eventType === 'distill.llm_fallback');
    expect(fallback).toBeDefined();
    expect(fallback?.reason).toBe('connection refused');
  });

  it('produces an llm-mode candidate when the provider succeeds in on mode', async () => {
    const provider: StructuredCompletionProvider = {
      complete: () => Promise.resolve({ text: llmDraftOutput(), inputTokens: 42, outputTokens: 13, latencyMs: 5 }),
    };
    const chain = buildDistillerChain({ llm: llmConfig({ mode: 'on' }), provider });
    const candidate = await chain.distill(input);
    expect(candidate.model?.mode).toBe('llm');
    expect(candidate.model?.provider).toBe('fixture-llm');
    expect(candidate.model?.model).toBe('fixture-model');
    expect(candidate.model?.inputTokens).toBe(42);
    expect(candidate.title).toBe('Bounded retries fix transient failures');
  });
});
