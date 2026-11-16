export type SemanticMode = 'off' | 'shadow' | 'on';

export interface SemanticFileSection {
  readonly mode?: SemanticMode | undefined;
  readonly modelPath?: string | undefined;
}

export interface SemanticConfig {
  readonly mode: SemanticMode;
  readonly modelPath: string;
}

function semanticModeValue(value: string | undefined, fallback: SemanticMode): SemanticMode {
  return value === 'shadow' || value === 'on' || value === 'off' ? value : fallback;
}

export function resolveSemanticConfig(env: NodeJS.ProcessEnv = process.env, file?: SemanticFileSection): SemanticConfig {
  return {
    mode: semanticModeValue(env.TAGA_SEMANTIC_MODE, file?.mode ?? 'off'),
    modelPath: env.TAGA_BGE_M3_MODEL_PATH ?? file?.modelPath ?? '',
  };
}
