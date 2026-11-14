import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { NodeProcessController, type ProcessController } from '../../../packages/platform/src/index.js';
import { atomicWrite } from '../../../packages/storage/src/index.js';

const defaultProcessController = new NodeProcessController();

export interface DaemonLock {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly startedAt: string;
}

export interface DaemonHealth {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly status: 'starting' | 'running' | 'stopping';
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly jobs: {
    readonly processed: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly lastError?: string;
  };
  readonly watchers: {
    readonly runs: number;
    readonly failures: number;
    readonly lastError?: string;
  };
}

export interface DaemonStatus {
  readonly running: boolean;
  readonly stale: boolean;
  readonly pid?: number;
  readonly lockPath: string;
  readonly healthPath: string;
  readonly health?: DaemonHealth;
}

export class DaemonPaths {
  readonly runtimeDirectory: string;
  readonly lockPath: string;
  readonly healthPath: string;
  readonly stopPath: string;

  constructor(readonly brainPath: string) {
    this.runtimeDirectory = join(brainPath, '.taga');
    this.lockPath = join(this.runtimeDirectory, 'daemon.lock');
    this.healthPath = join(this.runtimeDirectory, 'daemon-health.json');
    this.stopPath = join(this.runtimeDirectory, 'daemon.stop');
  }
}

export class DaemonLease {
  private released = false;

  private constructor(
    readonly paths: DaemonPaths,
    readonly lock: DaemonLock,
  ) {}

  static async acquire(brainPath: string, clock: () => Date = () => new Date(), processController: ProcessController = defaultProcessController): Promise<DaemonLease> {
    const paths = new DaemonPaths(brainPath);
    await mkdir(paths.runtimeDirectory, { recursive: true });
    await rm(paths.stopPath, { force: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(paths.lockPath, 'wx');
        const lock: DaemonLock = { schemaVersion: 1, pid: process.pid, startedAt: clock().toISOString() };
        await handle.writeFile(JSON.stringify(lock), 'utf8');
        await handle.sync();
        await handle.close();
        return new DaemonLease(paths, lock);
      } catch (error) {
        await handle?.close().catch(() => undefined);
        if (!hasCode(error, 'EEXIST')) throw error;
        const existing = await readJson<DaemonLock>(paths.lockPath);
        if (existing !== null && processController.exists(existing.pid)) throw new Error(`daemon already running with pid ${existing.pid}`);
        await rm(paths.lockPath, { force: true });
      }
    }
    throw new Error('daemon lock could not be acquired');
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    const current = await readJson<DaemonLock>(this.paths.lockPath);
    if (current?.pid === this.lock.pid) await rm(this.paths.lockPath, { force: true });
    await rm(this.paths.stopPath, { force: true });
  }
}

export async function daemonStatus(brainPath: string, processController: ProcessController = defaultProcessController): Promise<DaemonStatus> {
  const paths = new DaemonPaths(brainPath);
  const lock = await readJson<DaemonLock>(paths.lockPath);
  const health = await readJson<DaemonHealth>(paths.healthPath);
  const running = lock !== null && processController.exists(lock.pid);
  return {
    running,
    stale: lock !== null && !running,
    ...(lock === null ? {} : { pid: lock.pid }),
    lockPath: paths.lockPath,
    healthPath: paths.healthPath,
    ...(health === null ? {} : { health }),
  };
}

export async function startDaemonProcess(
  brainPath: string,
  entryPath: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 5000,
  processController: ProcessController = defaultProcessController,
): Promise<DaemonStatus> {
  const current = await daemonStatus(brainPath, processController);
  if (current.running) return current;
  if (current.stale) await rm(new DaemonPaths(brainPath).lockPath, { force: true });
  const childEnv = { ...env };
  delete childEnv.CODEX_DAEMON_SHUTDOWN_SOCKET;
  delete childEnv.CODEX_TOOL_CALL_ID;
  processController.spawnDetached(process.execPath, [entryPath, `--brain=${brainPath}`], childEnv);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await daemonStatus(brainPath, processController);
    if (status.running && status.health?.status === 'running' && status.health.pid === status.pid) return status;
    await delay(50);
  }
  throw new Error('daemon did not become ready before timeout');
}

export async function stopDaemon(brainPath: string, timeoutMs = 5000, processController: ProcessController = defaultProcessController): Promise<DaemonStatus> {
  const paths = new DaemonPaths(brainPath);
  const current = await daemonStatus(brainPath, processController);
  if (!current.running) {
    if (current.stale) await rm(paths.lockPath, { force: true });
    return daemonStatus(brainPath, processController);
  }
  await atomicWrite(paths.stopPath, `${new Date().toISOString()}\n`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await daemonStatus(brainPath, processController);
    if (!status.running) return status;
    await delay(50);
  }
  if (current.pid !== undefined) {
    try {
      processController.terminate(current.pid);
    } catch {
      return daemonStatus(brainPath, processController);
    }
  }
  const killDeadline = Date.now() + 1000;
  while (Date.now() < killDeadline) {
    const status = await daemonStatus(brainPath, processController);
    if (!status.running) return status;
    await delay(50);
  }
  return daemonStatus(brainPath, processController);
}

export async function writeDaemonHealth(path: string, health: DaemonHealth): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(health)}\n`);
}

export async function stopRequested(path: string): Promise<boolean> {
  try {
    await readFile(path, 'utf8');
    return true;
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return false;
    throw error;
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if (hasCode(error, 'ENOENT') || error instanceof SyntaxError) return null;
    throw error;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
