import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { JsonLogger, type Logger } from '../../../packages/observability/src/index.js';
import { RecoveryService } from '../../../packages/recovery/src/index.js';
import { GardenService } from '../../../packages/garden/src/index.js';
import {
  createSemanticDuplicateChecker,
  REFLECT_JOB_KIND,
  runCorrectionLearn,
  runLearn,
  runReflect,
  type LearnInput,
} from '../../../packages/learning/src/index.js';
import { MetricsService } from '../../../packages/metrics/src/index.js';
import { SqliteAuditLog, llmConfigFromEnv } from '../../../packages/application/src/index.js';
import { AutomaticDistillationService } from '../../../packages/distillation/src/index.js';
import { NotificationService } from '../../../packages/notifications/src/index.js';
import { MarkdownMemoryRepository } from '../../../packages/storage/src/index.js';
import { DatabaseStore, type JobRecord } from '../../../packages/storage/src/index.js';
import { semanticJobHandlers } from './semantic.js';
import { consolidationJobHandlers } from './consolidation.js';
import { buildDistillerChain } from '../../../packages/distillation/src/index.js';
import {
  DaemonLease,
  stopRequested,
  writeDaemonHealth,
  type DaemonHealth,
} from './lifecycle.js';

export type DaemonJobHandler = (job: JobRecord) => Promise<void>;

export interface DaemonWatcher {
  readonly id: string;
  run(): Promise<void>;
}

export interface DaemonRuntimeOptions {
  readonly brainPath: string;
  readonly pollIntervalMs?: number;
  readonly watcherIntervalMs?: number;
  readonly leaseMs?: number;
  readonly maxAttempts?: number;
  readonly handlers?: ReadonlyMap<string, DaemonJobHandler>;
  readonly watchers?: readonly DaemonWatcher[];
  readonly logger?: Logger;
  readonly clock?: () => Date;
  readonly database?: DatabaseStore;
  readonly closeDatabaseOnExit?: boolean;
}

export class DaemonRuntime {
  private readonly database: DatabaseStore;
  private readonly ownsDatabase: boolean;
  private readonly clock: () => Date;
  private readonly logger: Logger;
  private readonly workerId = `daemon-${process.pid}-${randomUUID()}`;

  constructor(private readonly options: DaemonRuntimeOptions) {
    this.database = options.database ?? new DatabaseStore(join(options.brainPath, 'taga.db'));
    this.ownsDatabase = options.database === undefined || options.closeDatabaseOnExit === true;
    this.clock = options.clock ?? (() => new Date());
    this.logger = options.logger ?? new JsonLogger('daemon');
  }

  async run(signal?: AbortSignal): Promise<void> {
    const lease = await DaemonLease.acquire(this.options.brainPath, this.clock);
    const startedAt = lease.lock.startedAt;
    let health: DaemonHealth = this.health('starting', startedAt, 0, 0, 0, 0, 0);
    await writeDaemonHealth(lease.paths.healthPath, health);
    let nextWatcherAt = 0;
    try {
      health = this.health('running', startedAt, 0, 0, 0, 0, 0);
      while (signal?.aborted !== true && !await stopRequested(lease.paths.stopPath)) {
        const jobResult = await this.processJobs();
        let watcherRuns = 0;
        let watcherFailures = 0;
        let watcherError: string | undefined;
        if (Date.now() >= nextWatcherAt) {
          const result = await this.runWatchers();
          watcherRuns = result.runs;
          watcherFailures = result.failures;
          watcherError = result.lastError;
          nextWatcherAt = Date.now() + (this.options.watcherIntervalMs ?? 1000);
        }
        health = {
          ...health,
          updatedAt: this.clock().toISOString(),
          jobs: {
            processed: health.jobs.processed + jobResult.processed,
            succeeded: health.jobs.succeeded + jobResult.succeeded,
            failed: health.jobs.failed + jobResult.failed,
            ...optionalLastError(jobResult.lastError ?? health.jobs.lastError),
          },
          watchers: {
            runs: health.watchers.runs + watcherRuns,
            failures: health.watchers.failures + watcherFailures,
            ...optionalLastError(watcherError ?? health.watchers.lastError),
          },
        };
        await writeDaemonHealth(lease.paths.healthPath, health);
        await delay(this.options.pollIntervalMs ?? 250, signal);
      }
      await writeDaemonHealth(lease.paths.healthPath, { ...health, status: 'stopping', updatedAt: this.clock().toISOString() });
    } finally {
      await lease.release();
      if (this.ownsDatabase) this.database.close();
    }
  }

  private async processJobs(): Promise<{ processed: number; succeeded: number; failed: number; lastError?: string }> {
    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    let lastError: string | undefined;
    const now = this.clock().toISOString();
    const ready = this.database.listJobs().filter((job) => job.availableAt <= now && ['queued', 'running', 'failed'].includes(job.status));
    for (const candidate of ready) {
      const job = this.database.acquireJob(candidate.id, this.workerId, this.options.leaseMs ?? 30_000);
      if (job === null) continue;
      processed += 1;
      const handler = this.options.handlers?.get(job.kind);
      try {
        if (handler === undefined) throw new Error(`unsupported job kind: ${job.kind}`);
        await handler(job);
        this.database.completeJob(job.id, this.workerId);
        succeeded += 1;
        this.logger.info({ eventType: 'daemon.job_succeeded', jobId: job.id });
      } catch (error) {
        const message = safeError(error);
        const maxAttempts = this.options.maxAttempts ?? 3;
        const retryAt = job.attempts < maxAttempts
          ? new Date(this.clock().getTime() + Math.min(60_000, 1000 * 2 ** Math.max(0, job.attempts - 1))).toISOString()
          : undefined;
        this.database.failJob(job.id, this.workerId, message, retryAt);
        failed += 1;
        lastError = message;
        this.logger.error({ eventType: 'daemon.job_failed', jobId: job.id, errorCode: 'JOB_FAILED' });
      }
    }
    return { processed, succeeded, failed, ...(lastError === undefined ? {} : { lastError }) };
  }

