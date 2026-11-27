import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, resolve, win32 } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import {
  DEFAULT_LLM_CONSUMER_SHARE,
  DEFAULT_LLM_DAILY_CALLS,
  DEFAULT_LLM_DAILY_TOKENS,
} from '../../application/src/llm.js';

export type FeatureMode = 'off' | 'shadow' | 'on';
export type ConfigSource = 'override' | 'environment' | 'file' | 'default';

const featureModeSchema = z.enum(['off', 'shadow', 'on']);
const nonEmptyString = z.string().min(1);

const pathsFileSchema = z.object({
  brain: nonEmptyString.optional(),
}).strict();

const pathsFileV3Schema = z.object({
  brain: nonEmptyString.optional(),
  project: nonEmptyString.optional(),
}).strict();

const projectResolutionFileSchema = z.object({
  mode: z.literal('auto').optional(),
  preferGitRoot: z.boolean().optional(),
  preferGitRemote: z.boolean().optional(),
  markerFile: nonEmptyString.optional(),
  unknownProjectPolicy: z.literal('global-only').optional(),
}).strict();

const agentsFileSchema = z.object({
  enabled: z.array(nonEmptyString).optional(),
  writeInstructions: z.boolean().optional(),
}).strict();

const semanticFileSchema = z.object({
  mode: featureModeSchema.optional(),
  modelPath: nonEmptyString.optional(),
}).strict();

const retrievalFileSchema = z.object({
  semantic: semanticFileSchema.optional(),
}).strict();

const llmFileSchema = z.object({
  mode: featureModeSchema.optional(),
  provider: nonEmptyString.optional(),
  endpoint: nonEmptyString.optional(),
  model: nonEmptyString.optional(),
  timeoutMs: z.number().int().positive().optional(),
  dailyCap: z.number().int().positive().optional(),
  dailyTokens: z.number().int().positive().optional(),
  perConsumerShare: z.number().min(0).max(1).optional(),
}).strict();

const promotionFileSchema = z.object({
  minUsefulCount: z.number().int().positive().optional(),
  maxNotUsefulCount: z.number().int().positive().optional(),
}).strict();

const deduplicationFileSchema = z.object({
  rejectSimilarity: z.number().min(0).max(1).optional(),
  mergeSimilarity: z.number().min(0).max(1).optional(),
}).strict();

const consolidationFileSchema = z.object({
  enabled: z.boolean().optional(),
  scanIntervalMs: z.number().int().positive().optional(),
  promotion: promotionFileSchema.optional(),
  deduplication: deduplicationFileSchema.optional(),
}).strict();

const learningFileSchema = z.object({
  allowNetwork: z.boolean().optional(),
}).strict();

const collectionFileSchema = z.object({
  lookbackDays: z.number().int().positive().optional(),
}).strict();

const reflectionFileSchema = z.object({
  enabled: z.boolean().optional(),
  intervalMs: z.number().int().positive().optional(),
  windowDays: z.number().int().positive().optional(),
  minGroupSize: z.number().int().positive().optional(),
  maxGroups: z.number().int().positive().optional(),
}).strict();

export const configFileV3Schema = z.object({
  schemaVersion: z.literal(3),
  paths: pathsFileV3Schema.optional(),
  agents: agentsFileSchema.optional(),
  retrieval: retrievalFileSchema.optional(),
  llm: llmFileSchema.optional(),
  consolidation: consolidationFileSchema.optional(),
  learning: learningFileSchema.optional(),
  reflection: reflectionFileSchema.optional(),
}).strict();

export type ConfigFileV3 = z.infer<typeof configFileV3Schema>;

export const configFileV4Schema = z.object({
  schemaVersion: z.literal(4),
  paths: pathsFileSchema.optional(),
  agents: agentsFileSchema.optional(),
  projectResolution: projectResolutionFileSchema.optional(),
  retrieval: retrievalFileSchema.optional(),
  llm: llmFileSchema.optional(),
  consolidation: consolidationFileSchema.optional(),
  learning: learningFileSchema.optional(),
  collection: collectionFileSchema.optional(),
  reflection: reflectionFileSchema.optional(),
}).strict();

export type ConfigFileV4 = z.infer<typeof configFileV4Schema>;

const legacyAgentSchema = z.object({
  id: nonEmptyString,
  kind: nonEmptyString.optional(),
  configPath: nonEmptyString.optional(),
  targetPath: nonEmptyString.optional(),
  targetPaths: z.array(nonEmptyString).optional(),
}).passthrough();

