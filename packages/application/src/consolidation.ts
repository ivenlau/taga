import type { DatabaseStore } from '../../storage/src/index.js';
import type { ProactivePolicy } from './policy.js';
import { resolveLlmConfig, type LlmFileSection } from './llm.js';

export const CONSOLIDATION_JOB_KIND = 'consolidation.scan';

export interface ConsolidationLlmConfig {
  readonly endpoint: string;
  readonly apiKey?: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly dailyCap?: number;
  readonly dailyTokens?: number;
  readonly perConsumerShare?: number;
}

export interface ConsolidationFileSection {
  readonly mode?: 'off' | 'on' | undefined;
  readonly minUsefulCount?: number | undefined;
  readonly maxNotUsefulCount?: number | undefined;
  readonly rejectSimilarity?: number | undefined;
  readonly mergeSimilarity?: number | undefined;
  readonly scanIntervalMs?: number | undefined;
  readonly llm?: LlmFileSection | undefined;
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

function modeValue(envValue: string | undefined, fileValue: 'off' | 'on' | undefined, fallback: 'off' | 'on'): 'off' | 'on' {
  if (envValue === 'on' || envValue === 'off') return envValue;
  return fileValue ?? fallback;
}

export function resolveConsolidationConfig(env: NodeJS.ProcessEnv = process.env, file?: ConsolidationFileSection): ConsolidationConfig {
  return {
    enabled: modeValue(env.TAGA_CONSOLIDATION_MODE, file?.mode, 'off') === 'on',
    minUsefulCount: positiveInt(env.TAGA_AUTO_PROMOTE_USEFUL_COUNT, file?.minUsefulCount ?? 2),
    maxNotUsefulCount: positiveInt(env.TAGA_AUTO_PROMOTE_MAX_NOT_USEFUL, file?.maxNotUsefulCount ?? 2),
    rejectSimilarity: unitInterval(env.TAGA_DEDUP_REJECT_SIMILARITY, file?.rejectSimilarity ?? 0.95),
    mergeSimilarity: unitInterval(env.TAGA_DEDUP_MERGE_SIMILARITY, file?.mergeSimilarity ?? 0.88),
    scanIntervalMs: positiveInt(env.TAGA_CONSOLIDATION_SCAN_INTERVAL_MS, file?.scanIntervalMs ?? 600_000),
    llm: consolidationLlmFromLayers(env, file?.llm),
  };
}

function consolidationLlmFromLayers(env: NodeJS.ProcessEnv, file?: LlmFileSection): ConsolidationLlmConfig | undefined {
  const config = resolveLlmConfig(env, file);
  if (config.mode !== 'on') return undefined;
  return {
    endpoint: config.endpoint,
    ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
    model: config.model,
    timeoutMs: config.timeoutMs,
    ...(config.dailyCap === undefined ? {} : { dailyCap: config.dailyCap }),
    ...(config.dailyTokens === undefined ? {} : { dailyTokens: config.dailyTokens }),
    ...(config.perConsumerShare === undefined ? {} : { perConsumerShare: config.perConsumerShare }),
  };
}

/** Back-compat alias: env-only resolution. */
export function consolidationConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ConsolidationConfig {
  return resolveConsolidationConfig(env);
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
