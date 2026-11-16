import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AgentAdapterRegistry,
  ClineAgentAdapter,
  CursorAgentAdapter,
  RooAgentAdapter,
  WindsurfAgentAdapter,
} from '../packages/adapters/src/index.js';
import { runCli } from '../apps/cli/src/index.js';
import { DomainPackService } from '../packages/domain-packs/src/index.js';
import { parseMemory } from '../packages/domain/src/index.js';
import {
  LaunchdUserServiceManager,
  platformPaths,
  renderLaunchdPlist,
  type CommandRunner,
} from '../packages/platform/src/index.js';
import { DatabaseStore, markerBegin, writeMarkdownDocument } from '../packages/storage/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';

const timestamp = '2026-11-12T12:00:00.000Z';

describe('M3-06 agent distribution', () => {
  it('reports truthful static-only capabilities for Cursor, Windsurf, Cline, and Roo', async () => {
    const fixture = await createTemporaryDirectory();
    const registry = new AgentAdapterRegistry([
      new CursorAgentAdapter({ homeDir: fixture.path, commandPath: 'cursor', version: '2.0.0' }),
      new WindsurfAgentAdapter({ homeDir: fixture.path, commandPath: 'windsurf', version: '1.0.0' }),
      new ClineAgentAdapter({ homeDir: fixture.path, commandPath: 'cline', version: '3.0.0' }),
      new RooAgentAdapter({ homeDir: fixture.path, commandPath: null }),
    ]);
    const detections = await registry.detect();
    expect(detections.map((item) => item.id)).toEqual(['cursor', 'windsurf', 'cline', 'roo']);
    expect(detections.slice(0, 3).every((item) => item.available && item.commandPath !== undefined && item.version !== undefined)).toBe(true);
    expect(detections.every((item) => item.capabilities.staticInjection && item.capabilities.mcp === 'stdio' && item.capabilities.source === 'none')).toBe(true);
    expect(detections.every((item) => item.degradedReasons.includes('automatic_collection_unavailable'))).toBe(true);
    expect(detections[3]).toMatchObject({ available: false, reason: 'agent_not_detected' });
    expect(await registry.get('cursor')?.sessionSources()).toEqual([]);
    await fixture.cleanup();
  });

  it('manages the Cursor rule atomically and distributes bounded context to all static targets', async () => {
    const fixture = await createTemporaryDirectory();
    const brain = join(fixture.path, 'brain');
    const cursorTarget = join(fixture.path, '.cursor', 'rules', 'taga.mdc');
    await mkdir(join(fixture.path, '.cursor', 'rules'), { recursive: true });
    await writeFile(cursorTarget, '---\ndescription: User rule\n---\nuser content\n', 'utf8');
    const output = streams();
    expect(await runCli(['init', '--yes', '--agent=cursor,windsurf,cline,roo', '--json', `--brain=${brain}`], { cwd: fixture.path, streams: output })).toBe(0);
    await writeMarkdownDocument(join(brain, 'lessons', 'global', 'lesson-static.md'), parseMemory({
      schemaVersion: 1,
      id: 'lesson-static',
      type: 'lessons',
      scope: { kind: 'global' },
      status: 'active',
      title: 'Static agent lesson',
      summary: 'Use bounded retries for static-only agents.',
      confidence: 0.9,
      sourceTrust: 'observed',
      visibility: 'private',
      created: timestamp,
      updated: timestamp,
      contentHash: 'sha256:static',
      sources: [{ kind: 'test', locator: 'm3-06-08.test.ts' }],
      anchors: [],
    }), 'Use bounded retries for static-only agents.');
    expect(await runCli(['inject', '--agent=cursor', '--json', `--brain=${brain}`], { cwd: fixture.path, streams: streams() })).toBe(0);
    const cursorContent = await readFile(cursorTarget, 'utf8');
    expect(cursorContent).toContain('description: User rule');
    expect(cursorContent).toContain('user content');
    expect(cursorContent).toContain(markerBegin);
    expect(cursorContent).toContain('bounded retries');
    for (const target of [join(fixture.path, '.windsurf', 'rules', 'taga.md'), join(fixture.path, '.clinerules', 'taga.md'), join(fixture.path, '.roo', 'rules', 'taga.md')]) {
      expect(await readFile(target, 'utf8')).toContain(markerBegin);
    }
    await fixture.cleanup();
  });
});