const legacyLlmSchema = z.object({
  mode: featureModeSchema.optional(),
  endpoint: nonEmptyString.optional(),
  apiKey: nonEmptyString.optional(),
  model: nonEmptyString.optional(),
  timeoutMs: z.number().int().positive().optional(),
  providerName: nonEmptyString.optional(),
  dailyCap: z.number().int().positive().optional(),
  dailyTokens: z.number().int().positive().optional(),
  perConsumerShare: z.number().min(0).max(1).optional(),
}).passthrough();

const legacyConfigSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  brainPath: nonEmptyString,
  projectPath: nonEmptyString,
  projectId: nonEmptyString.optional(),
  agents: z.array(legacyAgentSchema).default([]),
  remoteModelAllowed: z.boolean().optional(),
  semantic: z.object({
    mode: featureModeSchema.optional(),
    modelPath: nonEmptyString.optional(),
  }).passthrough().optional(),
  consolidation: z.object({
    mode: z.enum(['off', 'on']).optional(),
    minUsefulCount: z.number().int().positive().optional(),
    maxNotUsefulCount: z.number().int().positive().optional(),
    rejectSimilarity: z.number().min(0).max(1).optional(),
    mergeSimilarity: z.number().min(0).max(1).optional(),
    scanIntervalMs: z.number().int().positive().optional(),
    llm: legacyLlmSchema.optional(),
  }).passthrough().optional(),
  learn: z.object({ allowNetwork: z.boolean().optional() }).passthrough().optional(),
  reflect: z.object({
    mode: z.enum(['off', 'on']).optional(),
    intervalMs: z.number().int().positive().optional(),
    windowDays: z.number().int().positive().optional(),
    minGroupSize: z.number().int().positive().optional(),
    maxGroups: z.number().int().positive().optional(),
  }).passthrough().optional(),
  llm: legacyLlmSchema.optional(),
}).passthrough();

export interface ResolvedConfig {
  readonly schemaVersion: 4;
  readonly paths: {
    readonly brain: string;
  };
  readonly agents: {
    readonly enabled: readonly string[];
    readonly writeInstructions: boolean;
  };
  readonly projectResolution: {
    readonly mode: 'auto';
    readonly preferGitRoot: boolean;
    readonly preferGitRemote: boolean;
    readonly markerFile: string;
    readonly unknownProjectPolicy: 'global-only';
  };
  readonly retrieval: {
    readonly semantic: {
      readonly mode: FeatureMode;
      readonly modelPath: string;
    };
  };
  readonly llm: {
    readonly mode: FeatureMode;
    readonly provider: string;
    readonly endpoint: string;
    readonly model: string;
    readonly timeoutMs: number;
    readonly dailyCap?: number;
    readonly dailyTokens?: number;
    readonly perConsumerShare?: number;
    readonly apiKey?: string;
  };
  readonly consolidation: {
    readonly enabled: boolean;
    readonly scanIntervalMs: number;
    readonly promotion: {
      readonly minUsefulCount: number;
      readonly maxNotUsefulCount: number;
    };
    readonly deduplication: {
      readonly rejectSimilarity: number;
      readonly mergeSimilarity: number;
    };
  };
  readonly learning: {
    readonly allowNetwork: boolean;
  };
  readonly collection: {
    /** Records older than this many days are skipped by ingestion (cursor still advances). */
    readonly lookbackDays: number;
  };
  readonly reflection: {
    readonly enabled: boolean;
    readonly intervalMs: number;
    readonly windowDays: number;
    readonly minGroupSize: number;
    readonly maxGroups: number;
  };
}

export interface ConfigOverrides {
  readonly paths?: { readonly brain?: string };
  readonly agents?: { readonly enabled?: readonly string[]; readonly writeInstructions?: boolean };
  readonly projectResolution?: { readonly mode?: 'auto'; readonly preferGitRoot?: boolean; readonly preferGitRemote?: boolean; readonly markerFile?: string; readonly unknownProjectPolicy?: 'global-only' };
  readonly retrieval?: {
    readonly semantic?: { readonly mode?: FeatureMode; readonly modelPath?: string };
  };
  readonly llm?: { readonly mode?: FeatureMode; readonly provider?: string; readonly endpoint?: string; readonly model?: string; readonly timeoutMs?: number; readonly dailyCap?: number; readonly dailyTokens?: number; readonly perConsumerShare?: number };
  readonly consolidation?: {
    readonly enabled?: boolean;
    readonly scanIntervalMs?: number;
    readonly promotion?: { readonly minUsefulCount?: number; readonly maxNotUsefulCount?: number };
    readonly deduplication?: { readonly rejectSimilarity?: number; readonly mergeSimilarity?: number };
  };
  readonly learning?: { readonly allowNetwork?: boolean };
  readonly collection?: { readonly lookbackDays?: number };
  readonly reflection?: { readonly enabled?: boolean; readonly intervalMs?: number; readonly windowDays?: number; readonly minGroupSize?: number; readonly maxGroups?: number };
}

