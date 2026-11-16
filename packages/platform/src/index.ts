import { execFile, spawn } from 'node:child_process';
import { access, chmod, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, posix, resolve, win32 } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

export type SupportedPlatform = 'windows' | 'linux' | 'macos';

export interface PlatformPaths {
  readonly platform: SupportedPlatform | 'unsupported';
  readonly homeDirectory: string;
  readonly brainPath: string;
  readonly runtimeDirectory: string;
  readonly systemdUserDirectory: string | null;
  readonly launchdUserDirectory: string | null;
}

export interface ProcessController {
  exists(pid: number): boolean;
  terminate(pid: number): void;
  spawnDetached(file: string, args: readonly string[], env: NodeJS.ProcessEnv): void;
}

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandRunner = (file: string, args: readonly string[]) => Promise<CommandResult>;

export interface ServiceStatus {
  readonly installed: boolean;
  readonly active: boolean;
  readonly enabled: boolean;
  readonly unitPath: string;
  readonly detail?: string;
}

export interface SystemdServiceOptions {
  readonly brainPath: string;
  readonly configPath?: string;
  readonly daemonEntryPath: string;
  readonly nodePath?: string;
  readonly homeDirectory?: string;
  readonly configHome?: string;
  readonly unitName?: string;
  readonly runner?: CommandRunner;
}

export interface LaunchdServiceOptions {
  readonly brainPath: string;
  readonly configPath?: string;
  readonly daemonEntryPath: string;
  readonly nodePath?: string;
  readonly homeDirectory?: string;
  readonly label?: string;
  readonly uid?: number;
  readonly runner?: CommandRunner;
}

export class NodeProcessController implements ProcessController {
  exists(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return hasCode(error, 'EPERM');
    }
  }

  terminate(pid: number): void {
    process.kill(pid, 'SIGTERM');
  }

  spawnDetached(file: string, args: readonly string[], env: NodeJS.ProcessEnv): void {
    const child = spawn(file, [...args], { detached: true, env, stdio: 'ignore', windowsHide: true });
    child.unref();
  }
}

export class PollingPathWatcher {
  private snapshot = new Map<string, string>();

  constructor(
    readonly id: string,
    private readonly paths: readonly string[],
    private readonly onChange: (paths: readonly string[]) => Promise<void>,
  ) {}

  async run(): Promise<void> {
    const next = new Map<string, string>();
    for (const path of this.paths) {
      try {
        const details = await stat(path);
        next.set(path, `${details.mtimeMs}:${details.size}`);
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) throw error;
      }
    }
    if (this.snapshot.size === 0) {
      this.snapshot = next;
      return;
    }
    const changed = [...new Set([...this.snapshot.keys(), ...next.keys()])]
      .filter((path) => this.snapshot.get(path) !== next.get(path));
    this.snapshot = next;
    if (changed.length > 0) await this.onChange(changed);
  }
}

export class SystemdUserServiceManager {
  readonly unitName: string;
  readonly unitPath: string;
  private readonly runner: CommandRunner;
  private readonly nodePath: string;

  constructor(private readonly options: SystemdServiceOptions) {
    const home = options.homeDirectory ?? homedir();
    const configHome = options.configHome ?? process.env.XDG_CONFIG_HOME ?? join(home, '.config');
    this.unitName = options.unitName ?? 'taga.service';
    this.unitPath = join(configHome, 'systemd', 'user', this.unitName);
    this.runner = options.runner ?? defaultCommandRunner;
    this.nodePath = options.nodePath ?? process.execPath;
  }

  async install(): Promise<ServiceStatus> {
    await ensurePrivateDirectory(dirname(this.unitPath));
    await atomicPrivateWrite(this.unitPath, renderSystemdUnit(this.nodePath, this.options.daemonEntryPath, this.options.brainPath, this.options.configPath));
    await this.runner('systemctl', ['--user', 'daemon-reload']);
    await this.runner('systemctl', ['--user', 'enable', '--now', this.unitName]);
    return this.status();
  }

  async start(): Promise<ServiceStatus> {
    await this.requireInstalled();
    await this.runner('systemctl', ['--user', 'start', this.unitName]);
    return this.status();
  }

  async stop(): Promise<ServiceStatus> {
    if (!await this.isInstalled()) return this.status();
    await this.runner('systemctl', ['--user', 'stop', this.unitName]);
    return this.status();
  }

