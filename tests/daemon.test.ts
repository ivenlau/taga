import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  daemonStatus,
  DaemonLease,
  DaemonPaths,
  DaemonRuntime,
} from '../apps/daemon/src/index.js';
import { JsonLogger } from '../packages/observability/src/index.js';
import { DatabaseStore } from '../packages/storage/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';

describe('M2 daemon runtime', () => {
  it('prevents two active instances and recovers a stale lock', async () => {
    const fixture = await createTemporaryDirectory();
    const lease = await DaemonLease.acquire(fixture.path);
    await expect(DaemonLease.acquire(fixture.path)).rejects.toThrow('already running');
    await lease.release();
    const paths = new DaemonPaths(fixture.path);
    await mkdir(paths.runtimeDirectory, { recursive: true });
    await writeFile(paths.lockPath, JSON.stringify({ schemaVersion: 1, pid: 99_999_999, startedAt: '2026-11-11T00:00:00.000Z' }), 'utf8');
    expect((await daemonStatus(fixture.path)).stale).toBe(true);
    const recovered = await DaemonLease.acquire(fixture.path);
    expect(recovered.lock.pid).toBe(process.pid);
    await recovered.release();
    await fixture.cleanup();
  });

  it('processes durable jobs, retries failures, and isolates watcher errors in health', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(join(fixture.path, 'taga.db'));
    database.enqueueJob({ id: 'job-ok', kind: 'ok', payload: '{}' });
    database.enqueueJob({ id: 'job-fail', kind: 'fail', payload: '{}' });
    const logger = new JsonLogger('daemon', () => undefined);
    const runtime = new DaemonRuntime({
      brainPath: fixture.path,
      database,
      pollIntervalMs: 10,
      watcherIntervalMs: 20,
      maxAttempts: 2,
      logger,
      handlers: new Map([
        ['ok', () => Promise.resolve()],
        ['fail', () => Promise.reject(new Error('expected worker failure'))],
      ]),
      watchers: [{ id: 'broken-watcher', run(): Promise<void> { return Promise.reject(new Error('expected watcher failure')); } }],
    });
    const controller = new AbortController();
    const running = runtime.run(controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    controller.abort();
    await running;
    expect(database.getJob('job-ok')?.status).toBe('succeeded');
    expect(database.getJob('job-fail')?.status).toBe('dead');
    expect(database.getJob('job-fail')?.attempts).toBe(2);
    const status = await daemonStatus(fixture.path);
    expect(status.running).toBe(false);
    expect(status.health?.jobs.succeeded).toBe(1);
    expect(status.health?.jobs.failed).toBeGreaterThanOrEqual(2);
    expect(status.health?.watchers.failures).toBeGreaterThanOrEqual(1);
    database.close();
    await fixture.cleanup();
  });
});