export interface LoadConfigOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly configPath?: string;
  readonly isolatedBrainPath?: string;
  readonly overrides?: ConfigOverrides;
}

export interface LoadedConfig {
  readonly config: ResolvedConfig;
  readonly configPath: string;
  readonly loadedFrom: string | null;
  readonly legacy: boolean;
  readonly warnings: readonly string[];
  readonly sources: Readonly<Record<string, ConfigSource>>;
  readonly file: ConfigFileV4 | null;
}

export class ConfigurationError extends Error {
  constructor(message: string, readonly issues: readonly string[] = []) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  if (platform === 'win32') return win32.join(env.APPDATA ?? win32.join(home, 'AppData', 'Roaming'), 'taga', 'config.yaml');
  if (platform === 'darwin') return posix.join(home, 'Library', 'Application Support', 'taga', 'config.yaml');
  return posix.join(env.XDG_CONFIG_HOME ?? posix.join(home, '.config'), 'taga', 'config.yaml');
}

export function resolveConfigPath(options: LoadConfigOptions = {}): string {
  const env = options.env ?? process.env;
  const cwd = resolve(options.cwd ?? process.cwd());
  const requested = options.configPath ?? env.TAGA_CONFIG;
  if (requested !== undefined && requested.length > 0) return resolvePath(cwd, requested);
  if (options.isolatedBrainPath !== undefined) return join(resolvePath(cwd, options.isolatedBrainPath), 'config.yaml');
  return defaultConfigPath(env, options.platform ?? process.platform);
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const env = options.env ?? process.env;
  const cwd = resolve(options.cwd ?? process.cwd());
  const configPath = resolveConfigPath({ ...options, cwd, env });
  const defaultBrain = defaultBrainPath(env);
  const legacyBrain = resolvePath(cwd, options.isolatedBrainPath ?? env.TAGA_BRAIN ?? defaultBrain);
  const legacyPath = join(legacyBrain, '_config.yaml');
  const primary = await readOptional(configPath);
  const legacyRaw = primary === null ? await readOptional(legacyPath) : null;
  const loadedFrom = primary === null ? (legacyRaw === null ? null : legacyPath) : configPath;
  const parsed = parseConfigText(primary ?? legacyRaw, loadedFrom ?? 'configuration');
  const defaults = createDefaultConfig(cwd, defaultBrain);
  const resolved = resolveLayers(defaults, parsed.file, env, options.overrides ?? {}, cwd, loadedFrom === null ? cwd : dirname(loadedFrom));
  validateResolved(resolved.config);
  return {
    config: resolved.config,
    configPath,
    loadedFrom,
    legacy: parsed.legacy,
    warnings: parsed.warnings,
    sources: resolved.sources,
    file: parsed.file,
  };
}

export function parseConfigText(raw: string | null, source = 'configuration'): { readonly file: ConfigFileV4 | null; readonly legacy: boolean; readonly warnings: readonly string[] } {
  if (raw === null) return { file: null, legacy: false, warnings: [] };
  let value: unknown;
  try {
    value = parseYaml(raw);
  } catch (error) {
    throw new ConfigurationError(`${source} is not valid YAML`, [error instanceof Error ? error.message : String(error)]);
  }
  const v4 = configFileV4Schema.safeParse(value);
  if (v4.success) return { file: v4.data, legacy: false, warnings: [] };
  const v3 = configFileV3Schema.safeParse(value);
  if (v3.success) return { file: migrateV3Config(v3.data), legacy: true, warnings: ['schemaVersion 3 is deprecated; paths.project is ignored at runtime; run taga config migrate --write'] };
  const legacy = legacyConfigSchema.safeParse(value);
  if (legacy.success) {
    const migrated = migrateLegacyConfig(legacy.data);
    return { file: migrated.file, legacy: true, warnings: migrated.warnings };
  }
  throw new ConfigurationError(`${source} failed configuration validation`, formatIssues(v4.error));
}