  private async runWatchers(): Promise<{ runs: number; failures: number; lastError?: string }> {
    let runs = 0;
    let failures = 0;
    let lastError: string | undefined;
    for (const watcher of this.options.watchers ?? []) {
      runs += 1;
      try {
        await watcher.run();
        this.logger.debug({ eventType: 'daemon.watcher_succeeded' });
      } catch (error) {
        failures += 1;
        lastError = safeError(error);
        this.logger.error({ eventType: 'daemon.watcher_failed', errorCode: watcher.id });
      }
    }
    return { runs, failures, ...(lastError === undefined ? {} : { lastError }) };
  }

  private health(
    status: DaemonHealth['status'],
    startedAt: string,
    processed: number,
    succeeded: number,
    failed: number,
    watcherRuns: number,
    watcherFailures: number,
  ): DaemonHealth {
    return {
      schemaVersion: 1,
      pid: process.pid,
      status,
      startedAt,
      updatedAt: this.clock().toISOString(),
      jobs: { processed, succeeded, failed },
      watchers: { runs: watcherRuns, failures: watcherFailures },
    };
  }
}

export function defaultJobHandlers(brainPath: string, database: DatabaseStore): ReadonlyMap<string, DaemonJobHandler> {
  const audit = new SqliteAuditLog(database);
  const notifications = new NotificationService(database, audit);
  const duplicateChecker = createSemanticDuplicateChecker(brainPath);
  return new Map<string, DaemonJobHandler>([
    ...semanticJobHandlers(brainPath, database),
    ...consolidationJobHandlers(brainPath, database, { notifications }),
    ['reindex', async () => {
      await new RecoveryService(brainPath, database).reindex();
    }],
    ['learn.distill', async (job) => {
      const input = JSON.parse(job.payload) as LearnInput;
      await runLearn(input, { brainPath, audit });
    }],
    ['learn.correction', async (job) => {
      const payload = JSON.parse(job.payload) as { memoryId?: unknown; note?: unknown; project?: unknown };
      if (typeof payload.memoryId !== 'string') throw new Error('learn.correction payload memoryId is invalid');
      await runCorrectionLearn({
        memoryId: payload.memoryId,
        ...(typeof payload.note === 'string' && payload.note.length > 0 ? { note: payload.note } : {}),
        ...(typeof payload.project === 'string' ? { project: payload.project } : {}),
      }, { brainPath, audit });
    }],
    [REFLECT_JOB_KIND, async () => {
      const report = await runReflect({}, { brainPath, audit, llm: llmConfigFromEnv() });
      if (report.candidates > 0) {
        await notifications.enqueue({
          level: 'L1',
          kind: 'candidate',
          subjectType: 'reflect',
          subjectId: `reflect-${new Date().toISOString().slice(0, 10)}`,
          title: 'Reflect insights created',
          message: `${report.candidates} insight candidate(s) distilled from ${report.groupsReflected} memory group(s); garden proposals filed for possible consolidation.`,
          source: 'reflect.run',
          dedupeKey: `reflect:${new Date().toISOString().slice(0, 10)}`,
        });
      }
    }],
    ['garden.scan', async () => {
      const memories = await new MarkdownMemoryRepository(brainPath).list();
      const report = new GardenService(database).scanSafe(memories);
      for (const proposal of report.proposals.filter((item) => item.category === 'stale' || item.category === 'conflict')) {
        await notifications.enqueue({
          level: 'L1',
          kind: proposal.category === 'stale' ? 'stale' : 'conflict',
          subjectType: 'garden_proposal',
          subjectId: proposal.id,
          title: `${proposal.category} memory finding`,
          message: proposal.reason,
          source: 'garden.scan',
          dedupeKey: proposal.fingerprint,
        });
      }
    }],
    ['metrics.digest', async () => {
      await new MetricsService(database).digest({ refreshRequested: true, daemonAvailable: true });
    }],
    ['distill.auto', async (job) => {
      const payload = JSON.parse(job.payload) as { projectId?: string; sessionId?: string };
      await new AutomaticDistillationService(
        database,
        buildDistillerChain({ audit }),
        undefined,
        {
          audit,
          memories: new MarkdownMemoryRepository(brainPath),
          notifications,
          ...(duplicateChecker === undefined ? {} : {
            duplicateGate: async (candidate) => duplicateChecker(`${candidate.title}\n${candidate.summary}`),
          }),
        },
      ).run(payload);
    }],
  ]);
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000);
}

function optionalLastError(lastError: string | undefined): { readonly lastError?: string } {
  return lastError === undefined ? {} : { lastError };
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener('abort', () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}
