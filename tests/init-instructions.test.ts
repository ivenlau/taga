import { describe, expect, it, afterEach } from 'vitest';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { runCli } from '../apps/cli/src/index.js';
import { writeManagedBlock } from '../packages/storage/src/index.js';
import { DEFAULT_AGENT_INSTRUCTIONS } from '../packages/adapters/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';

const envKeys = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME'] as const;
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

describe('init agent instructions', () => {
  it('writes instruction blocks into project and global instruction files', async () => {
    const fixture = await createTemporaryDirectory();
    const configHome = join(fixture.path, 'config-home');
    setEnv('CLAUDE_CONFIG_DIR', join(configHome, '.claude'));
    setEnv('CODEX_HOME', join(configHome, '.codex'));
    const brain = join(fixture.path, 'brain');
    try {
      const streams = { stdout: process.stdout, stderr: process.stderr } as const;
      expect(await runCli(['init', '--yes', '--agent=claude-code,codex', '--json', `--brain=${brain}`], { cwd: fixture.path, streams })).toBe(0);

      for (const target of [
        join(fixture.path, 'CLAUDE.md'),
        join(fixture.path, 'AGENTS.md'),
        join(configHome, '.claude', 'CLAUDE.md'),
        join(configHome, '.codex', 'AGENTS.md'),
      ]) {
        const content = await readFileOr(target);
        expect(content, target).toContain('taga:instructions:begin v1 do-not-edit');
        expect(content, target).toContain('taga:instructions:end');
        expect(content, target).toContain('memory_session_start');
        expect(content).toContain('requested_status');
      }
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it('is idempotent and keeps user content around the block', async () => {
    const fixture = await createTemporaryDirectory();
    setEnv('CLAUDE_CONFIG_DIR', join(fixture.path, 'home', '.claude'));
    setEnv('CODEX_HOME', join(fixture.path, 'home', '.codex'));
    const brain = join(fixture.path, 'brain');
    const streams = { stdout: process.stdout, stderr: process.stderr } as const;
    try {
      expect(await runCli(['init', '--yes', '--agent=claude-code', '--json', `--brain=${brain}`], { cwd: fixture.path, streams })).toBe(0);
      const projectClaude = join(fixture.path, 'CLAUDE.md');
      const before = await readFile(projectClaude, 'utf8');
      expect(before.match(/taga:instructions:begin/g)).toHaveLength(1);
      expect(await runCli(['init', '--yes', '--agent=claude-code', '--json', `--brain=${brain}`], { cwd: fixture.path, streams })).toBe(0);
      const after = await readFile(projectClaude, 'utf8');
      expect(after).toBe(before);
      expect(after.match(/taga:instructions:begin/g)).toHaveLength(1);
      await fixture.cleanup();
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it('skips instruction blocks with --no-instructions', async () => {
    const fixture = await createTemporaryDirectory();
    setEnv('CLAUDE_CONFIG_DIR', join(fixture.path, 'home', '.claude'));
    setEnv('CODEX_HOME', join(fixture.path, 'home', '.codex'));
    const brain = join(fixture.path, 'brain');
    const streams = { stdout: process.stdout, stderr: process.stderr } as const;
    try {
      expect(await runCli(['init', '--yes', '--agent=claude-code,codex', '--no-instructions', '--json', `--brain=${brain}`], { cwd: fixture.path, streams })).toBe(0);
      expect(await readFileOr(join(fixture.path, 'CLAUDE.md'))).not.toContain('taga:instructions:begin');
      expect(await readFileOr(join(fixture.path, 'AGENTS.md'))).not.toContain('taga:instructions:begin');
      expect(await readFileOr(join(fixture.path, 'home', '.claude', 'CLAUDE.md'))).toBe('');
      await fixture.cleanup();
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it('survives context pack injection into the same file', async () => {
    const fixture = await createTemporaryDirectory();
    setEnv('CLAUDE_CONFIG_DIR', join(fixture.path, 'home', '.claude'));
    setEnv('CODEX_HOME', join(fixture.path, 'home', '.codex'));
    const brain = join(fixture.path, 'brain');
    const streams = { stdout: process.stdout, stderr: process.stderr } as const;
    try {
      expect(await runCli(['init', '--yes', '--agent=claude-code', '--json', `--brain=${brain}`], { cwd: fixture.path, streams })).toBe(0);
      const projectClaude = join(fixture.path, 'CLAUDE.md');
      await writeManagedBlock(projectClaude, 'SESSION CONTEXT PACK CONTENT');
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
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain('memory_record');
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain('memory_search');
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain('"draft"');
    for (const memoryType of ['preferences', 'environment', 'procedures', 'lessons', 'projects']) {
      expect(DEFAULT_AGENT_INSTRUCTIONS).toContain(`\`${memoryType}\` —`);
    }
    expect(DEFAULT_AGENT_INSTRUCTIONS).not.toMatch(/taga:(instructions:)?(begin|end)/u);
  });
});