export function migrateLegacyConfig(legacy: z.infer<typeof legacyConfigSchema>): { readonly file: ConfigFileV4; readonly warnings: readonly string[] } {
  const warnings = [`schemaVersion ${legacy.schemaVersion} is deprecated; run taga config migrate --write`];
  const legacyLlm = legacy.llm ?? legacy.consolidation?.llm;
  if (legacy.llm?.apiKey !== undefined || legacy.consolidation?.llm?.apiKey !== undefined) {
    warnings.push('legacy llm.apiKey was ignored; set TAGA_LLM_API_KEY instead');
  }
  if (legacy.consolidation?.llm !== undefined) {
    warnings.push(legacy.llm === undefined
      ? 'legacy consolidation.llm was moved to llm'
      : 'legacy consolidation.llm was ignored because top-level llm takes precedence');
  }
  if (legacy.remoteModelAllowed !== undefined) warnings.push('legacy remoteModelAllowed is no longer used');
  return {
    file: {
      schemaVersion: 4,
      paths: { brain: legacy.brainPath },
      agents: { enabled: legacy.agents.map((agent) => agent.id), writeInstructions: true },
      retrieval: {
        semantic: {
          ...(legacy.semantic?.mode === undefined ? {} : { mode: legacy.semantic.mode }),
          ...(legacy.semantic?.modelPath === undefined ? {} : { modelPath: legacy.semantic.modelPath }),
        },
      },
      ...(legacyLlm === undefined ? {} : {
        llm: {
          ...(legacyLlm.mode === undefined ? {} : { mode: legacyLlm.mode }),
          ...(legacyLlm.providerName === undefined ? {} : { provider: legacyLlm.providerName }),
          ...(legacyLlm.endpoint === undefined ? {} : { endpoint: legacyLlm.endpoint }),
          ...(legacyLlm.model === undefined ? {} : { model: legacyLlm.model }),
          ...(legacyLlm.timeoutMs === undefined ? {} : { timeoutMs: legacyLlm.timeoutMs }),
          ...(legacyLlm.dailyCap === undefined ? {} : { dailyCap: legacyLlm.dailyCap }),
          ...(legacyLlm.dailyTokens === undefined ? {} : { dailyTokens: legacyLlm.dailyTokens }),
          ...(legacyLlm.perConsumerShare === undefined ? {} : { perConsumerShare: legacyLlm.perConsumerShare }),
        },
      }),
      ...(legacy.consolidation === undefined ? {} : {
        consolidation: {
          ...(legacy.consolidation.mode === undefined ? {} : { enabled: legacy.consolidation.mode === 'on' }),
          ...(legacy.consolidation.scanIntervalMs === undefined ? {} : { scanIntervalMs: legacy.consolidation.scanIntervalMs }),
          promotion: {
            ...(legacy.consolidation.minUsefulCount === undefined ? {} : { minUsefulCount: legacy.consolidation.minUsefulCount }),
            ...(legacy.consolidation.maxNotUsefulCount === undefined ? {} : { maxNotUsefulCount: legacy.consolidation.maxNotUsefulCount }),
          },
          deduplication: {
            ...(legacy.consolidation.rejectSimilarity === undefined ? {} : { rejectSimilarity: legacy.consolidation.rejectSimilarity }),
            ...(legacy.consolidation.mergeSimilarity === undefined ? {} : { mergeSimilarity: legacy.consolidation.mergeSimilarity }),
          },
        },
      }),
      ...(legacy.learn === undefined ? {} : { learning: { ...(legacy.learn.allowNetwork === undefined ? {} : { allowNetwork: legacy.learn.allowNetwork }) } }),
      ...(legacy.reflect === undefined ? {} : {
        reflection: {
          ...(legacy.reflect.mode === undefined ? {} : { enabled: legacy.reflect.mode === 'on' }),
          ...(legacy.reflect.intervalMs === undefined ? {} : { intervalMs: legacy.reflect.intervalMs }),
          ...(legacy.reflect.windowDays === undefined ? {} : { windowDays: legacy.reflect.windowDays }),
          ...(legacy.reflect.minGroupSize === undefined ? {} : { minGroupSize: legacy.reflect.minGroupSize }),
          ...(legacy.reflect.maxGroups === undefined ? {} : { maxGroups: legacy.reflect.maxGroups }),
        },
      }),
    },
    warnings,
  };
}