  async restart(): Promise<ServiceStatus> {
    await this.requireInstalled();
    await this.runner('systemctl', ['--user', 'restart', this.unitName]);
    return this.status();
  }

  async uninstall(): Promise<ServiceStatus> {
    if (await this.isInstalled()) {
      await this.runner('systemctl', ['--user', 'disable', '--now', this.unitName]).catch(() => ({ stdout: '', stderr: '' }));
      await rm(this.unitPath, { force: true });
      await this.runner('systemctl', ['--user', 'daemon-reload']);
    }
    return this.status();
  }

  async status(): Promise<ServiceStatus> {
    const installed = await this.isInstalled();
    if (!installed) return { installed: false, active: false, enabled: false, unitPath: this.unitPath };
    const active = await succeeds(this.runner, 'systemctl', ['--user', 'is-active', '--quiet', this.unitName]);
    const enabled = await succeeds(this.runner, 'systemctl', ['--user', 'is-enabled', '--quiet', this.unitName]);
    return { installed, active, enabled, unitPath: this.unitPath };
  }

  private async isInstalled(): Promise<boolean> {
    try {
      await access(this.unitPath, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  private async requireInstalled(): Promise<void> {
    if (!await this.isInstalled()) throw new Error(`systemd user service is not installed: ${this.unitPath}`);
  }
}

export class LaunchdUserServiceManager {
  readonly label: string;
  readonly plistPath: string;
  private readonly runner: CommandRunner;
  private readonly nodePath: string;
  private readonly domain: string;

  constructor(private readonly options: LaunchdServiceOptions) {
    const home = options.homeDirectory ?? homedir();
    const uid = options.uid ?? process.getuid?.() ?? 501;
    this.label = options.label ?? 'com.taga.daemon';
    this.plistPath = join(home, 'Library', 'LaunchAgents', `${this.label}.plist`);
    this.runner = options.runner ?? defaultCommandRunner;
    this.nodePath = options.nodePath ?? process.execPath;
    this.domain = `gui/${uid}`;
  }

  async install(): Promise<ServiceStatus> {
    await ensurePrivateDirectory(dirname(this.plistPath));
    await atomicPrivateWrite(this.plistPath, renderLaunchdPlist(this.label, this.nodePath, this.options.daemonEntryPath, this.options.brainPath, this.options.configPath));
    await this.runner('launchctl', ['bootout', this.domain, this.plistPath]).catch(() => ({ stdout: '', stderr: '' }));
    await this.runner('launchctl', ['bootstrap', this.domain, this.plistPath]);
    await this.runner('launchctl', ['enable', this.serviceTarget()]);
    return this.status();
  }

  async start(): Promise<ServiceStatus> {
    await this.requireInstalled();
    await this.runner('launchctl', ['kickstart', '-k', this.serviceTarget()]);
    return this.status();
  }

  async stop(): Promise<ServiceStatus> {
    if (!await this.isInstalled()) return this.status();
    await this.runner('launchctl', ['kill', 'SIGTERM', this.serviceTarget()]).catch(() => ({ stdout: '', stderr: '' }));
    return this.status();
  }

  async restart(): Promise<ServiceStatus> {
    return this.start();
  }

  async uninstall(): Promise<ServiceStatus> {
    if (await this.isInstalled()) {
      await this.runner('launchctl', ['bootout', this.domain, this.plistPath]).catch(() => ({ stdout: '', stderr: '' }));
      await rm(this.plistPath, { force: true });
    }
    return this.status();
  }

  async status(): Promise<ServiceStatus> {
    const installed = await this.isInstalled();
    if (!installed) return { installed: false, active: false, enabled: false, unitPath: this.plistPath };
    const active = await succeeds(this.runner, 'launchctl', ['print', this.serviceTarget()]);
    return { installed, active, enabled: true, unitPath: this.plistPath, detail: active ? 'launchd user agent loaded' : 'launchd user agent installed but not loaded; foreground daemon remains available' };
  }

  private serviceTarget(): string {
    return `${this.domain}/${this.label}`;
  }

  private async isInstalled(): Promise<boolean> {
    try {
      await access(this.plistPath, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  private async requireInstalled(): Promise<void> {
    if (!await this.isInstalled()) throw new Error(`launchd user service is not installed: ${this.plistPath}`);
  }
}

export function platformPaths(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): PlatformPaths {
  const pathApi = platform === 'win32' ? win32 : platform === 'linux' || platform === 'darwin' ? posix : { join, resolve };
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const brainPath = pathApi.resolve(env.TAGA_BRAIN ?? pathApi.join(home, '.taga', 'brain'));
  return {
    platform: platform === 'win32' ? 'windows' : platform === 'linux' ? 'linux' : platform === 'darwin' ? 'macos' : 'unsupported',
    homeDirectory: home,
    brainPath,
    runtimeDirectory: pathApi.join(brainPath, '.taga'),
    systemdUserDirectory: platform === 'linux' ? pathApi.resolve(env.XDG_CONFIG_HOME ?? pathApi.join(home, '.config'), 'systemd', 'user') : null,
    launchdUserDirectory: platform === 'darwin' ? pathApi.join(home, 'Library', 'LaunchAgents') : null,
  };
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(path, 0o700);
}

export async function platformHealth(brainPath: string, platform: NodeJS.Platform = process.platform): Promise<Record<string, { ok: boolean; status: string; detail?: string }>> {
  const checks: Record<string, { ok: boolean; status: string; detail?: string }> = {};
  checks.platform = platform === 'win32' || platform === 'linux' || platform === 'darwin'
    ? { ok: true, status: platform === 'win32' ? 'windows' : platform === 'linux' ? 'linux' : 'macos' }
    : { ok: false, status: 'unsupported', detail: platform };
  try {
    await ensurePrivateDirectory(brainPath);
    await access(brainPath, constants.R_OK | constants.W_OK);
    checks.filesystem = { ok: true, status: 'read-write' };
  } catch (error) {
    checks.filesystem = { ok: false, status: 'failed', detail: errorMessage(error) };
  }
  if (platform === 'linux') {
    const available = await succeeds(defaultCommandRunner, 'systemctl', ['--user', '--version']);
    checks.systemd = available ? { ok: true, status: 'available' } : { ok: false, status: 'unavailable', detail: 'install systemd or run `taga daemon run` in the foreground' };
  } else {
    checks.systemd = { ok: true, status: 'not-applicable', detail: 'systemd user services are Linux-only' };
  }
  if (platform === 'darwin') {
    const available = await succeeds(defaultCommandRunner, 'launchctl', ['help']);
    checks.launchd = available
      ? { ok: true, status: 'available' }
      : { ok: true, status: 'degraded', detail: 'launchd is unavailable; run `taga daemon run` or `taga daemon start` in the foreground' };
  } else {
    checks.launchd = { ok: true, status: 'not-applicable', detail: 'launchd user agents are macOS-only' };
  }
  return checks;
}

export function renderSystemdUnit(nodePath: string, daemonEntryPath: string, brainPath: string, configPath?: string): string {
  const argumentsList = [`--brain=${brainPath}`, ...(configPath === undefined ? [] : [`--config=${configPath}`])].map(systemdQuote).join(' ');
  return `[Unit]\nDescription=Taga local knowledge daemon\nAfter=default.target\n\n[Service]\nType=simple\nExecStart=${systemdQuote(nodePath)} ${systemdQuote(daemonEntryPath)} ${argumentsList}\nRestart=on-failure\nRestartSec=2\nNoNewPrivileges=true\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
}

export function renderLaunchdPlist(label: string, nodePath: string, daemonEntryPath: string, brainPath: string, configPath?: string): string {
  const argumentsList = [nodePath, daemonEntryPath, `--brain=${brainPath}`, ...(configPath === undefined ? [] : [`--config=${configPath}`])]
    .map((value) => `    <string>${xmlEscape(value)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsList}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

async function atomicPrivateWrite(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, 'w', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    if (process.platform !== 'win32') await chmod(path, 0o600);
  } finally {
    await handle?.close();
    await rm(temporaryPath, { force: true });
  }
}

function systemdQuote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
}

function xmlEscape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

async function succeeds(runner: CommandRunner, file: string, args: readonly string[]): Promise<boolean> {
  try {
    await runner(file, args);
    return true;
  } catch {
    return false;
  }
}

async function defaultCommandRunner(file: string, args: readonly string[]): Promise<CommandResult> {
  const result = await promisify(execFile)(file, [...args], { encoding: 'utf8', windowsHide: true });
  return { stdout: result.stdout, stderr: result.stderr };
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
