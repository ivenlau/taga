import type { DatabaseStore } from '../../storage/src/index.js';
import type { ProactivePolicy } from './policy.js';
import { llmConfigFromEnv } from './llm.js';

export const CONSOLIDATION_JOB_KIND = 'consolidation.scan';

export interface ConsolidationLlmConfig {
  readonly endpoint: string;
  readonly apiKey?: string;
  readonly model: string;
  readonly timeoutMs: number;
}

export interface ConsolidationConfig {
  readonly enabled: boolean;
  readonly minUsefulCount: number;
  readonly maxNotUsefulCount: number;
  readonly rejectSimilarity: number;
  readonly mergeSimilarity: number;
  readonly scanIntervalMs: number;
  readonly llm: ConsolidationLlmConfig | undefined;
}

export function consolidationConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ConsolidationConfig {
  return {
    enabled: env.TAGA_CONSOLIDATION_MODE === 'on',
    minUsefulCount: positiveInt(env.TAGA_AUTO_PROMOTE_USEFUL_COUNT, 2),
    maxNotUsefulCount: positiveInt(env.TAGA_AUTO_PROMOTE_MAX_NOT_USEFUL, 2),
    rejectSimilarity: unitInterval(env.TAGA_DEDUP_REJECT_SIMILARITY, 0.95),
    mergeSimilarity: unitInterval(env.TAGA_DEDUP_MERGE_SIMILARITY, 0.88),
    scanIntervalMs: positiveInt(env.TAGA_CONSOLIDATION_SCAN_INTERVAL_MS, 600_000),
    llm: consolidationLlmConfigFromEnv(env),
  };
}

function consolidationLlmConfigFromEnv(env: NodeJS.ProcessEnv): ConsolidationLlmConfig | undefined {
  const config = llmConfigFromEnv(env);
  if (config.mode !== 'on') return undefined;
  return {
    endpoint: config.endpoint,
    ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
    model: config.model,
    timeoutMs: config.timeoutMs,
  };
}

export function consolidationPolicy(config: ConsolidationConfig): Partial<ProactivePolicy> {
  return {
    autoActivateFeedback: config.enabled,
    autoActivateMinUsefulCount: config.minUsefulCount,
  };
}

export function enqueueConsolidationScan(database: DatabaseStore, options?: { readonly bucketMs?: number; readonly now?: Date }): boolean {
  const bucketMs = options?.bucketMs ?? 60_000;
  const now = options?.now ?? new Date();
  return database.enqueueJobIfAbsent({
    id: `consolidation-scan-${Math.floor(now.getTime() / bucketMs)}`,
    kind: CONSOLIDATION_JOB_KIND,
    payload: '{}',
  });
}

export function enqueueScheduledConsolidationScan(database: DatabaseStore, config: ConsolidationConfig, now: Date): boolean {
  if (!config.enabled) return false;
  return database.enqueueJobIfAbsent({
    id: `consolidation-scan-scheduled-${Math.floor(now.getTime() / config.scanIntervalMs)}`,
    kind: CONSOLIDATION_JOB_KIND,
    payload: '{}',
  });
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.length === 0) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && Number.isInteger(parsed) ? parsed : fallback;
}

function unitInterval(value: string | undefined, fallback: number): number {
  if (value === undefined || value.length === 0) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}