function migrateV3Config(config: ConfigFileV3): ConfigFileV4 {
  return {
    schemaVersion: 4,
    ...(config.paths?.brain === undefined ? {} : { paths: { brain: config.paths.brain } }),
    ...(config.agents === undefined ? {} : { agents: config.agents }),
    ...(config.retrieval === undefined ? {} : { retrieval: config.retrieval }),
    ...(config.llm === undefined ? {} : { llm: config.llm }),
    ...(config.consolidation === undefined ? {} : { consolidation: config.consolidation }),
    ...(config.learning === undefined ? {} : { learning: config.learning }),
    ...(config.reflection === undefined ? {} : { reflection: config.reflection }),
  };
}

export function configFileFromResolved(config: ResolvedConfig): ConfigFileV4 {
  return {
    schemaVersion: 4,
    paths: { brain: config.paths.brain },
    agents: { enabled: [...config.agents.enabled], writeInstructions: config.agents.writeInstructions },
    projectResolution: { ...config.projectResolution },
    retrieval: {
      semantic: { mode: config.retrieval.semantic.mode, ...(config.retrieval.semantic.modelPath.length === 0 ? {} : { modelPath: config.retrieval.semantic.modelPath }) },
    },
    llm: {
      mode: config.llm.mode,
      provider: config.llm.provider,
      ...(config.llm.endpoint.length === 0 ? {} : { endpoint: config.llm.endpoint }),
      ...(config.llm.model.length === 0 ? {} : { model: config.llm.model }),
      timeoutMs: config.llm.timeoutMs,
      ...(config.llm.dailyCap === undefined ? {} : { dailyCap: config.llm.dailyCap }),
    },
    consolidation: {
      enabled: config.consolidation.enabled,
      scanIntervalMs: config.consolidation.scanIntervalMs,
      promotion: { ...config.consolidation.promotion },
      deduplication: { ...config.consolidation.deduplication },
    },
    learning: { allowNetwork: config.learning.allowNetwork },
    collection: { lookbackDays: config.collection.lookbackDays },
    reflection: { ...config.reflection },
  };
}

export function stringifyConfig(file: ConfigFileV4): string {
  return stringifyYaml(file, { collectionStyle: 'block', lineWidth: 0 });
}

export function redactedConfig(config: ResolvedConfig): Omit<ResolvedConfig, 'llm'> & { readonly llm: Omit<ResolvedConfig['llm'], 'apiKey'> & { readonly apiKey?: string } } {
  return {
    ...config,
    llm: {
      mode: config.llm.mode,
      provider: config.llm.provider,
      endpoint: config.llm.endpoint,
      model: config.llm.model,
      timeoutMs: config.llm.timeoutMs,
      ...(config.llm.dailyCap === undefined ? {} : { dailyCap: config.llm.dailyCap }),
      ...(config.llm.dailyTokens === undefined ? {} : { dailyTokens: config.llm.dailyTokens }),
      ...(config.llm.perConsumerShare === undefined ? {} : { perConsumerShare: config.llm.perConsumerShare }),
      ...(config.llm.apiKey === undefined ? {} : { apiKey: '[redacted]' }),
    },
  };
}

export function configDirectory(path: string): string {
  return dirname(path);
}

export function createDefaultConfig(cwd: string = resolve(process.cwd()), brain: string = defaultBrainPath(process.env)): ResolvedConfig {
  void cwd;
  return {
    schemaVersion: 4,
    paths: { brain },
    agents: { enabled: [], writeInstructions: false },
    projectResolution: {
      mode: 'auto',
      preferGitRoot: true,
      preferGitRemote: true,
      markerFile: join('.taga', 'project.yaml'),
      unknownProjectPolicy: 'global-only',
    },
    retrieval: {
      semantic: { mode: 'off', modelPath: '' },
    },
    llm: {
      mode: 'off',
      provider: 'openai-compatible',
      endpoint: '',
      model: '',
      timeoutMs: 30_000,
      // Safe-by-default budget limits (single source of truth: application/llm.ts).
      dailyCap: DEFAULT_LLM_DAILY_CALLS,
      dailyTokens: DEFAULT_LLM_DAILY_TOKENS,
      perConsumerShare: DEFAULT_LLM_CONSUMER_SHARE,
    },
    consolidation: {
      enabled: false,
      scanIntervalMs: 600_000,
      promotion: { minUsefulCount: 2, maxNotUsefulCount: 2 },
      deduplication: { rejectSimilarity: 0.95, mergeSimilarity: 0.88 },
    },
    learning: { allowNetwork: false },
    collection: { lookbackDays: 7 },
    reflection: { enabled: false, intervalMs: 7 * 24 * 60 * 60 * 1000, windowDays: 7, minGroupSize: 3, maxGroups: 5 },
  };
}