describe('M3-07 macOS and launchd', () => {
  it('resolves macOS paths and runs an idempotent launchd lifecycle without deleting Brain data', async () => {
    const fixture = await createTemporaryDirectory();
    const brain = join(fixture.path, 'brain with spaces');
    await mkdir(brain, { recursive: true });
    await writeFile(join(brain, 'keep.md'), 'keep', 'utf8');
    let active = false;
    const commands: string[] = [];
    const runner: CommandRunner = (file, args) => {
      commands.push(`${file} ${args.join(' ')}`);
      if (args[0] === 'bootstrap' || args[0] === 'kickstart') active = true;
      if (args[0] === 'bootout' || args[0] === 'kill') active = false;
      if (args[0] === 'print' && !active) return Promise.reject(new Error('not loaded'));
      return Promise.resolve({ stdout: '', stderr: '' });
    };
    const manager = new LaunchdUserServiceManager({
      brainPath: brain,
      configPath: join(fixture.path, 'config with spaces.yaml'),
      daemonEntryPath: '/Applications/Taga/daemon main.js',
      nodePath: '/usr/local/bin/node',
      homeDirectory: fixture.path,
      uid: 501,
      runner,
    });
    expect(platformPaths({ HOME: '/Users/tester' }, 'darwin')).toMatchObject({ platform: 'macos', brainPath: '/Users/tester/.taga/brain', launchdUserDirectory: '/Users/tester/Library/LaunchAgents' });
    expect((await manager.install()).active).toBe(true);
    expect((await manager.install()).active).toBe(true);
    const plist = await readFile(manager.plistPath, 'utf8');
    expect(plist).toContain('com.taga.daemon');
    expect(plist).toContain('--config=');
    expect(renderLaunchdPlist('com.taga.daemon', '/usr/bin/node', '/tmp/a&b.js', brain)).toContain('a&amp;b.js');
    expect((await manager.stop()).active).toBe(false);
    expect((await manager.start()).active).toBe(true);
    expect((await manager.restart()).active).toBe(true);
    expect((await manager.uninstall()).installed).toBe(false);
    expect(await readFile(join(brain, 'keep.md'), 'utf8')).toBe('keep');
    expect(commands.some((command) => command.includes('bootstrap gui/501'))).toBe(true);
    await fixture.cleanup();
  });
});

describe('M3-08 domain packs', () => {
  it('creates governed candidates for enabled writing, research, and office packs', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(join(fixture.path, 'taga.db'), { now: () => new Date(timestamp) });
    const service = new DomainPackService(database, undefined, () => new Date(timestamp));
    const inputs = [
      { packId: 'writing' as const, sourceRef: { kind: 'file' as const, locator: 'draft.md' }, raw: 'Use a claims checklist before publishing.' },
      { packId: 'research' as const, sourceRef: { kind: 'url' as const, locator: 'https://example.test/source' }, raw: 'Triangulate findings with two independent sources.' },
      { packId: 'office' as const, sourceRef: { kind: 'file' as const, locator: 'quarterly.xlsx' }, raw: 'Verify formulas before distributing the workbook.' },
    ];
    for (const input of inputs) {
      service.setEnabled(input.packId, true);
      const result = service.record({ ...input, projectId: 'project-1' });
      expect(result.status).toBe('candidate_created');
      expect(result.candidate).toMatchObject({ packId: input.packId, projectId: 'project-1', sensitivity: 'none', applicability: { status: 'applicable' }, decision: 'pending' });
      expect(result.candidate?.anchors).toEqual([input.sourceRef]);
      expect(service.contextContribution(input.packId)?.candidateIds).toContain(result.candidate?.id);
    }
    expect(database.listEvidence()).toHaveLength(3);
    expect(database.listCandidates()).toHaveLength(3);
    database.close();
    await fixture.cleanup();
  });

  it('keeps disabled packs isolated and reports unsafe or sensitive inputs without applying them', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(join(fixture.path, 'taga.db'), { now: () => new Date(timestamp) });
    const service = new DomainPackService(database, undefined, () => new Date(timestamp));
    expect(service.record({ packId: 'writing', raw: 'Normal draft', sourceRef: { kind: 'file', locator: 'draft.md' } }).status).toBe('disabled');
    service.setEnabled('writing', true);
    const unsafe = service.record({ packId: 'writing', raw: 'Publish this draft', sourceRef: { kind: 'file', locator: 'draft.md' }, safetyConditions: [{ id: 'approval-required', passed: false }] });
    expect(unsafe).toMatchObject({ status: 'unavailable', suggestion: { status: 'unavailable' } });
    const blocked = service.record({ packId: 'writing', raw: '-----BEGIN PRIVATE KEY-----secret-----END PRIVATE KEY-----', sourceRef: { kind: 'file', locator: 'private.md' } });
    expect(blocked.status).toBe('blocked');
    expect(service.suggest('writing', 'Publish document', false, 'approval-required')).toMatchObject({ status: 'unavailable', reason: 'approval-required' });
    expect(JSON.stringify(database.listEvidence())).not.toContain('secret');
    expect(database.listCandidates()).toHaveLength(0);
    database.close();
    await fixture.cleanup();
  });
});

function streams(): { readonly stdout: { value: string; write(chunk: string): void }; readonly stderr: { value: string; write(chunk: string): void } } {
  const output = { value: '', write(chunk: string) { this.value += chunk; } };
  const error = { value: '', write(chunk: string) { this.value += chunk; } };
  return { stdout: output, stderr: error };
}
