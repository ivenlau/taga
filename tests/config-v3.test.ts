import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../apps/cli/src/index.js';
import {
  ConfigurationError,
  configFileFromResolved,
  defaultConfigPath,
  loadConfig,
  parseConfigText,
  redactedConfig,
  resolveConfigPath,
  stringifyConfig,
} from '../packages/config/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';

function streams(): { stdout: { value: string; write(chunk: string): void }; stderr: { value: string; write(chunk: string): void } } {
  const stdout = { value: '', write(chunk: string): void { stdout.value += chunk; } };
  const stderr = { value: '', write(chunk: string): void { stderr.value += chunk; } };
  return { stdout, stderr };
}

describe('schemaVersion 4 configuration', () => {
  it('uses override > environment > file > default and records sources', async () => {
    const fixture = await createTemporaryDirectory();
    const configPath = join(fixture.path, 'config.yaml');
    await writeFile(configPath, [
      'schemaVersion: 4',
      'paths:',
      `  brain: ${join(fixture.path, 'file-brain')}`,
      'retrieval:',
      '  semantic:',
      '    mode: off',
      '    modelPath: file-model',
      'learning:',
      '  allowNetwork: false',
    ].join('\n'), 'utf8');

    const loaded = await loadConfig({
      cwd: fixture.path,
      configPath,
      env: {
        TAGA_BRAIN: join(fixture.path, 'env-brain'),
        TAGA_LEARN_ALLOW_NETWORK: 'true',
        TAGA_LLM_API_KEY: 'top-secret',
      },
      overrides: {
        paths: { brain: join(fixture.path, 'override-brain') },
      },
    });

    expect(loaded.config.paths.brain).toBe(join(fixture.path, 'override-brain'));
    expect(loaded.config.learning.allowNetwork).toBe(true);
    expect(loaded.sources['paths.brain']).toBe('override');
    expect(loaded.sources['learning.allowNetwork']).toBe('environment');
    expect(redactedConfig(loaded.config).llm.apiKey).toBe('[redacted]');
    expect(JSON.stringify(redactedConfig(loaded.config))).not.toContain('top-secret');
    await fixture.cleanup();
  });

  it('rejects unknown keys', () => {
    expect(() => parseConfigText('schemaVersion: 4\nunknown: true\n', 'fixture')).toThrow(ConfigurationError);
  });

  it('migrates legacy behavior without persisting API keys or generated paths', () => {
    const parsed = parseConfigText([
      'schemaVersion: 2',
      'brainPath: C:\\brain',
      'projectPath: D:\\project',
      'projectId: generated-id',
      'agents:',
      '  - id: codex',
      '    kind: adapter',
      '    configPath: C:\\brain\\agents\\codex.yaml',
      '    targetPath: D:\\project\\AGENTS.md',
      'remoteModelAllowed: false',
      'llm:',
      '  mode: on',
      '  endpoint: http://localhost/v1/chat/completions',
      '  model: local',
      '  apiKey: should-not-survive',
    ].join('\n'), 'legacy');

    expect(parsed.legacy).toBe(true);
    expect(parsed.file?.schemaVersion).toBe(4);
    expect(JSON.stringify(parsed.file)).not.toContain('projectPath');
    expect(parsed.file?.agents?.enabled).toEqual(['codex']);
    expect(JSON.stringify(parsed.file)).not.toContain('should-not-survive');
    expect(JSON.stringify(parsed.file)).not.toContain('configPath');
    expect(parsed.warnings.some((warning) => warning.includes('TAGA_LLM_API_KEY'))).toBe(true);
  });

  it('migrates legacy consolidation LLM settings into the unified LLM section', () => {
    const parsed = parseConfigText([
      'schemaVersion: 2',
      'brainPath: /tmp/brain',
      'projectPath: /tmp/project',
      'agents: []',
      'consolidation:',
      '  llm:',
      '    mode: on',
      '    endpoint: http://localhost/v1/chat/completions',
      '    model: local',
      '    apiKey: legacy-secret',
    ].join('\n'), 'legacy');

    expect(parsed.file?.llm).toMatchObject({ mode: 'on', endpoint: 'http://localhost/v1/chat/completions', model: 'local' });
    expect(JSON.stringify(parsed.file)).not.toContain('legacy-secret');
    expect(parsed.warnings.some((warning) => warning.includes('consolidation.llm was moved'))).toBe(true);
  });

  it('writes block-style YAML without secret fields', async () => {
    const fixture = await createTemporaryDirectory();
    const loaded = await loadConfig({ cwd: fixture.path, env: {}, overrides: { paths: { brain: join(fixture.path, 'brain') } } });
    const yaml = stringifyConfig(configFileFromResolved(loaded.config));
    expect(yaml).toContain('retrieval:\n  semantic:');
    expect(yaml).not.toContain('{');
    expect(yaml).not.toContain('apiKey');
    await fixture.cleanup();
  });

  it('uses platform-standard default paths', () => {
    expect(defaultConfigPath({ APPDATA: 'C:\\Users\\test\\AppData\\Roaming', USERPROFILE: 'C:\\Users\\test' }, 'win32'))
      .toBe('C:\\Users\\test\\AppData\\Roaming\\taga\\config.yaml');
    expect(defaultConfigPath({ HOME: '/home/test', XDG_CONFIG_HOME: '/cfg' }, 'linux')).toBe('/cfg/taga/config.yaml');
    expect(resolveConfigPath({ cwd: '/work', env: {}, platform: 'linux', isolatedBrainPath: 'brain' }))
      .toBe(join(resolve('/work'), 'brain', 'config.yaml'));
  });

  it('exposes redacted effective configuration and explicit migration through CLI', async () => {
    const fixture = await createTemporaryDirectory();
    const brain = join(fixture.path, 'brain');
    await mkdir(brain, { recursive: true });
    await writeFile(join(brain, '_config.yaml'), [
      'schemaVersion: 2',
      `brainPath: ${brain}`,
      `projectPath: ${fixture.path}`,
      'projectId: legacy',
      'agents: []',
      'remoteModelAllowed: false',
    ].join('\n'), 'utf8');
    const env = { TAGA_LLM_API_KEY: 'cli-secret' };
    const shown = streams();
    expect(await runCli(['config', 'show', '--json', `--brain=${brain}`], { cwd: fixture.path, env, streams: shown })).toBe(0);
    expect(shown.stdout.value).toContain('[redacted]');
    expect(shown.stdout.value).not.toContain('cli-secret');

    const preview = streams();
    expect(await runCli(['config', 'migrate', '--json', `--brain=${brain}`], { cwd: fixture.path, env, streams: preview })).toBe(0);
    expect((JSON.parse(preview.stdout.value) as { code: string }).code).toBe('CONFIG_MIGRATION_PREVIEW');
    expect(await runCli(['config', 'migrate', '--write', '--json', `--brain=${brain}`], { cwd: fixture.path, env, streams: streams() })).toBe(0);
    expect(await readFile(join(brain, 'config.yaml'), 'utf8')).toContain('schemaVersion: 4');
    await fixture.cleanup();
  });

  it('reads schemaVersion 3 as legacy and drops the configured project path', () => {
    const parsed = parseConfigText('schemaVersion: 3\npaths:\n  brain: /tmp/brain\n  project: /tmp/project\n', 'v3');
    expect(parsed.legacy).toBe(true);
    expect(parsed.file).toEqual({ schemaVersion: 4, paths: { brain: '/tmp/brain' } });
    expect(parsed.warnings[0]).toContain('paths.project is ignored');
  });
});
