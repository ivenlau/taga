import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCli } from '../apps/cli/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';

function streams(): { stdout: { value: string; write(chunk: string): void }; stderr: { value: string; write(chunk: string): void } } {
  const stdout = { value: '', write(chunk: string): void { stdout.value += chunk; } };
  const stderr = { value: '', write(chunk: string): void { stderr.value += chunk; } };
  return { stdout, stderr };
}

describe('taga CLI', () => {
  it('previews init without writing, then performs an idempotent bootstrap with --yes', async () => {
    const fixture = await createTemporaryDirectory();
    const preview = streams();
    const previewCode = await runCli(['init', '--json', `--brain=${join(fixture.path, 'brain')}`], { cwd: fixture.path, streams: preview });
    expect(previewCode).toBe(3);
    const previewResponse = JSON.parse(preview.stdout.value) as unknown as { code: string };
    expect(previewResponse.code).toBe('CONFIRMATION_REQUIRED');

    const applied = streams();
    expect(await runCli(['init', '--yes', '--json', `--brain=${join(fixture.path, 'brain')}`], { cwd: fixture.path, streams: applied })).toBe(0);
    expect(await readFile(join(fixture.path, 'brain', 'config.yaml'), 'utf8')).toContain('schemaVersion: 3');
    expect(await runCli(['init', '--yes', '--json', `--brain=${join(fixture.path, 'brain')}`], { cwd: fixture.path, streams: streams() })).toBe(0);
    await fixture.cleanup();
  });

  it('reports degraded doctor health as successful JSON', async () => {
    const fixture = await createTemporaryDirectory();
    await runCli(['init', '--yes', `--brain=${join(fixture.path, 'brain')}`], { cwd: fixture.path, streams: streams() });
    const output = streams();
    const code = await runCli(['doctor', '--json', `--brain=${join(fixture.path, 'brain')}`], { cwd: fixture.path, streams: output });
    const response = JSON.parse(output.stdout.value) as unknown as {
      ok: boolean;
      code: string;
      warnings?: string[];
      data: { checks: Record<string, { ok: boolean; status: string; detail?: string }> };
    };
    expect(code).toBe(0);
    expect(response.ok).toBe(true);
    expect(response.code).toBe('DOCTOR_DEGRADED');
    expect(response.warnings).toBeDefined();
    const zvecCheck = response.data.checks.semantic_zvec;
    expect(zvecCheck).toBeDefined();
    expect(zvecCheck?.ok).toBe(true);
    const zvecReport = JSON.parse(zvecCheck?.detail ?? '{}') as { nodeVersion?: string; platform?: string; arch?: string; packageVersion?: string | null; accessMode?: string };
    expect(zvecReport).toMatchObject({
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      packageVersion: '0.8.0',
      accessMode: 'read-only',
    });
    await fixture.cleanup();
  });

  it('initializes all M2 agents and reports daemon status without requiring the daemon', async () => {
    const fixture = await createTemporaryDirectory();
    const brain = join(fixture.path, 'brain');
    const output = streams();
    expect(await runCli(['init', '--yes', '--agent=all', '--json', `--brain=${brain}`], { cwd: fixture.path, streams: output })).toBe(0);
    const config = await readFile(join(brain, 'config.yaml'), 'utf8');
    expect(config).toContain('pi');
    expect(config).toContain('claude-code');
    expect(config).toContain('codex');
    expect(config).toContain('opencode');
    const agents = await readFile(join(fixture.path, 'AGENTS.md'), 'utf8');
    const claude = await readFile(join(fixture.path, 'CLAUDE.md'), 'utf8');
    expect((agents.match(/taga:begin/gu) ?? [])).toHaveLength(1);
    expect((claude.match(/taga:begin/gu) ?? [])).toHaveLength(1);
    const statusOutput = streams();
    expect(await runCli(['daemon', 'status', '--json', `--brain=${brain}`], { cwd: fixture.path, streams: statusOutput })).toBe(0);
    expect((JSON.parse(statusOutput.stdout.value) as { code: string }).code).toBe('DAEMON_STOPPED');
    await fixture.cleanup();
  });

  it('reports semantic vector health and queues a rebuild without blocking Fast Path', async () => {
    const fixture = await createTemporaryDirectory();
    const brain = join(fixture.path, 'brain');
    await runCli(['init', '--yes', '--json', `--brain=${brain}`], { cwd: fixture.path, streams: streams() });
    const statusOutput = streams();
    expect(await runCli(['vector', 'status', '--json', `--brain=${brain}`], { cwd: fixture.path, streams: statusOutput })).toBe(0);
    expect((JSON.parse(statusOutput.stdout.value) as { data: { integrity: { activeGeneration: unknown } } }).data.integrity.activeGeneration).toBeNull();
    const syncOutput = streams();
    expect(await runCli(['vector', 'sync', '--json', `--brain=${brain}`], { cwd: fixture.path, streams: syncOutput })).toBe(0);
    expect((JSON.parse(syncOutput.stdout.value) as { code: string }).code).toBe('VECTOR_SYNC_QUEUED');
    await fixture.cleanup();
  });
});
