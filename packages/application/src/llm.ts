export type LlmMode = 'off' | 'shadow' | 'on';

/** Safe-by-default budget limits; raise via config to loosen, there is no "unlimited" sentinel. */
export const DEFAULT_LLM_DAILY_CALLS = 200;
export const DEFAULT_LLM_DAILY_TOKENS = 2_000_000;
export const DEFAULT_LLM_CONSUMER_SHARE = 0.8;

export interface LlmConfig {
  /** Effective mode: resolved to 'off' when required fields are missing. */
  readonly mode: LlmMode;
  readonly endpoint: string;
  readonly apiKey?: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly providerName: string;
  /** Maximum LLM calls per UTC day; beyond the cap callers fail over to local paths. */
  readonly dailyCap?: number;
  /** Maximum LLM input+output tokens per UTC day; beyond the budget callers fail over to local paths. */
  readonly dailyTokens?: number;
  /** Share of the daily budget a single consumer (distill/learn/reflect/consolidation) may consume; 1 disables the split. */
  readonly perConsumerShare?: number;
}

export interface LlmFileSection {
  readonly mode?: LlmMode | undefined;
  readonly endpoint?: string | undefined;
  readonly apiKey?: string | undefined;
  readonly model?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly providerName?: string | undefined;
  readonly dailyCap?: number | undefined;
  readonly dailyTokens?: number | undefined;
  readonly perConsumerShare?: number | undefined;
}

export function resolveLlmConfig(env: NodeJS.ProcessEnv = process.env, file?: LlmFileSection): LlmConfig {
  const requested = env.TAGA_LLM_MODE ?? file?.mode;
  const requestedMode: LlmMode = requested === 'shadow' || requested === 'on' ? requested : 'off';
  const endpoint = env.TAGA_LLM_ENDPOINT ?? file?.endpoint ?? '';
  const model = env.TAGA_LLM_MODEL ?? file?.model ?? '';
  const apiKey = env.TAGA_LLM_API_KEY ?? file?.apiKey;
  const dailyCap = positiveInt(env.TAGA_LLM_DAILY_CAP, file?.dailyCap ?? DEFAULT_LLM_DAILY_CALLS);
  const dailyTokens = positiveInt(env.TAGA_LLM_DAILY_TOKENS, file?.dailyTokens ?? DEFAULT_LLM_DAILY_TOKENS);
  const perConsumerShare = unitFloat(env.TAGA_LLM_PER_CONSUMER_SHARE, file?.perConsumerShare ?? DEFAULT_LLM_CONSUMER_SHARE);
  return {
    mode: requestedMode === 'off' || endpoint.length === 0 || model.length === 0 ? 'off' : requestedMode,
    endpoint,
    ...(apiKey === undefined || apiKey.length === 0 ? {} : { apiKey }),
    model,
    timeoutMs: positiveInt(env.TAGA_LLM_TIMEOUT_MS, file?.timeoutMs ?? 30_000),
    providerName: env.TAGA_LLM_PROVIDER_NAME ?? file?.providerName ?? 'openai-compatible',
    ...(dailyCap > 0 ? { dailyCap } : {}),
    ...(dailyTokens > 0 ? { dailyTokens } : {}),
    ...(perConsumerShare >= 0 && perConsumerShare <= 1 ? { perConsumerShare } : {}),
  };
}

/** Back-compat alias: env-only resolution. */
export function llmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  return resolveLlmConfig(env);
}

export interface ResolvedLlmSection {
  readonly mode: LlmMode;
  readonly endpoint: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly provider: string;
  readonly apiKey?: string;
  readonly dailyCap?: number;
  readonly dailyTokens?: number;
  readonly perConsumerShare?: number;
}

/** Maps a resolved app config llm section to the adapter-level LlmConfig in one place. */
export function llmConfigFromResolved(llm: ResolvedLlmSection): LlmConfig {
  return {
    mode: llm.mode,
    endpoint: llm.endpoint,
    model: llm.model,
    timeoutMs: llm.timeoutMs,
    providerName: llm.provider,
    ...(llm.apiKey === undefined ? {} : { apiKey: llm.apiKey }),
    ...(llm.dailyCap === undefined ? {} : { dailyCap: llm.dailyCap }),
    ...(llm.dailyTokens === undefined ? {} : { dailyTokens: llm.dailyTokens }),
    ...(llm.perConsumerShare === undefined ? {} : { perConsumerShare: llm.perConsumerShare }),
  };
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.length === 0) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && Number.isInteger(parsed) ? parsed : fallback;
}

function unitFloat(value: string | undefined, fallback: number): number {
  if (value === undefined || value.length === 0) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}
