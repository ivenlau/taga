export type LlmMode = 'off' | 'shadow' | 'on';

export interface LlmConfig {
  /** Effective mode: resolved to 'off' when required fields are missing. */
  readonly mode: LlmMode;
  readonly endpoint: string;
  readonly apiKey?: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly providerName: string;
}

export function llmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const requested = env.TAGA_LLM_MODE;
  const requestedMode: LlmMode = requested === 'shadow' || requested === 'on' ? requested : 'off';
  const endpoint = env.TAGA_LLM_ENDPOINT ?? '';
  const model = env.TAGA_LLM_MODEL ?? '';
  const apiKey = env.TAGA_LLM_API_KEY;
  return {
    mode: requestedMode === 'off' || endpoint.length === 0 || model.length === 0 ? 'off' : requestedMode,
    endpoint,
    ...(apiKey === undefined || apiKey.length === 0 ? {} : { apiKey }),
    model,
    timeoutMs: positiveInt(env.TAGA_LLM_TIMEOUT_MS, 30_000),
    providerName: env.TAGA_LLM_PROVIDER_NAME ?? 'openai-compatible',
  };
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.length === 0) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && Number.isInteger(parsed) ? parsed : fallback;
}
