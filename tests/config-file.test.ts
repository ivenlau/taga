import { describe, expect, it } from 'vitest';
import { resolveLlmConfig, resolveSemanticConfig, llmConfigFromEnv } from '../packages/application/src/index.js';
import { resolveReflectConfig } from '../packages/learning/src/index.js';
import { parseValidatedConfigFile } from '../packages/application/src/index.js';

describe('config file parsing', () => {
  it('accepts a v2 file with behavior sections', () => {
    const raw = [
      'schemaVersion: 2',
      'brainPath: C:\\brains\\taga',
      'projectPath: D:\\code',
      'projectId: project-1',
      'agents: []',
      'remoteModelAllowed: false',
      'semantic:',
      '  mode: on',
      '  modelPath: D:\\models\\bge-m3',
      'llm:',
      '  mode: shadow',
      '  endpoint: http://127.0.0.1:11434/v1/chat/completions',
      '  model: llama3',
      '  dailyCap: 100',
    ].join('\n');
    const { config, warnings } = parseValidatedConfigFile(raw);
    expect(config).not.toBeNull();
    expect(warnings).toHaveLength(0);
    expect(config?.schemaVersion).toBe(2);
    expect(config?.semantic?.mode).toBe('on');
    expect(config?.llm?.dailyCap).toBe(100);
    expect(config?.agents).toEqual([]);
  });

  it('upgrades v1 legacy files and warns about ignored sections', () => {
    const raw = [
      'schemaVersion: 1',
      'brainPath: C:\\brains\\taga',
      'projectPath: D:\\code',
      'projectId: project-1',
      'agents: []',
      'remoteModelAllowed: false',
    ].join('\n');
    const { config, warnings } = parseValidatedConfigFile(raw);
    expect(config?.schemaVersion).toBe(2);
    expect(config?.semantic).toBeUndefined();
    expect(warnings.some((warning) => warning.includes('schemaVersion 1'))).toBe(true);
  });

  it('warns on unknown keys and rejects invalid files', () => {
    const raw = ['schemaVersion: 2', 'brainPath: x', 'projectPath: y', 'projectId: z', 'remoteModelAllowed: false', 'totallyUnknown: 1'].join('\n');
    const { config, warnings } = parseValidatedConfigFile(raw);
    expect(config).not.toBeNull();
    expect(warnings.some((warning) => warning.includes('totallyUnknown'))).toBe(true);
    expect(parseValidatedConfigFile('schemaVersion: 2').config).toBeNull();
    expect(parseValidatedConfigFile('not: [valid').warnings.some((warning) => warning.includes('YAML'))).toBe(true);
  });
});

describe('layered resolution (env > file > default)', () => {
  it('resolves llm config from env over file over defaults', () => {
    const file = { mode: 'shadow' as const, endpoint: 'http://file', model: 'file-model', dailyCap: 5 };
    expect(llmConfigFromEnv({}).mode).toBe('off');
    expect(resolveLlmConfig({}, file).mode).toBe('shadow');
    expect(resolveLlmConfig({}, file).endpoint).toBe('http://file');
    expect(resolveLlmConfig({ TAGA_LLM_ENDPOINT: 'http://env' }, file).endpoint).toBe('http://env');
    expect(resolveLlmConfig({ TAGA_LLM_MODE: 'on', TAGA_LLM_ENDPOINT: 'http://env', TAGA_LLM_MODEL: 'env-model' }, file).mode).toBe('on');
    expect(resolveLlmConfig({}, file).dailyCap).toBe(5);
    expect(resolveLlmConfig({ TAGA_LLM_DAILY_CAP: '9' }, file).dailyCap).toBe(9);
  });

  it('resolves semantic and reflect configs with the same precedence', () => {
    expect(resolveSemanticConfig({}, { mode: 'on', modelPath: 'D:\\m' }).mode).toBe('on');
    expect(resolveSemanticConfig({ TAGA_SEMANTIC_MODE: 'off' }, { mode: 'on' }).mode).toBe('off');
    expect(resolveSemanticConfig({}, {}).modelPath).toBe('');
    expect(resolveReflectConfig({}, { mode: 'on', windowDays: 14 }).mode).toBe('on');
    expect(resolveReflectConfig({}, { windowDays: 14 }).windowDays).toBe(14);
    expect(resolveReflectConfig({}, {}).windowDays).toBe(7);
    expect(resolveReflectConfig({ TAGA_REFLECT_WINDOW_DAYS: '2' }, { windowDays: 14 }).windowDays).toBe(2);
  });
});
