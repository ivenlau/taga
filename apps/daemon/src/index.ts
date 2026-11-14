import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { AgentAdapterRegistry } from '../../../packages/adapters/src/index.js';
import { DatabaseStore } from '../../../packages/storage/src/index.js';
import { SqliteAuditLog } from '../../../packages/application/src/index.js';
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
import { DaemonRuntime, defaultJobHandlers, type DaemonRuntimeOptions } from './runtime.js';

export async function createDefaultDaemonRuntime(brainPath: string): Promise<DaemonRuntime> {
  const database = new DatabaseStore(join(brainPath, 'taga.db'));
  const registry = new AgentAdapterRegistry();
  const configuredAgents = await configuredAgentIds(brainPath);
  const ingestion = new AgentIngestionService(database, registry);
  const sourceRuntime = new AutomaticSourceRuntime(database, ingestion, { audit: new SqliteAuditLog(database) });
  const options: DaemonRuntimeOptions = {
    brainPath,
    database,
    closeDatabaseOnExit: true,
    handlers: new Map([
      ...defaultJobHandlers(brainPath, database),
      ['source.ingest', async (job) => { await sourceRuntime.handle(job); }],
    ]),
    watchers: configuredAgents.length === 0 ? [] : [{
      id: 'agent-sources',
      async run(): Promise<void> {
        await ingestion.runOnce(configuredAgents);
      },
    }],
  };
  return new DaemonRuntime(options);
}

async function configuredAgentIds(brainPath: string): Promise<readonly string[]> {
  try {
    const parsed = parseYaml(await readFile(join(brainPath, '_config.yaml'), 'utf8')) as { agents?: Array<{ id?: unknown }> } | null;
    return parsed?.agents?.map((agent) => agent.id).filter((id): id is string => typeof id === 'string') ?? [];
  } catch {
    return [];
  }
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