function resolveLayers(defaults: ResolvedConfig, file: ConfigFileV4 | null, env: NodeJS.ProcessEnv, overrides: ConfigOverrides, cwd: string, fileBase: string): { readonly config: ResolvedConfig; readonly sources: Readonly<Record<string, ConfigSource>> } {
  const sources: Record<string, ConfigSource> = {};
  const pick = <T>(path: string, overrideValue: T | undefined, envValue: T | undefined, fileValue: T | undefined, defaultValue: T): T => {
    if (overrideValue !== undefined) { sources[path] = 'override'; return overrideValue; }
    if (envValue !== undefined) { sources[path] = 'environment'; return envValue; }
    if (fileValue !== undefined) { sources[path] = 'file'; return fileValue; }
    sources[path] = 'default';
    return defaultValue;
  };
  const brain = resolveLayeredPath('paths.brain', pick('paths.brain', overrides.paths?.brain, optionalString(env, 'TAGA_BRAIN'), file?.paths?.brain, defaults.paths.brain), sources, cwd, fileBase);
  const dailyCap = pick('llm.dailyCap', overrides.llm?.dailyCap, optionalPositiveInt(env, 'TAGA_LLM_DAILY_CAP'), file?.llm?.dailyCap, defaults.llm.dailyCap ?? DEFAULT_LLM_DAILY_CALLS);
  const dailyTokens = pick('llm.dailyTokens', overrides.llm?.dailyTokens, optionalPositiveInt(env, 'TAGA_LLM_DAILY_TOKENS'), file?.llm?.dailyTokens, defaults.llm.dailyTokens ?? DEFAULT_LLM_DAILY_TOKENS);
  const perConsumerShare = pick('llm.perConsumerShare', overrides.llm?.perConsumerShare, optionalUnitInterval(env, 'TAGA_LLM_PER_CONSUMER_SHARE'), file?.llm?.perConsumerShare, defaults.llm.perConsumerShare ?? DEFAULT_LLM_CONSUMER_SHARE);
  const apiKey = optionalSecret(env, 'TAGA_LLM_API_KEY');
  if (apiKey !== undefined) sources['llm.apiKey'] = 'environment';
  const config: ResolvedConfig = {
    schemaVersion: 4,
    paths: { brain },
    agents: {
      enabled: pick('agents.enabled', overrides.agents?.enabled, undefined, file?.agents?.enabled, defaults.agents.enabled),
      writeInstructions: pick('agents.writeInstructions', overrides.agents?.writeInstructions, undefined, file?.agents?.writeInstructions, defaults.agents.writeInstructions),
    },
    projectResolution: {
      mode: pick('projectResolution.mode', overrides.projectResolution?.mode, undefined, file?.projectResolution?.mode, defaults.projectResolution.mode),
      preferGitRoot: pick('projectResolution.preferGitRoot', overrides.projectResolution?.preferGitRoot, optionalBoolean(env, 'TAGA_PROJECT_PREFER_GIT_ROOT'), file?.projectResolution?.preferGitRoot, defaults.projectResolution.preferGitRoot),
      preferGitRemote: pick('projectResolution.preferGitRemote', overrides.projectResolution?.preferGitRemote, optionalBoolean(env, 'TAGA_PROJECT_PREFER_GIT_REMOTE'), file?.projectResolution?.preferGitRemote, defaults.projectResolution.preferGitRemote),
      markerFile: pick('projectResolution.markerFile', overrides.projectResolution?.markerFile, optionalString(env, 'TAGA_PROJECT_MARKER_FILE'), file?.projectResolution?.markerFile, defaults.projectResolution.markerFile),
      unknownProjectPolicy: pick('projectResolution.unknownProjectPolicy', overrides.projectResolution?.unknownProjectPolicy, undefined, file?.projectResolution?.unknownProjectPolicy, defaults.projectResolution.unknownProjectPolicy),
    },
    retrieval: {
      semantic: {
        mode: pick('retrieval.semantic.mode', overrides.retrieval?.semantic?.mode, optionalMode(env, 'TAGA_SEMANTIC_MODE'), file?.retrieval?.semantic?.mode, defaults.retrieval.semantic.mode),
        modelPath: resolveLayeredOptionalPath('retrieval.semantic.modelPath', pick('retrieval.semantic.modelPath', overrides.retrieval?.semantic?.modelPath, optionalString(env, 'TAGA_BGE_M3_MODEL_PATH'), file?.retrieval?.semantic?.modelPath, defaults.retrieval.semantic.modelPath), sources, cwd, fileBase),
      },
    },
    llm: {
      mode: pick('llm.mode', overrides.llm?.mode, optionalMode(env, 'TAGA_LLM_MODE'), file?.llm?.mode, defaults.llm.mode),
      provider: pick('llm.provider', overrides.llm?.provider, optionalString(env, 'TAGA_LLM_PROVIDER_NAME'), file?.llm?.provider, defaults.llm.provider),
      endpoint: pick('llm.endpoint', overrides.llm?.endpoint, optionalString(env, 'TAGA_LLM_ENDPOINT'), file?.llm?.endpoint, defaults.llm.endpoint),
      model: pick('llm.model', overrides.llm?.model, optionalString(env, 'TAGA_LLM_MODEL'), file?.llm?.model, defaults.llm.model),
      timeoutMs: pick('llm.timeoutMs', overrides.llm?.timeoutMs, optionalPositiveInt(env, 'TAGA_LLM_TIMEOUT_MS'), file?.llm?.timeoutMs, defaults.llm.timeoutMs),
      ...(dailyCap > 0 ? { dailyCap } : {}),
      ...(dailyTokens > 0 ? { dailyTokens } : {}),
      ...(perConsumerShare >= 0 && perConsumerShare <= 1 ? { perConsumerShare } : {}),
      ...(apiKey === undefined ? {} : { apiKey }),
    },
    consolidation: {
      enabled: pick('consolidation.enabled', overrides.consolidation?.enabled, optionalOnOff(env, 'TAGA_CONSOLIDATION_MODE'), file?.consolidation?.enabled, defaults.consolidation.enabled),
      scanIntervalMs: pick('consolidation.scanIntervalMs', overrides.consolidation?.scanIntervalMs, optionalPositiveInt(env, 'TAGA_CONSOLIDATION_SCAN_INTERVAL_MS'), file?.consolidation?.scanIntervalMs, defaults.consolidation.scanIntervalMs),
      promotion: {
        minUsefulCount: pick('consolidation.promotion.minUsefulCount', overrides.consolidation?.promotion?.minUsefulCount, optionalPositiveInt(env, 'TAGA_AUTO_PROMOTE_USEFUL_COUNT'), file?.consolidation?.promotion?.minUsefulCount, defaults.consolidation.promotion.minUsefulCount),
        maxNotUsefulCount: pick('consolidation.promotion.maxNotUsefulCount', overrides.consolidation?.promotion?.maxNotUsefulCount, optionalPositiveInt(env, 'TAGA_AUTO_PROMOTE_MAX_NOT_USEFUL'), file?.consolidation?.promotion?.maxNotUsefulCount, defaults.consolidation.promotion.maxNotUsefulCount),
      },
      deduplication: {
        rejectSimilarity: pick('consolidation.deduplication.rejectSimilarity', overrides.consolidation?.deduplication?.rejectSimilarity, optionalUnitInterval(env, 'TAGA_DEDUP_REJECT_SIMILARITY'), file?.consolidation?.deduplication?.rejectSimilarity, defaults.consolidation.deduplication.rejectSimilarity),
        mergeSimilarity: pick('consolidation.deduplication.mergeSimilarity', overrides.consolidation?.deduplication?.mergeSimilarity, optionalUnitInterval(env, 'TAGA_DEDUP_MERGE_SIMILARITY'), file?.consolidation?.deduplication?.mergeSimilarity, defaults.consolidation.deduplication.mergeSimilarity),
      },
    },
    learning: {
      allowNetwork: pick('learning.allowNetwork', overrides.learning?.allowNetwork, optionalBoolean(env, 'TAGA_LEARN_ALLOW_NETWORK'), file?.learning?.allowNetwork, defaults.learning.allowNetwork),
    },
    collection: {
      lookbackDays: pick('collection.lookbackDays', overrides.collection?.lookbackDays, optionalPositiveInt(env, 'TAGA_COLLECTION_LOOKBACK_DAYS'), file?.collection?.lookbackDays, defaults.collection.lookbackDays),
    },
    reflection: {
      enabled: pick('reflection.enabled', overrides.reflection?.enabled, optionalOnOff(env, 'TAGA_REFLECT_MODE'), file?.reflection?.enabled, defaults.reflection.enabled),
      intervalMs: pick('reflection.intervalMs', overrides.reflection?.intervalMs, optionalPositiveInt(env, 'TAGA_REFLECT_INTERVAL_MS'), file?.reflection?.intervalMs, defaults.reflection.intervalMs),
      windowDays: pick('reflection.windowDays', overrides.reflection?.windowDays, optionalPositiveInt(env, 'TAGA_REFLECT_WINDOW_DAYS'), file?.reflection?.windowDays, defaults.reflection.windowDays),
      minGroupSize: pick('reflection.minGroupSize', overrides.reflection?.minGroupSize, optionalPositiveInt(env, 'TAGA_REFLECT_MIN_GROUP'), file?.reflection?.minGroupSize, defaults.reflection.minGroupSize),
      maxGroups: pick('reflection.maxGroups', overrides.reflection?.maxGroups, optionalPositiveInt(env, 'TAGA_REFLECT_MAX_GROUPS'), file?.reflection?.maxGroups, defaults.reflection.maxGroups),
    },
  };
  return { config, sources };
}

