import { describe, expect, it, afterEach } from 'vitest';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { runCli } from '../apps/cli/src/index.js';
import { instructionBlockBegin, instructionBlockEnd, markerBegin, markerEnd, upsertManagedBlock } from '../packages/storage/src/index.js';
import { DEFAULT_AGENT_INSTRUCTIONS } from '../packages/adapters/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';

const envKeys = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME'] as const;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: (typeof envKeys)[number], value: string): void {
  savedEnv[key] = process.env[key];
  process.env[key] = value;
}

afterEach(() => {
  for (const key of envKeys) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete savedEnv[key];
  }
});

async function readFileOr(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

function capturingStreams(): { stdout: { value: string; write(chunk: string): void }; stderr: { value: string; write(chunk: string): void } } {
  const stdout = { value: '', write(chunk: string) { stdout.value += chunk; } };
  const stderr = { value: '', write(chunk: string) { stderr.value += chunk; } };
  return { stdout, stderr };
}

interface InstallResponse {
  readonly code: string;
  readonly message: string;
  readonly data: {
    readonly scope: string;
    readonly agents: ReadonlyArray<{ id: string; targetPaths: readonly string[]; removedFrom: readonly string[] }>;
    readonly mcp: ReadonlyArray<{ agent: string; registered: boolean; howto: string }>;
    readonly mcpJson?: { path: string; status: string };
  };
  readonly warnings?: readonly string[];
}

async function install(args: readonly string[], cwd: string): Promise<{ code: number; response: InstallResponse }> {
  const streams = capturingStreams();
  const code = await runCli(['agent', 'install', '--json', ...args], { cwd, streams });
  const line = streams.stdout.value.split('\n').find((item) => item.trim().startsWith('{')) ?? '';
  return { code, response: line.length === 0 ? ({} as InstallResponse) : JSON.parse(line) as InstallResponse };
}

async function initFixture(configHomeName: string): Promise<ReturnType<typeof createTemporaryDirectory>> {
  const fixture = await createTemporaryDirectory();
  setEnv('CLAUDE_CONFIG_DIR', join(fixture.path, configHomeName, '.claude'));
  setEnv('CODEX_HOME', join(fixture.path, configHomeName, '.codex'));
  const streams = capturingStreams();
  expect(await runCli(['init', '--yes', '--agent=claude-code,codex', '--json', `--brain=${join(fixture.path, 'brain')}`], { cwd: fixture.path, streams })).toBe(0);
  return fixture;
}

const hasInstructions = (content: string): boolean => content.includes(instructionBlockBegin) && content.includes(instructionBlockEnd);

describe('init agent instructions', () => {
  it('writes the instruction block to one scope only when agent install is requested', async () => {
    const fixture = await initFixture('config-home');
    const brain = join(fixture.path, 'brain');
    try {
      const projectFiles = [join(fixture.path, 'CLAUDE.md'), join(fixture.path, 'AGENTS.md')];
      const userFiles = [join(fixture.path, 'config-home', '.claude', 'CLAUDE.md'), join(fixture.path, 'config-home', '.codex', 'AGENTS.md')];
      for (const target of [...projectFiles, ...userFiles]) {
        expect(await readFileOr(target), target).toBe('');
      }

      const installed = await install(['--agent=claude-code,codex', '--yes', `--brain=${brain}`], fixture.path);
      expect(installed.code).toBe(0);
      expect(installed.response.data.scope).toBe('project');
      for (const target of projectFiles) {
        const content = await readFileOr(target);
        expect(content, target).toContain('taga:instructions:begin v1 do-not-edit');
        expect(content, target).toContain('taga:instructions:end');
        expect(content, target).toContain('memory_session_start');
        expect(content, target).toContain('requested_status');
      }
      // Both agents used to receive the block in their user-level file too, so Claude Code loaded it twice.
      for (const target of userFiles) expect(await readFileOr(target), target).toBe('');
      expect(installed.response.data.agents.map((agent) => agent.targetPaths)).toEqual([[projectFiles[0]], [projectFiles[1]]]);
      await fixture.cleanup();
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it('is idempotent and keeps user content around the block', async () => {
    const fixture = await initFixture('home');
    const brain = join(fixture.path, 'brain');
    try {
      expect((await install(['--agent=claude-code', '--yes', `--brain=${brain}`], fixture.path)).code).toBe(0);
      const projectClaude = join(fixture.path, 'CLAUDE.md');
      const before = await readFile(projectClaude, 'utf8');
      expect(before.match(/taga:instructions:begin/g)).toHaveLength(1);
      expect((await install(['--agent=claude-code', '--yes', `--brain=${brain}`], fixture.path)).code).toBe(0);
      const after = await readFile(projectClaude, 'utf8');
      expect(after).toBe(before);
      expect(after.match(/taga:instructions:begin/g)).toHaveLength(1);
      await fixture.cleanup();
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it('never writes instruction blocks during init', async () => {
    const fixture = await initFixture('home');
    try {
      expect(await readFileOr(join(fixture.path, 'CLAUDE.md'))).not.toContain('taga:instructions:begin');
      expect(await readFileOr(join(fixture.path, 'AGENTS.md'))).not.toContain('taga:instructions:begin');
      expect(await readFileOr(join(fixture.path, 'home', '.claude', 'CLAUDE.md'))).toBe('');
      await fixture.cleanup();
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it('survives context pack injection into the same file', async () => {
    const fixture = await initFixture('home');
    const brain = join(fixture.path, 'brain');
    try {
      expect((await install(['--agent=claude-code', '--yes', `--brain=${brain}`], fixture.path)).code).toBe(0);
      const projectClaude = join(fixture.path, 'CLAUDE.md');
      await upsertManagedBlock(projectClaude, 'SESSION CONTEXT PACK CONTENT', { begin: markerBegin, end: markerEnd });
      const after = await readFile(projectClaude, 'utf8');
      expect(after).toContain('taga:instructions:begin');
      expect(after).toContain('memory_session_start');
      expect(after).toContain('SESSION CONTEXT PACK CONTENT');
      expect(after).not.toContain('taga:begin v1 do-not-edit\nSESSION');
      await fixture.cleanup();
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it('exposes the default instructions with the expected tool guidance', () => {
    for (const tool of ['memory_session_start', 'memory_record', 'memory_search', 'memory_precheck', 'memory_feedback', 'knowledge_ingest']) {
      expect(DEFAULT_AGENT_INSTRUCTIONS).toContain(tool);
    }
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain('`task`');
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain('`anchors`');
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain('alternates');
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain('没有记录');
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain('机密');
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain('taga review');
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain('"draft"');
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain('anchor_state');
    for (const memoryType of ['preferences', 'environment', 'procedures', 'lessons', 'projects']) {
      expect(DEFAULT_AGENT_INSTRUCTIONS).toContain(`\`${memoryType}\``);
    }
    expect(DEFAULT_AGENT_INSTRUCTIONS).not.toMatch(/taga:(instructions:)?(begin|end)/u);
  });

  it('moves the block to user-level files with --scope=user and removes the project copy', async () => {
    const fixture = await initFixture('home');
    const brain = join(fixture.path, 'brain');
    try {
      expect((await install(['--agent=claude-code', '--yes', `--brain=${brain}`], fixture.path)).code).toBe(0);
      const projectClaude = join(fixture.path, 'CLAUDE.md');
      const userClaude = join(fixture.path, 'home', '.claude', 'CLAUDE.md');
      expect(hasInstructions(await readFile(projectClaude, 'utf8'))).toBe(true);

      const moved = await install(['--agent=claude-code', '--scope=user', '--yes', `--brain=${brain}`], fixture.path);
      expect(moved.code).toBe(0);
      expect(moved.response.data.scope).toBe('user');
      expect(moved.response.data.agents[0]?.targetPaths).toEqual([userClaude]);
      expect(moved.response.data.agents[0]?.removedFrom).toEqual([projectClaude]);
      expect(hasInstructions(await readFile(userClaude, 'utf8'))).toBe(true);
      expect(hasInstructions(await readFile(projectClaude, 'utf8'))).toBe(false);
      expect(moved.response.warnings?.some((warning) => warning.includes('removed the duplicate instruction block'))).toBe(true);
      await fixture.cleanup();
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it('removes a duplicate user-level block left behind by earlier versions', async () => {
    const fixture = await initFixture('home');
    const brain = join(fixture.path, 'brain');
    try {
      const userClaude = join(fixture.path, 'home', '.claude', 'CLAUDE.md');
      await upsertManagedBlock(userClaude, DEFAULT_AGENT_INSTRUCTIONS, { begin: instructionBlockBegin, end: instructionBlockEnd });
      await writeFile(join(fixture.path, 'home', '.claude', 'CLAUDE.md'), `# my global notes\n\n${await readFile(userClaude, 'utf8')}`, 'utf8');

      const installed = await install(['--agent=claude-code', '--yes', `--brain=${brain}`], fixture.path);
      expect(installed.code).toBe(0);
      expect(installed.response.data.agents[0]?.removedFrom).toEqual([userClaude]);
      const userContent = await readFile(userClaude, 'utf8');
      expect(hasInstructions(userContent)).toBe(false);
      expect(userContent).toContain('# my global notes');
      expect(hasInstructions(await readFile(join(fixture.path, 'CLAUDE.md'), 'utf8'))).toBe(true);
      await fixture.cleanup();
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it('rejects a scope the agent has no instruction file for', async () => {
    const fixture = await initFixture('home');
    const brain = join(fixture.path, 'brain');
    try {
      const local = await install(['--agent=local', '--scope=user', '--yes', `--brain=${brain}`], fixture.path);
      expect(local.code).toBe(1);
      expect(local.response.code).toBe('INVALID_INPUT');
      expect(local.response.message).toContain('no user-level instruction file');

      const unknown = await install(['--agent=claude-code', '--scope=team', '--yes', `--brain=${brain}`], fixture.path);
      expect(unknown.code).toBe(1);
      expect(unknown.response.message).toContain('--scope must be project or user');
      await fixture.cleanup();
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it('reports how to register the MCP server and writes .mcp.json only with --register-mcp', async () => {
    const fixture = await initFixture('home');
    const brain = join(fixture.path, 'brain');
    const mcpJson = join(fixture.path, '.mcp.json');
    try {
      const reported = await install(['--agent=claude-code', '--yes', `--brain=${brain}`], fixture.path);
      expect(reported.code).toBe(0);
      expect(reported.response.data.mcp[0]?.registered).toBe(false);
      expect(reported.response.data.mcp[0]?.howto).toContain('claude mcp add');
      expect(reported.response.warnings?.some((warning) => warning.includes('not registered for claude-code'))).toBe(true);
      expect(await readFileOr(mcpJson)).toBe('');

      await writeFile(mcpJson, `${JSON.stringify({ mcpServers: { other: { command: 'other-cmd' } } }, null, 2)}\n`, 'utf8');
      const written = await install(['--agent=claude-code', '--register-mcp', '--yes', `--brain=${brain}`], fixture.path);
      expect(written.code).toBe(0);
      expect(written.response.data.mcpJson).toEqual({ path: mcpJson, status: 'updated' });
      const config = JSON.parse(await readFile(mcpJson, 'utf8')) as { mcpServers: Record<string, { command?: string; type?: string }> };
      expect(config.mcpServers.other).toEqual({ command: 'other-cmd' });
      expect(config.mcpServers.taga).toEqual({ type: 'stdio', command: 'taga-mcp', args: [] });
      expect(written.response.data.mcp[0]?.registered).toBe(true);
      expect((written.response.warnings ?? []).some((warning) => warning.includes('not registered'))).toBe(false);

      expect((await install(['--agent=claude-code', '--register-mcp', '--yes', `--brain=${brain}`], fixture.path)).response.data.mcpJson?.status).toBe('kept');

      await writeFile(mcpJson, '{broken', 'utf8');
      const invalid = await install(['--agent=claude-code', '--register-mcp', '--yes', `--brain=${brain}`], fixture.path);
      expect(invalid.code).toBe(1);
      expect(invalid.response.message).toContain('not valid JSON');
      expect(await readFile(mcpJson, 'utf8')).toBe('{broken');
      await fixture.cleanup();
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it('persists the agents change into the config file the session actually loaded', async () => {
    const fixture = await createTemporaryDirectory();
    setEnv('CLAUDE_CONFIG_DIR', join(fixture.path, 'home', '.claude'));
    setEnv('CODEX_HOME', join(fixture.path, 'home', '.codex'));
    // XDG_CONFIG_HOME inside the fixture exposes a write to the default user config path.
    setEnv('XDG_CONFIG_HOME', join(fixture.path, 'xdg'));
    const brain = join(fixture.path, 'brain');
    try {
      expect(await runCli(['init', '--yes', '--json', `--brain=${brain}`], { cwd: fixture.path, streams: capturingStreams() })).toBe(0);
      expect((await install(['--agent=claude-code', '--yes', `--brain=${brain}`], fixture.path)).code).toBe(0);
      // The brain config carries the change; no defaults snapshot lands in the user config path.
      const brainConfig = await readFile(join(brain, 'config.yaml'), 'utf8');
      expect(brainConfig).toContain('claude-code');
      expect(brainConfig).toContain('writeInstructions: true');
      expect(await readFileOr(join(fixture.path, 'xdg', 'taga', 'config.yaml'))).toBe('');
      await fixture.cleanup();
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it('skips --register-mcp when no selected agent reads .mcp.json', async () => {
    const fixture = await initFixture('home');
    const brain = join(fixture.path, 'brain');
    try {
      const codex = await install(['--agent=codex', '--register-mcp', '--yes', `--brain=${brain}`], fixture.path);
      expect(codex.code).toBe(0);
      expect(codex.response.data.mcpJson).toBeUndefined();
      expect(codex.response.warnings?.some((warning) => warning.includes('--register-mcp skipped'))).toBe(true);
      expect(codex.response.data.mcp[0]?.howto).toContain('[mcp_servers.taga]');
      expect(await readFileOr(join(fixture.path, '.mcp.json'))).toBe('');
      await fixture.cleanup();
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);
});
