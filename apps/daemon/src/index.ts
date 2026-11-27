import { join } from 'node:path';
import { AgentAdapterRegistry } from '../../../packages/adapters/src/index.js';
import { createLocalBgeM3Embedder } from '../../../packages/embedding/src/index.js';
import { DatabaseStore } from '../../../packages/storage/src/index.js';
import {
  SqliteAuditLog,
  enqueueScheduledConsolidationScan,
} from '../../../packages/application/src/index.js';
import { loadConfig, type ResolvedConfig } from '../../../packages/config/src/index.js';
import { enqueueScheduledReflectScan, REFLECT_JOB_KIND } from '../../../packages/learning/src/index.js';
import { AgentIngestionService, AutomaticSourceRuntime } from './ingestion.js';
import { NotificationService } from '../../../packages/notifications/src/index.js';
import { AgentAcceptanceService } from './acceptance.js';
import {
  daemonStatus,
  DaemonLease,
  DaemonPaths,
  startDaemonProcess,
  stopDaemon,
  type DaemonHealth,
  type DaemonLock,
  type DaemonStatus,
} from './lifecycle.js';
import { DaemonRuntime, defaultJobHandlers, resolvedConsolidationConfig, type DaemonRuntimeOptions } from './runtime.js';

/** Warns once per day when today's LLM usage reaches 80% of the configured budget. Returns true when a warning was emitted. */
export async function checkLlmBudgetWarning(database: DatabaseStore, config: ResolvedConfig): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  const raw = database.getMetadata(`llm-budget:${day}`);
  if (raw === null) return false;
  let usage: { calls?: number; tokens?: number; warned?: boolean };
  try {
    usage = JSON.parse(raw) as { calls?: number; tokens?: number; warned?: boolean };
  } catch {
    return false;
  }
  if (usage.warned === true) return false;
  const calls = usage.calls ?? 0;
  const tokens = usage.tokens ?? 0;
  const callsLimit = config.llm.dailyCap;
  const tokensLimit = config.llm.dailyTokens;
  const hot = (callsLimit !== undefined && callsLimit > 0 && calls >= callsLimit * 0.8)
    || (tokensLimit !== undefined && tokensLimit > 0 && tokens >= tokensLimit * 0.8);
  if (!hot) return false;
  database.upsertMetadata(`llm-budget:${day}`, JSON.stringify({ ...usage, warned: true }));
  await new NotificationService(database, new SqliteAuditLog(database)).enqueue({
    level: 'L1',
    kind: 'budget',
    subjectType: 'llm_budget',
    subjectId: day,
    title: 'LLM 预算告警',
    message: `今日 LLM 用量已达预算 80%（calls ${calls}${callsLimit === undefined ? '' : `/${callsLimit}`} · tokens ${tokens}${tokensLimit === undefined ? '' : `/${tokensLimit}`}）；超限后自动降级确定性路径。`,
    source: 'llm.budget',
    dedupeKey: `llm-budget-warn:${day}`,
  });
  return true;
}

/** Triggers reflect once enough new memories have been created since the last trigger (event-driven syntheses). */
export async function checkReflectOnAccept(database: DatabaseStore): Promise<boolean> {
  const now = Date.now();
  const lastScan = Number(database.getMetadata('reflect:accept-scan') ?? '0');
  if (now - lastScan < 60_000) return false;
  database.upsertMetadata('reflect:accept-scan', String(now));
  const watermark = database.getMetadata('reflect:accept-watermark') ?? '1970-01-01T00:00:00.000Z';
  const created = (await new SqliteAuditLog(database).list()).filter((event) => event.eventType === 'memory.created' && event.occurredAt > watermark).length;
  if (created < 3) return false;
  const queued = database.enqueueJobIfAbsent({
    id: `reflect-accept-${Math.floor(now / 3_600_000)}`,
    kind: REFLECT_JOB_KIND,
    payload: '{}',
  });
  database.upsertMetadata('reflect:accept-watermark', new Date(now).toISOString());
  return queued;
}

export async function createDefaultDaemonRuntime(brainPath: string, suppliedConfig?: ResolvedConfig): Promise<DaemonRuntime> {
  const config = suppliedConfig ?? (await loadConfig({ configPath: join(brainPath, 'config.yaml'), isolatedBrainPath: brainPath, overrides: { paths: { brain: brainPath } } })).config;
  const database = new DatabaseStore(join(brainPath, 'taga.db'));
  const registry = new AgentAdapterRegistry();
  const configuredAgents = config.agents.enabled;
  const ingestion = new AgentIngestionService(database, registry, { lookbackDays: config.collection.lookbackDays });
  const sourceRuntime = new AutomaticSourceRuntime(database, ingestion, { audit: new SqliteAuditLog(database), lookbackDays: config.collection.lookbackDays });
  const options: DaemonRuntimeOptions = {
    brainPath,
    database,
    closeDatabaseOnExit: true,
    ...(config.retrieval.semantic.modelPath.length === 0 ? {} : {
      embedder: createLocalBgeM3Embedder({ modelPath: config.retrieval.semantic.modelPath, batchSize: 4 }),
    }),
    handlers: new Map([
      ...defaultJobHandlers(brainPath, database, config),
      ['source.ingest', async (job) => { await sourceRuntime.handle(job); }],
    ]),
    watchers: [
      ...(configuredAgents.length === 0 ? [] : [{
        id: 'agent-sources',
        async run(): Promise<void> {
          await ingestion.runOnce(configuredAgents);
        },
      }]),
      {
        id: 'consolidation-scheduler',
        run(): Promise<void> {
          enqueueScheduledConsolidationScan(database, resolvedConsolidationConfig(config), new Date());
          return Promise.resolve();
        },
      },
      {
        id: 'reflect-scheduler',
        run(): Promise<void> {
          enqueueScheduledReflectScan(database, {
            mode: config.reflection.enabled ? 'on' : 'off',
            intervalMs: config.reflection.intervalMs,
            windowDays: config.reflection.windowDays,
            minGroupSize: config.reflection.minGroupSize,
            maxGroups: config.reflection.maxGroups,
          }, new Date());
          return Promise.resolve();
        },
      },
      {
        id: 'reflect-on-accept',
        run(): Promise<void> {
          return checkReflectOnAccept(database).then(() => undefined);
        },
      },
      {
        id: 'llm-budget-warn',
        run(): Promise<void> {
          return checkLlmBudgetWarning(database, config).then(() => undefined);
        },
      },
    ],
  };
  return new DaemonRuntime(options);
}

export {
  AgentAcceptanceService,
  AgentIngestionService,
  AutomaticSourceRuntime,
  daemonStatus,
  DaemonLease,
  DaemonPaths,
  DaemonRuntime,
  startDaemonProcess,
  stopDaemon,
};
export type { AgentAcceptanceInput, AgentAcceptanceReport } from './acceptance.js';
export type { AgentIngestionOptions, AgentIngestionReport, SourceRuntimeHealth, SourceTrigger, SourceTriggerReport } from './ingestion.js';
export type { DaemonHealth, DaemonLock, DaemonStatus };
export type { DaemonJobHandler, DaemonRuntimeOptions, DaemonWatcher } from './runtime.js';
export { semanticJobHandlers } from './semantic.js';