function validateResolved(config: ResolvedConfig): void {
  const issues: string[] = [];
  if (config.retrieval.semantic.mode !== 'off' && config.retrieval.semantic.modelPath.length === 0) issues.push('retrieval.semantic.modelPath is required when semantic mode is enabled');
  if (config.llm.mode !== 'off' && config.llm.endpoint.length === 0) issues.push('llm.endpoint is required when llm mode is enabled');
  if (config.llm.mode !== 'off' && config.llm.model.length === 0) issues.push('llm.model is required when llm mode is enabled');
  if (config.consolidation.deduplication.mergeSimilarity > config.consolidation.deduplication.rejectSimilarity) issues.push('consolidation.deduplication.mergeSimilarity must be <= rejectSimilarity');
  if (issues.length > 0) throw new ConfigurationError('effective configuration is invalid', issues);
}

function optionalString(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  if (value === undefined) return undefined;
  if (value.length === 0) throw new ConfigurationError(`environment variable ${key} must not be empty`);
  return value;
}

function optionalSecret(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  return value === undefined || value.length === 0 ? undefined : value;
}

function optionalMode(env: NodeJS.ProcessEnv, key: string): FeatureMode | undefined {
  const value = env[key];
  if (value === undefined) return undefined;
  const parsed = featureModeSchema.safeParse(value);
  if (!parsed.success) throw new ConfigurationError(`environment variable ${key} must be off, shadow, or on`);
  return parsed.data;
}

