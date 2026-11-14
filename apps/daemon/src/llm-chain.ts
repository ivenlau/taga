import { randomUUID } from 'node:crypto';
import { llmConfigFromEnv, type AuditLog, type LlmConfig } from '../../../packages/application/src/index.js';
import {
  FallbackDistiller,
  FakeDistiller,
  LlmDistiller,
  ShadowDistiller,
  createLlmProvider,
  type Distiller,
  type StructuredCompletionProvider,
} from '../../../packages/distillation/src/index.js';

export interface DistillerChainOptions {
  readonly audit?: AuditLog;
  readonly llm?: LlmConfig;
  readonly provider?: StructuredCompletionProvider;
}

export function buildDistillerChain(options: DistillerChainOptions = {}): Distiller {
  const llm = options.llm ?? llmConfigFromEnv();
  const deterministic = new FakeDistiller('deterministic-auto', 'm3');
  if (llm.mode === 'off') return deterministic;
  const provider = options.provider ?? createLlmProvider(llm);
  if (provider === undefined) return deterministic;
  const llmDistiller = new LlmDistiller({
    provider,
    providerName: llm.providerName,
    model: llm.model,
    timeoutMs: llm.timeoutMs,
  });
  if (llm.mode === 'shadow') {
    return new ShadowDistiller(deterministic, llmDistiller, (comparison) => {
      void options.audit?.append({
        eventType: 'distill.llm_shadow',
        actor: 'daemon',
        subjectType: 'distillation',
        subjectId: `shadow-${randomUUID()}`,
        occurredAt: new Date().toISOString(),
        reason: comparison.error === undefined ? 'llm shadow comparison recorded' : 'llm shadow provider failed',
        payload: {
          deterministicTitle: comparison.deterministic.title,
          deterministicMode: comparison.deterministic.model?.mode,
          ...(comparison.shadow === null
            ? {}
            : { shadowTitle: comparison.shadow.title, shadowMode: comparison.shadow.model?.mode }),
          ...(comparison.error === undefined ? {} : { error: comparison.error }),
        },
      }).catch(() => undefined);
    });
  }
  if (llm.mode === 'on') {
    return new FallbackDistiller(llmDistiller, deterministic, (event) => {
      void options.audit?.append({
        eventType: 'distill.llm_fallback',
        actor: 'daemon',
        subjectType: 'distillation',
        subjectId: `fallback-${randomUUID()}`,
        occurredAt: new Date().toISOString(),
        reason: event.reason,
        payload: { provider: event.provider, model: event.model, evidenceCount: event.evidenceIds.length },
      }).catch(() => undefined);
    });
  }
  return deterministic;
}
