export type LlmMode = 'off' | 'shadow' | 'on';

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
}

export interface LlmFileSection {
  readonly mode?: LlmMode | undefined;
  readonly endpoint?: string | undefined;
  readonly apiKey?: string | undefined;
  readonly model?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly providerName?: string | undefined;
  readonly dailyCap?: number | undefined;
}

export function resolveLlmConfig(env: NodeJS.ProcessEnv = process.env, file?: LlmFileSection): LlmConfig {
  const requested = env.TAGA_LLM_MODE ?? file?.mode;
  const requestedMode: LlmMode = requested === 'shadow' || requested === 'on' ? requested : 'off';
  const endpoint = env.TAGA_LLM_ENDPOINT ?? file?.endpoint ?? '';
  const model = env.TAGA_LLM_MODEL ?? file?.model ?? '';
  const apiKey = env.TAGA_LLM_API_KEY ?? file?.apiKey;
  const dailyCap = positiveInt(env.TAGA_LLM_DAILY_CAP, file?.dailyCap ?? 0);
  return {
    mode: requestedMode === 'off' || endpoint.length === 0 || model.length === 0 ? 'off' : requestedMode,
    endpoint,
    ...(apiKey === undefined || apiKey.length === 0 ? {} : { apiKey }),
    model,
    timeoutMs: positiveInt(env.TAGA_LLM_TIMEOUT_MS, file?.timeoutMs ?? 30_000),
    providerName: env.TAGA_LLM_PROVIDER_NAME ?? file?.providerName ?? 'openai-compatible',
    ...(dailyCap > 0 ? { dailyCap } : {}),
  };
}

/** Back-compat alias: env-only resolution. */
export function llmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  return resolveLlmConfig(env);
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.length === 0) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && Number.isInteger(parsed) ? parsed : fallback;
}
