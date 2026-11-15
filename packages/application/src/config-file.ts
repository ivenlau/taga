import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import type { LlmMode } from './llm.js';
import type { SemanticMode } from './semantic-config.js';

export interface SemanticFileSection {
  readonly mode?: SemanticMode | undefined;
  readonly modelPath?: string | undefined;
  readonly rerankMode?: SemanticMode | undefined;
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

export interface ConsolidationFileSection {
  readonly mode?: 'on' | 'off' | undefined;
  readonly minUsefulCount?: number | undefined;
  readonly maxNotUsefulCount?: number | undefined;
  readonly rejectSimilarity?: number | undefined;
  readonly mergeSimilarity?: number | undefined;
  readonly scanIntervalMs?: number | undefined;
  readonly llm?: LlmFileSection | undefined;
}

export interface LearnFileSection {
  readonly allowNetwork?: boolean | undefined;
}

export interface ReflectFileSection {
  readonly mode?: 'on' | 'off' | undefined;
  readonly intervalMs?: number | undefined;
  readonly windowDays?: number | undefined;
  readonly minGroupSize?: number | undefined;
  readonly maxGroups?: number | undefined;
}

export interface ConfigFileAgent {
  readonly id: string;
  readonly kind: string;
  readonly configPath: string;
  readonly targetPath: string;
  readonly targetPaths?: readonly string[] | undefined;
}

export interface ConfigFileV2 {
  readonly schemaVersion: 2;
  readonly brainPath: string;
  readonly projectPath: string;
  readonly projectId: string;
  readonly agents: readonly ConfigFileAgent[];
  readonly remoteModelAllowed: boolean;
  readonly semantic?: SemanticFileSection | undefined;
  readonly consolidation?: ConsolidationFileSection | undefined;
  readonly learn?: LearnFileSection | undefined;
  readonly reflect?: ReflectFileSection | undefined;
  readonly llm?: LlmFileSection | undefined;
}

export const semanticSectionSchema: z.ZodType<SemanticFileSection> = z.object({
  mode: z.enum(['off', 'shadow', 'on']).optional(),
  modelPath: z.string().min(1).optional(),
  rerankMode: z.enum(['off', 'shadow', 'on']).optional(),
});

export const llmSectionSchema: z.ZodType<LlmFileSection> = z.object({
  mode: z.enum(['off', 'shadow', 'on']).optional(),
  endpoint: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
  providerName: z.string().min(1).optional(),
  dailyCap: z.number().int().positive().optional(),
});

export const consolidationSectionSchema: z.ZodType<ConsolidationFileSection> = z.object({
  mode: z.enum(['off', 'on']).optional(),
  minUsefulCount: z.number().int().positive().optional(),
  maxNotUsefulCount: z.number().int().positive().optional(),
  rejectSimilarity: z.number().min(0).max(1).optional(),
  mergeSimilarity: z.number().min(0).max(1).optional(),
  scanIntervalMs: z.number().int().positive().optional(),
  llm: llmSectionSchema.optional(),
});

export const learnSectionSchema: z.ZodType<LearnFileSection> = z.object({
  allowNetwork: z.boolean().optional(),
});

export const reflectSectionSchema: z.ZodType<ReflectFileSection> = z.object({
  mode: z.enum(['off', 'on']).optional(),
  intervalMs: z.number().int().positive().optional(),
  windowDays: z.number().int().positive().optional(),
  minGroupSize: z.number().int().positive().optional(),
  maxGroups: z.number().int().positive().optional(),
});

export const agentEntrySchema: z.ZodType<ConfigFileAgent> = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  configPath: z.string().min(1),
  targetPath: z.string().min(1),
  targetPaths: z.array(z.string().min(1)).optional(),
});

const configFileSchema = z.object({
  schemaVersion: z.literal(2),
  brainPath: z.string().min(1),
  projectPath: z.string().min(1),
  projectId: z.string().min(1),
  agents: z.array(agentEntrySchema).default([]),
  remoteModelAllowed: z.boolean(),
  semantic: semanticSectionSchema.optional(),
  consolidation: consolidationSectionSchema.optional(),
  learn: learnSectionSchema.optional(),
  reflect: reflectSectionSchema.optional(),
  llm: llmSectionSchema.optional(),
});

const legacyConfigFileSchema = z.object({
  schemaVersion: z.literal(1),
  brainPath: z.string().min(1),
  projectPath: z.string().min(1),
  projectId: z.string().min(1),
  agents: z.array(agentEntrySchema),
  remoteModelAllowed: z.boolean(),
});

const KNOWN_TOP_LEVEL_KEYS = new Set([
  'schemaVersion', 'brainPath', 'projectPath', 'projectId', 'agents', 'remoteModelAllowed',
  'semantic', 'consolidation', 'learn', 'reflect', 'llm',
]);

export interface ValidatedConfigFile {
  readonly config: ConfigFileV2 | null;
  readonly warnings: readonly string[];
}

export function parseValidatedConfigFile(raw: string): ValidatedConfigFile {
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    return { config: null, warnings: [`config file is not valid YAML: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { config: null, warnings: ['config file must be a YAML mapping'] };
  }
  const topLevel = parsed as Record<string, unknown>;
  const warnings: string[] = [];
  for (const key of Object.keys(topLevel)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) warnings.push(`unknown config key ignored: ${key}`);
  }
  const v2 = configFileSchema.safeParse(parsed);
  if (v2.success) return { config: v2.data, warnings };
  const legacy = legacyConfigFileSchema.safeParse(parsed);
  if (legacy.success) {
    warnings.push('config file uses schemaVersion 1; behavior sections are ignored until it is upgraded to version 2 (rerun taga init)');
    const legacyConfig: ConfigFileV2 = { ...legacy.data, schemaVersion: 2, semantic: undefined, consolidation: undefined, learn: undefined, reflect: undefined, llm: undefined };
    return { config: legacyConfig, warnings };
  }
  const issues = v2.error.issues.slice(0, 3).map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  warnings.push(`config file validation failed: ${issues}`);
  return { config: null, warnings };
}

export async function readValidatedConfigFile(path: string): Promise<ValidatedConfigFile> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT') {
      return { config: null, warnings: [] };
    }
    throw error;
  }
  return parseValidatedConfigFile(raw);
}
