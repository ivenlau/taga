import { join } from 'node:path';
import { AgentAdapterRegistry } from '../../../packages/adapters/src/index.js';
import { createLocalBgeM3Embedder } from '../../../packages/embedding/src/index.js';
import { DatabaseStore } from '../../../packages/storage/src/index.js';
import {
  SqliteAuditLog,
  enqueueScheduledConsolidationScan,
} from '../../../packages/application/src/index.js';
import { loadConfig, type ResolvedConfig } from '../../../packages/config/src/index.js';
import { enqueueScheduledReflectScan } from '../../../packages/learning/src/index.js';
import { AgentIngestionService, AutomaticSourceRuntime } from './ingestion.js';
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

export async function createDefaultDaemonRuntime(brainPath: string, suppliedConfig?: ResolvedConfig): Promise<DaemonRuntime> {
  const config = suppliedConfig ?? (await loadConfig({ configPath: join(brainPath, 'config.yaml'), isolatedBrainPath: brainPath, overrides: { paths: { brain: brainPath } } })).config;
  const database = new DatabaseStore(join(brainPath, 'taga.db'));
  const registry = new AgentAdapterRegistry();
  const configuredAgents = config.agents.enabled;
  const ingestion = new AgentIngestionService(database, registry);
  const sourceRuntime = new AutomaticSourceRuntime(database, ingestion, { audit: new SqliteAuditLog(database) });
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
