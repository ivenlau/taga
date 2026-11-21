import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCli } from '../apps/cli/src/index.js';
import { contentHash, writeMarkdownDocument } from '../packages/storage/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';
import type { Memory } from '../packages/domain/src/index.js';

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
    const previewResponse = JSON.parse(preview.stdout.value) as unknown as { code: string; data: Record<string, unknown> };
    expect(previewResponse.code).toBe('CONFIRMATION_REQUIRED');
    expect(previewResponse.data).not.toHaveProperty('projectPath');
    expect(previewResponse.data).not.toHaveProperty('projectId');
    expect(previewResponse.data).not.toHaveProperty('collectionScope');

    const applied = streams();
    expect(await runCli(['init', '--yes', '--json', `--brain=${join(fixture.path, 'brain')}`], { cwd: fixture.path, streams: applied })).toBe(0);
    const config = await readFile(join(fixture.path, 'brain', 'config.yaml'), 'utf8');
    expect(config).toContain('schemaVersion: 4');
    expect(config).not.toContain('  project:');
    expect(config).toContain('writeInstructions: false');
    await expect(readFile(join(fixture.path, 'AGENTS.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const projects = streams();
    expect(await runCli(['project', 'list', '--json', `--brain=${join(fixture.path, 'brain')}`], { cwd: fixture.path, streams: projects })).toBe(0);
    expect((JSON.parse(projects.stdout.value) as { data: unknown[] }).data).toEqual([]);
    expect(await runCli(['init', '--yes', '--json', `--brain=${join(fixture.path, 'brain')}`], { cwd: fixture.path, streams: streams() })).toBe(0);
    await fixture.cleanup();
  });

  it('defers project discovery and instruction installation until a project-scoped command runs', async () => {
    const fixture = await createTemporaryDirectory();
    const brain = join(fixture.path, 'brain');
    expect(await runCli(['init', '--yes', '--no-instructions', '--agent=local', `--brain=${brain}`], { cwd: fixture.path, streams: streams() })).toBe(0);
    await expect(readFile(join(fixture.path, 'AGENTS.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const beforeInstall = streams();
    expect(await runCli(['project', 'list', '--json', `--brain=${brain}`], { cwd: fixture.path, streams: beforeInstall })).toBe(0);
    expect((JSON.parse(beforeInstall.stdout.value) as { data: unknown[] }).data).toEqual([]);
    const shown = streams();
    expect(await runCli(['project', 'show', '--json', `--brain=${brain}`], { cwd: fixture.path, streams: shown })).toBe(0);
    expect((JSON.parse(shown.stdout.value) as { data: { root: string; id: string } }).data).toMatchObject({ root: fixture.path });
    expect(await runCli(['agent', 'install', '--agent=local', '--yes', `--brain=${brain}`], { cwd: fixture.path, streams: streams() })).toBe(0);
    expect(await readFile(join(fixture.path, 'AGENTS.md'), 'utf8')).toContain('memory_session_start');
    const afterInstall = streams();
    expect(await runCli(['project', 'list', '--json', `--brain=${brain}`], { cwd: fixture.path, streams: afterInstall })).toBe(0);
    expect((JSON.parse(afterInstall.stdout.value) as { data: unknown[] }).data).toHaveLength(1);
    expect(await readFile(join(brain, 'config.yaml'), 'utf8')).toContain('writeInstructions: true');
    await fixture.cleanup();
  });

  it('rejects project context options on init', async () => {
    const fixture = await createTemporaryDirectory();
    const output = streams();
    expect(await runCli(['init', '--yes', '--json', `--brain=${join(fixture.path, 'brain')}`, `--project-root=${fixture.path}`], { cwd: fixture.path, streams: output })).toBe(1);
    const response = JSON.parse(output.stdout.value) as { code: string; message: string };
    expect(response.code).toBe('INVALID_INPUT');
    expect(response.message).toContain('projects are detected at runtime');
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

  it('reports pending draft backlog as review guidance in doctor', async () => {
    const fixture = await createTemporaryDirectory();
    const brain = join(fixture.path, 'brain');
    await runCli(['init', '--yes', `--brain=${brain}`], { cwd: fixture.path, streams: streams() });
    const timestamp = '2026-11-20T00:00:00.000Z';
    const draft: Memory = {
      schemaVersion: 1,
      id: 'mem-doctor-draft',
      type: 'lessons',
      scope: { kind: 'global' },
      projectId: null,
      status: 'draft',
      title: 'Doctor backlog fixture',
      summary: 'Draft waiting for review.',
      confidence: 0.5,
      sourceTrust: 'observed',
      visibility: 'private',
      created: timestamp,
      updated: timestamp,
      lastVerified: null,
      lastRecalled: null,
      reviewCount: 0,
      usefulCount: 0,
      notUsefulCount: 0,
      expiresAt: null,
      contentHash: contentHash('doctor backlog body'),
      sources: [{ kind: 'test', locator: 'cli.test.ts' }],
      anchors: [],
      tags: [],
      supersedes: null,
    };
    await writeMarkdownDocument(join(brain, 'lessons', 'global', 'mem-doctor-draft.md'), draft, 'doctor backlog body');
    expect(await runCli(['reindex', '--apply', '--json', `--brain=${brain}`], { cwd: fixture.path, streams: streams() })).toBe(0);
    const output = streams();
    const code = await runCli(['doctor', '--json', `--brain=${brain}`], { cwd: fixture.path, streams: output });
    const response = JSON.parse(output.stdout.value) as unknown as {
      ok: boolean;
      code: string;
      data: { checks: Record<string, { ok: boolean; status: string; detail?: string }> };
    };
    expect(code).toBe(0);
    expect(response.ok).toBe(true);
    expect(response.data.checks.review_backlog?.status).toBe('pending-review');
    expect(response.data.checks.review_backlog?.detail).toContain('mem-doctor-draft');
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
    await expect(readFile(join(fixture.path, 'AGENTS.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(fixture.path, 'CLAUDE.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
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