function optionalPositiveInt(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const value = env[key];
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new ConfigurationError(`environment variable ${key} must be a positive integer`);
  return parsed;
}

function optionalUnitInterval(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const value = env[key];
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new ConfigurationError(`environment variable ${key} must be between 0 and 1`);
  return parsed;
}

function optionalBoolean(env: NodeJS.ProcessEnv, key: string): boolean | undefined {
  const value = env[key]?.toLowerCase();
  if (value === undefined) return undefined;
  if (['1', 'true', 'on', 'yes'].includes(value)) return true;
  if (['0', 'false', 'off', 'no'].includes(value)) return false;
  throw new ConfigurationError(`environment variable ${key} must be a boolean`);
}

function optionalOnOff(env: NodeJS.ProcessEnv, key: string): boolean | undefined {
  const value = env[key];
  if (value === undefined) return undefined;
  if (value === 'on') return true;
  if (value === 'off') return false;
  throw new ConfigurationError(`environment variable ${key} must be on or off`);
}

function resolvePath(cwd: string, value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}

function resolveLayeredPath(path: string, value: string, sources: Readonly<Record<string, ConfigSource>>, cwd: string, fileBase: string): string {
  return resolvePath(sources[path] === 'file' ? fileBase : cwd, value);
}

function resolveLayeredOptionalPath(path: string, value: string, sources: Readonly<Record<string, ConfigSource>>, cwd: string, fileBase: string): string {
  return value.length === 0 ? '' : resolveLayeredPath(path, value, sources, cwd, fileBase);
}

function defaultBrainPath(env: NodeJS.ProcessEnv): string {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  return resolve(env.TAGA_BRAIN ?? join(home, '.taga', 'brain'));
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function formatIssues(error: z.ZodError): readonly string[] {
  return error.issues.map((issue) => `${issue.path.length === 0 ? '<root>' : issue.path.join('.')}: ${issue.message}`);
}
