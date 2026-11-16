import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PollingPathWatcher,
  SystemdUserServiceManager,
  platformPaths,
  renderSystemdUnit,
  type CommandRunner,
} from '../packages/platform/src/index.js';
import { atomicWrite } from '../packages/storage/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';

describe('M2-08 platform and systemd support', () => {
  it('resolves Windows and Linux paths without leaking OS branches into domain services', () => {
    const windows = platformPaths({ USERPROFILE: 'C:\\Users\\tester' }, 'win32');
    const linux = platformPaths({ HOME: '/home/tester', XDG_CONFIG_HOME: '/home/tester/.config' }, 'linux');
    expect(windows.platform).toBe('windows');
    expect(windows.systemdUserDirectory).toBeNull();
    expect(linux).toMatchObject({ platform: 'linux', brainPath: '/home/tester/.taga/brain', systemdUserDirectory: '/home/tester/.config/systemd/user' });
  });

  it('installs and removes an idempotent systemd user service while preserving Brain data', async () => {
    const fixture = await createTemporaryDirectory();
    const brain = join(fixture.path, 'brain with spaces');
    await mkdir(brain, { recursive: true });
    await writeFile(join(brain, 'keep.md'), 'keep', 'utf8');
    let active = false;
    let enabled = false;
    const commands: string[] = [];
    const runner: CommandRunner = (file, args) => {
      commands.push(`${file} ${args.join(' ')}`);
      if (args.includes('enable')) { active = true; enabled = true; }
      if (args.includes('start') || args.includes('restart')) active = true;
      if (args.includes('stop')) active = false;
      if (args.includes('disable')) { active = false; enabled = false; }
      if (args.includes('is-active') && !active) return Promise.reject(new Error('inactive'));
      if (args.includes('is-enabled') && !enabled) return Promise.reject(new Error('disabled'));
      return Promise.resolve({ stdout: '', stderr: '' });
    };
    const manager = new SystemdUserServiceManager({
      brainPath: brain,
      configPath: join(fixture.path, 'config with spaces.yaml'),
      daemonEntryPath: '/opt/taga/daemon main.js',
      nodePath: '/usr/bin/node',
      configHome: join(fixture.path, '.config'),
      runner,
    });
    expect((await manager.install()).active).toBe(true);
    expect((await manager.install()).enabled).toBe(true);
    const unit = await readFile(manager.unitPath, 'utf8');
    expect(unit).toContain('UMask=0077');
    expect(unit).toContain('--config=');
    expect(renderSystemdUnit('/usr/bin/node', '/opt/taga/daemon.js', brain)).toContain('"--brain=');
    expect((await manager.restart()).active).toBe(true);
    expect((await manager.stop()).active).toBe(false);
    expect((await manager.start()).active).toBe(true);
    expect((await manager.uninstall()).installed).toBe(false);
    expect(await readFile(join(brain, 'keep.md'), 'utf8')).toBe('keep');
    expect(commands.filter((command) => command.includes('daemon-reload')).length).toBeGreaterThanOrEqual(2);
    await fixture.cleanup();
  });

  it('handles spaces, long paths, symlinks, atomic writes, and watcher restart', async () => {
    const fixture = await createTemporaryDirectory();
    const target = join(fixture.path, 'target with spaces');
    await mkdir(target, { recursive: true });
    const link = join(fixture.path, 'linked target');
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    const deep = join(link, ...Array.from({ length: 12 }, (_, index) => `long-directory-${index}`), 'state.txt');
    await atomicWrite(deep, 'first');
    expect(await readFile(deep, 'utf8')).toBe('first');
    const changes: string[][] = [];
    const firstWatcher = new PollingPathWatcher('watcher', [deep], (paths) => { changes.push([...paths]); return Promise.resolve(); });
    await firstWatcher.run();
    await atomicWrite(deep, 'second value');
    await firstWatcher.run();
    expect(changes.flat()).toContain(deep);
    const restarted = new PollingPathWatcher('watcher', [deep], () => Promise.reject(new Error('initial scan must not notify')));
    await restarted.run();
    await fixture.cleanup();
  });
});
