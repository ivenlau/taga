import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  DEFAULT_PROACTIVE_POLICY,
  GovernanceService,
  SqliteAuditLog,
  type LifecycleActor,
} from '../../../packages/application/src/index.js';
import { ContextPackBuilder } from '../../../packages/context/src/index.js';
import { BrainBrowser } from '../../../packages/browsing/src/index.js';
import { DevelopmentEvidenceService } from '../../../packages/development/src/index.js';
import { DatabaseCandidateRepository, ReviewService } from '../../../packages/distillation/src/index.js';
import { DomainPackService, isDomainPackId } from '../../../packages/domain-packs/src/index.js';
import { GardenService, type GardenAction, type GardenProposalStatus } from '../../../packages/garden/src/index.js';
import { MetricsService, type OutcomeKind } from '../../../packages/metrics/src/index.js';
import { NotificationService, type NotificationFeedback } from '../../../packages/notifications/src/index.js';
import { MemoryPrecheckService } from '../../../packages/precheck/src/index.js';
import {
  ensurePrivateDirectory,
  LaunchdUserServiceManager,
  platformHealth,
  platformPaths,
  SystemdUserServiceManager,
} from '../../../packages/platform/src/index.js';
import { AgentAdapterRegistry } from '../../../packages/adapters/src/index.js';
import {
  AgentAcceptanceService,
  AgentIngestionService,
  createDefaultDaemonRuntime,
  daemonStatus,
  startDaemonProcess,
  stopDaemon,
} from '../../daemon/src/index.js';
import {
  errorCodes,
  isTagaError,
  parseMemory,
  type ContextPack,
  type Memory,
  type SourceRef,
} from '../../../packages/domain/src/index.js';
import { FtsRetrievalProvider } from '../../../packages/retrieval/src/index.js';
import { createLocalBgeM3Embedder } from '../../../packages/embedding/src/index.js';
import {
  enqueueSemanticOptimize,
  enqueueSemanticRebuild,
  enqueueSemanticRemove,
  enqueueSemanticUpsert,
  ZvecMemoryIndex,
  ZvecSemanticRetriever,
} from '../../../packages/semantic-index/src/index.js';
import { probeZvecRuntime } from '../../../packages/zvec/src/index.js';
import { ProcedureService } from '../../../packages/procedures/src/index.js';
import { RecoveryService } from '../../../packages/recovery/src/index.js';
import { M3AcceptanceService, ReleaseGateService, type ReleaseMilestone } from '../../../packages/release/src/index.js';
import { redactText } from '../../../packages/redaction/src/index.js';
import {
  atomicWrite,
  BrainLayout,
  DatabaseStore,
  MarkdownMemoryRepository,
  contentHash,
  markerBegin,
  markerEnd,
  parseManagedBlock,
  parseMarkdownDocument,
} from '../../../packages/storage/src/index.js';
import { SessionContextService } from '../../../packages/session/src/index.js';

export const exitCodes = {
  success: 0,
  invalidInput: 1,
  notFound: 2,
  confirmationRequired: 3,
  permission: 4,
  consistency: 5,
  degraded: 6,
  partial: 7,
  internal: 10,
} as const;

export interface CliStreams {
  readonly stdout: { write(chunk: string): void };
  readonly stderr: { write(chunk: string): void };
}

export interface CliOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly streams?: CliStreams;
}

interface CliResponse {
  readonly ok: boolean;
  readonly code: string;
  readonly message: string;
  readonly data?: unknown;
  readonly warnings?: readonly string[];
  readonly request_id?: string;
}

interface ParsedArgs {
  readonly command: string[];
  readonly options: ReadonlyMap<string, string | true>;
  readonly positionals: string[];
}

interface CliContext {
  readonly cwd: string;
  readonly brainPath: string;
  readonly configPath: string;
  readonly databasePath: string;
  readonly json: boolean;
  readonly options: ReadonlyMap<string, string | true>;
}

interface ConfigFile {
  readonly schemaVersion: 1;
  readonly brainPath: string;
  readonly projectPath: string;
  readonly projectId: string;
  readonly agents: readonly { id: string; kind: string; configPath: string; targetPath: string; targetPaths?: readonly string[] }[];
  readonly remoteModelAllowed: false;
}

class CliFailure extends Error {
  constructor(
    readonly exitCode: number,
    readonly responseCode: string,
    message: string,
    readonly data?: unknown,
    readonly warnings?: readonly string[],
  ) {
    super(message);
    this.name = 'CliFailure';
  }
}

export async function runCli(argv: readonly string[], options: CliOptions = {}): Promise<number> {
  const streams = options.streams ?? { stdout: process.stdout, stderr: process.stderr };
  const requestId = randomUUID();
  const parsed = parseArgs(argv);
  const cwd = resolve(options.cwd ?? process.cwd());
  const json = parsed.options.get('json') === true;

  try {
    const context = createContext(parsed, cwd, options.env ?? process.env);
    const result = await dispatch(parsed, context);
    writeResponse(streams, json, { ...result, request_id: requestId });
    return result.ok ? exitCodes.success : exitCodes.partial;
  } catch (error) {
    const response = toErrorResponse(error, requestId);
    writeResponse(streams, json, response);
    return response.ok ? exitCodes.success : responseExitCode(error);
  }
}

function createContext(parsed: ParsedArgs, cwd: string, env: NodeJS.ProcessEnv): CliContext {
  const configuredBrain = parsed.options.get('brain');
  const defaultBrain = platformPaths(env).brainPath;
  const brainPath = resolve(cwd, typeof configuredBrain === 'string' ? configuredBrain : defaultBrain);
  return {
    cwd,
    brainPath,
    configPath: join(brainPath, '_config.yaml'),
    databasePath: join(brainPath, 'taga.db'),
    json: parsed.options.get('json') === true,
    options: parsed.options,
  };
}

async function dispatch(args: ParsedArgs, context: CliContext): Promise<CliResponse> {
  const [root, subcommand] = args.command;
  if (root === undefined) {
    throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'a command is required');
  }
  switch (root) {
    case 'init':
      return initCommand(context);
    case 'doctor':
      return doctorCommand(context);
    case 'daemon':
      return daemonCommand(subcommand, context);
    case 'agent':
      return agentCommand(subcommand, args.positionals, context);
    case 'reindex':
      return reindexCommand(context);
    case 'brain':
      return brainCommand(subcommand, context);
    case 'development':
    case 'dev':
      return developmentCommand(subcommand, args.positionals, context);
    case 'procedure':
      return procedureCommand(subcommand, args.positionals, context);
    case 'garden':
      return gardenCommand(subcommand, args.positionals, context);
    case 'digest':
      return digestCommand(subcommand, context);
    case 'notification':
    case 'notifications':
      return notificationCommand(subcommand, args.positionals, context);
    case 'stats':
      return statsCommand(subcommand, context);
    case 'vector':
      return vectorCommand(subcommand, context);
    case 'ledger':
      return ledgerCommand(context);
    case 'outcome':
      return outcomeCommand(subcommand, args.positionals, context);
    case 'release':
      return releaseCommand(subcommand, context);
    case 'memory':
      return memoryCommand(subcommand, args.positionals, context);
    case 'context':
      return contextCommand(subcommand, context);
    case 'precheck':
      return precheckCommand(context);
    case 'inject':
      return injectCommand(subcommand, context);
    case 'pack':
      return packCommand(subcommand, context);
    case 'review':
      return reviewCommand(subcommand, args.positionals, context);
    default:
      throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', `unknown command: ${root}`);
  }
}

async function initCommand(context: CliContext): Promise<CliResponse> {
  const projectPath = resolve(context.cwd, optionString(context.options, 'project') ?? context.cwd);
  const projectId = await projectIdentity(projectPath);
  const registry = new AgentAdapterRegistry();
  const requested = requestedAgentIds(optionString(context.options, 'agent') ?? 'local', registry);
  const agents = requested.map((agentId) => {
    const adapter = registry.get(agentId);
    const targetPaths = adapter?.staticTargets(projectPath) ?? [join(projectPath, agentId === 'claude' || agentId === 'claude-code' ? 'CLAUDE.md' : 'AGENTS.md')];
    const targetPath = targetPaths[0];
    if (targetPath === undefined) throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', `agent has no static target: ${agentId}`);
    return {
      id: adapter?.id ?? agentId,
      kind: adapter === null ? 'local' : 'adapter',
      configPath: join(context.brainPath, 'agents', `${adapter?.id ?? agentId}.yaml`),
      targetPath,
      targetPaths,
    };
  });
  const config: ConfigFile = {
    schemaVersion: 1,
    brainPath: context.brainPath,
    projectPath,
    projectId,
    agents,
    remoteModelAllowed: false,
  };
  const preview = {
    brainPath: context.brainPath,
    configPath: context.configPath,
    agentConfigPaths: agents.map((agent) => agent.configPath),
    projectPath,
    projectId,
    collectionScope: ['global', `project:${projectId}`],
    network: 'disabled',
    agents: agents.map((agent) => ({ id: agent.id, targetPath: agent.targetPath, targetPaths: agent.targetPaths })),
    changes: [...new Set([context.configPath, ...agents.flatMap((agent) => [agent.configPath, agent.targetPath])])],
  };
  if (!isConfirmed(context.options)) {
    throw new CliFailure(
      exitCodes.confirmationRequired,
      'CONFIRMATION_REQUIRED',
      'init preview is ready; rerun with --yes to write changes',
      preview,
    );
  }
  await ensurePrivateDirectory(context.brainPath);
  await mkdir(join(context.brainPath, 'agents'), { recursive: true });
  await writeYaml(context.configPath, config);
  for (const agent of agents) {
    await writeYaml(agent.configPath, { schemaVersion: 1, agentId: agent.id, projectId, targetPaths: agent.targetPaths });
    await ensureMarkerFile(agent.targetPath);
  }
  await mkdir(join(context.brainPath, 'global'), { recursive: true });
  const database = new DatabaseStore(context.databasePath);
  try {
    for (const agent of agents) database.upsertMetadata(`pack:enabled:${agent.id}`, 'true');
    if (database.getMetadata('brain.initialized') === null) {
      await new SqliteAuditLog(database).append({
        eventType: 'brain.initialized',
        actor: 'user',
        subjectType: 'brain',
        subjectId: projectId,
        occurredAt: new Date().toISOString(),
        reason: 'init --yes',
        payload: { projectPath, agentIds: agents.map((agent) => agent.id) },
      });
      database.upsertMetadata('brain.initialized', new Date().toISOString());
    }
  } finally {
    database.close();
  }
  return { ok: true, code: 'INITIALIZED', message: 'taga initialized', data: preview };
}

async function doctorCommand(context: CliContext): Promise<CliResponse> {
  const checks: Record<string, { ok: boolean; status: string; detail?: string }> = {};
  Object.assign(checks, await platformHealth(context.brainPath));
  const configResult = await readConfig(context.configPath);
  checks.configuration = configResult === null
    ? { ok: false, status: 'missing', detail: 'run taga init --yes' }
    : { ok: true, status: 'ok' };
  checks.permissions = await checkPermission(context.brainPath);
  checks.brain_path = await checkPath(context.brainPath);
  const scanned = await scanMarkdown(context.brainPath);
  checks.orphan_markdown = scanned.orphans.length === 0
    ? { ok: true, status: 'clean' }
    : { ok: false, status: 'orphaned', detail: JSON.stringify(scanned.orphans) };
  let database: DatabaseStore | undefined;
  try {
    await ensurePrivateDirectory(context.brainPath);
    database = new DatabaseStore(context.databasePath);
    const integrity = database.integrityCheck();
    checks.sqlite = { ok: integrity.ok, status: integrity.ok ? 'ok' : 'failed', detail: JSON.stringify(integrity) };
    checks.fts = { ok: integrity.ok, status: integrity.ok ? 'ok' : 'failed' };
    checks.migration = { ok: integrity.schemaVersion >= 1, status: `version-${integrity.schemaVersion}` };
    const markdownIds = new Set(scanned.records.map(({ memory }) => memory.id));
    const indexIds = new Set(database.listMemoryIndex().map((memory) => memory.id));
    const missingFromIndex = [...markdownIds].filter((id) => !indexIds.has(id));
    const staleInIndex = [...indexIds].filter((id) => !markdownIds.has(id));
    checks.dirty_index = missingFromIndex.length === 0 && staleInIndex.length === 0
      ? { ok: true, status: 'clean' }
      : { ok: false, status: 'drifted', detail: JSON.stringify({ missingFromIndex, staleInIndex }) };
    const jobs = database.listJobs();
    const failedJobs = jobs.filter((job) => job.status === 'dead' || job.status === 'failed');
    checks.jobs = failedJobs.length === 0
      ? { ok: true, status: jobs.length === 0 ? 'empty' : 'healthy' }
      : { ok: false, status: 'failed', detail: JSON.stringify(failedJobs.map((job) => job.id)) };
    const pendingRecovery = database.listMetadata('recovery:').filter(({ value }) => value !== 'complete');
    checks.recovery = pendingRecovery.length === 0
      ? { ok: true, status: 'clean' }
      : { ok: false, status: 'pending', detail: JSON.stringify(pendingRecovery) };
    const cursors = database.listMetadata('cursor:');
    checks.cursor = { ok: true, status: cursors.length === 0 ? 'not-configured' : 'configured', detail: cursors.length === 0 ? 'no session cursor has been checkpointed' : `${cursors.length} cursor(s)` };
    const sourceHealth = database.listMetadata('source-health:');
    const unhealthySources = sourceHealth.filter(({ value }) => {
      try {
        const parsed = JSON.parse(value) as { available?: boolean; failures?: readonly string[] };
        return parsed.available === false || (parsed.failures?.length ?? 0) > 0;
      } catch {
        return true;
      }
    });
    checks.source_runtime = {
      ok: unhealthySources.length === 0,
      status: sourceHealth.length === 0 ? 'not-configured' : unhealthySources.length === 0 ? 'healthy' : 'degraded',
      detail: JSON.stringify(sourceHealth.map(({ key, value }) => ({ source: key.slice('source-health:'.length), health: parseJsonUnknown(value) }))),
    };
  } catch (error) {
    checks.sqlite = { ok: false, status: 'failed', detail: errorMessage(error) };
  } finally {
    database?.close();
  }
  const zvec = await probeZvecRuntime({ collectionPath: join(context.brainPath, 'zvec'), accessMode: 'read-only' });
  checks.semantic_zvec = {
    ok: true,
    status: zvec.status === 'available' || zvec.status === 'not-configured' ? zvec.status : 'degraded',
    detail: JSON.stringify(zvec),
  };
  const semanticDatabase = new DatabaseStore(context.databasePath);
  try {
    const semanticIntegrity = await new ZvecMemoryIndex(join(context.brainPath, '.taga', 'semantic')).integrity();
    const semanticJobs = semanticDatabase.listJobs().filter((job) => job.kind.startsWith('semantic.'));
    const deadJobs = semanticJobs.filter((job) => job.status === 'dead');
    const pendingJobs = semanticJobs.filter((job) => ['queued', 'running', 'failed'].includes(job.status));
    checks.semantic_index = {
      ok: semanticIntegrity.ok,
      status: semanticIntegrity.activeGeneration === null ? 'not-configured' : semanticIntegrity.ok ? pendingJobs.length === 0 ? 'ready' : 'lagging' : 'degraded',
      detail: JSON.stringify({ integrity: semanticIntegrity, pendingJobs, deadJobs }),
    };
  } finally {
    semanticDatabase.close();
  }
  const detections = await new AgentAdapterRegistry().detect({ includeVersion: false, includeSourceScan: false, includeCommandLookup: false });
  const availableAgents = detections.filter((detection) => detection.available);
  checks.agent_detection = { ok: true, status: availableAgents.length === 0 ? 'none-detected' : 'available', detail: JSON.stringify(detections) };
  const daemon = await daemonStatus(context.brainPath);
  checks.daemon = { ok: true, status: daemon.running ? 'running' : 'degraded', detail: JSON.stringify(daemon) };
  checks.marker = await markerHealth(configResult);
  const redactionProbe = redactText('token=doctor-secret');
  checks.redaction = redactionProbe.text.includes('doctor-secret')
    ? { ok: false, status: 'failed', detail: 'redaction probe leaked a secret' }
    : { ok: true, status: 'built-in-rules' };
  checks.provider = { ok: true, status: daemon.running ? 'ok' : 'degraded', detail: daemon.running ? 'local daemon available' : 'daemon unavailable; Fast Path remains active' };
  const failed = Object.values(checks).filter((check) => !check.ok);
  const degraded = Object.values(checks).some((check) => check.status === 'degraded' || check.status === 'unknown');
  const warnings = degraded ? ['daemon or optional provider is unavailable; local Fast Path remains usable'] : undefined;
  return {
    ok: failed.length === 0,
    code: failed.length === 0 ? (degraded ? 'DOCTOR_DEGRADED' : 'DOCTOR_OK') : 'DOCTOR_FAILED',
    message: failed.length === 0 ? 'doctor completed' : 'doctor found failures',
    data: { checks },
    ...(warnings === undefined ? {} : { warnings }),
  };
}

function parseJsonUnknown(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { malformed: true };
  }
}

async function reindexCommand(context: CliContext): Promise<CliResponse> {
  const database = new DatabaseStore(context.databasePath);
  try {
    const repository = new MarkdownMemoryRepository(context.brainPath);
    const entries = await repository.records();
    if (context.options.get('apply') !== true) {
      return { ok: true, code: 'REINDEX_PREVIEW', message: 'reindex preview complete', data: { count: entries.length, apply: false } };
    }
    const report = await new RecoveryService(context.brainPath, database).reindex();
    return { ok: true, code: 'REINDEXED', message: 'memory index rebuilt', data: { ...report, apply: true } };
  } finally {
    database.close();
  }
}

async function brainCommand(subcommand: string | undefined, context: CliContext): Promise<CliResponse> {
  const database = new DatabaseStore(context.databasePath);
  try {
    const browser = new BrainBrowser(context.brainPath, database);
    if (subcommand === 'tree') {
      return { ok: true, code: 'BRAIN_TREE', message: 'brain tree loaded', data: await browser.tree() };
    }
    if (subcommand === 'list' || subcommand === 'ls') {
      return {
        ok: true,
        code: 'BRAIN_LIST',
        message: 'brain memories loaded',
        data: await browser.list({
          ...(optionString(context.options, 'type') === undefined ? {} : { type: optionString(context.options, 'type') as Memory['type'] }),
          ...(optionString(context.options, 'status') === undefined ? {} : { status: optionString(context.options, 'status') as Memory['status'] }),
          ...(optionString(context.options, 'project-id') === undefined ? {} : { projectId: optionString(context.options, 'project-id') as string }),
          ...(optionString(context.options, 'scope') === undefined ? {} : { scope: optionString(context.options, 'scope') as Memory['scope']['kind'] }),
          ...(numberOption(context.options, 'offset') === undefined ? {} : { offset: numberOption(context.options, 'offset') as number }),
          ...(numberOption(context.options, 'limit') === undefined ? {} : { limit: numberOption(context.options, 'limit') as number }),
        }),
      };
    }
    if (subcommand === 'summary') {
      return { ok: true, code: 'BRAIN_SUMMARY', message: 'brain summary loaded', data: await browser.summary() };
    }
    if (subcommand === 'detail') {
      const id = context.options.get('memory') as string | undefined;
      if (id === undefined) throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'brain detail requires --memory=<id>');
      const detail = await browser.detail(id, { includeBody: context.options.get('body') === true, includeEvidence: context.options.get('evidence') === true });
      if (detail === null) throw new CliFailure(exitCodes.notFound, 'NOT_FOUND', 'memory not found', { id });
      return { ok: true, code: 'BRAIN_DETAIL', message: 'brain detail loaded', data: detail };
    }
    if (subcommand === 'rebuild') {
      return { ok: true, code: 'BRAIN_REBUILT', message: 'brain relations rebuilt', data: await browser.rebuildRelations() };
    }
    throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'supported brain commands: tree, list, summary, detail, rebuild');
  } finally {
    database.close();
  }
}

async function developmentCommand(subcommand: string | undefined, positionals: readonly string[], context: CliContext): Promise<CliResponse> {
  const database = new DatabaseStore(context.databasePath);
  try {
    const service = new DevelopmentEvidenceService(database);
    const projectPath = resolve(context.cwd, optionString(context.options, 'project') ?? context.cwd);
    const projectId = optionString(context.options, 'project-id') ?? await projectIdentity(projectPath);
    if (subcommand === 'probe') {
      return { ok: true, code: 'DEVELOPMENT_PROBED', message: 'environment probe completed', data: await service.probeEnvironment(projectPath, projectId) };
    }
    if (subcommand === 'git') {
      const action = optionString(context.options, 'action') ?? 'commit';
      if (!['commit', 'fix', 'revert'].includes(action)) throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'development git action must be commit, fix, or revert');
      return { ok: true, code: 'DEVELOPMENT_EVIDENCE_CAPTURED', message: 'git evidence captured', data: service.recordGitAction({ action: action as 'commit' | 'fix' | 'revert', projectId, projectPath, ...(optionString(context.options, 'commit') === undefined ? {} : { commit: optionString(context.options, 'commit') as string }), summary: optionString(context.options, 'summary') ?? positionals.join(' ') }) };
    }
    if (subcommand === 'test') {
      const outcome = optionString(context.options, 'outcome');
      if (outcome !== 'failed' && outcome !== 'passed') throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'development test requires --outcome=failed|passed');
      return { ok: true, code: 'DEVELOPMENT_EVIDENCE_CAPTURED', message: 'test evidence captured', data: service.recordTestResult({ projectId, testCommand: optionString(context.options, 'command') ?? 'unknown', outcome, output: optionString(context.options, 'output') ?? positionals.join(' '), ...(numberOption(context.options, 'sequence') === undefined ? {} : { sequence: numberOption(context.options, 'sequence') as number }) }) };
    }
    if (subcommand === 'hook') {
      const hook = optionString(context.options, 'hook');
      if (hook === undefined) throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'development hook requires --hook=<name>');
      return { ok: true, code: 'DEVELOPMENT_EVIDENCE_CAPTURED', message: 'hook evidence captured', data: service.recordHook({ projectId, hook, payload: optionString(context.options, 'payload') ?? positionals.join(' ') }) };
    }
    throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'supported development commands: git, test, hook, probe');
  } finally {
    database.close();
  }
}

async function procedureCommand(subcommand: string | undefined, positionals: readonly string[], context: CliContext): Promise<CliResponse> {
  const database = new DatabaseStore(context.databasePath);
  try {
    const service = new ProcedureService(database);
    if (subcommand === undefined || subcommand === 'ls') return { ok: true, code: 'PROCEDURE_LIST', message: 'procedures loaded', data: service.list() };
    const id = optionString(context.options, 'memory') ?? positionals[0];
    if (id === undefined) throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'procedure memory id is required');
    const repository = new MarkdownMemoryRepository(context.brainPath);
    const memory = await repository.get(id);
    if (memory === null) throw new CliFailure(exitCodes.notFound, 'NOT_FOUND', 'procedure memory not found', { id });
    if (subcommand === 'show') return { ok: true, code: 'PROCEDURE_DETAIL', message: 'procedure loaded', data: { view: service.recall(memory), stats: service.stats(id) } };
    if (subcommand === 'export') {
      const exported = service.exportSkill(memory, optionString(context.options, 'project-id'));
      if (exported === null) throw new CliFailure(exitCodes.permission, 'NOT_RECALLABLE', 'procedure is not active, visible, or applicable');
      return { ok: true, code: 'PROCEDURE_EXPORTED', message: 'procedure skill exported', data: JSON.parse(exported) as unknown };
    }
    if (subcommand === 'event') {
      const kind = optionString(context.options, 'kind');
      if (!['recall', 'open', 'cite', 'useful', 'verified', 'not_useful'].includes(kind ?? '')) throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'procedure event requires a supported --kind');
      return { ok: true, code: 'PROCEDURE_EVENT_RECORDED', message: 'procedure reuse event recorded', data: service.recordReuse({ procedureId: id, kind: kind as 'recall' | 'open' | 'cite' | 'useful' | 'verified' | 'not_useful', ...(optionString(context.options, 'project-id') === undefined ? {} : { projectId: optionString(context.options, 'project-id') as string }), ...(optionString(context.options, 'task-id') === undefined ? {} : { taskId: optionString(context.options, 'task-id') as string }) }) };
    }
    if (subcommand === 'define') {
      return { ok: true, code: 'PROCEDURE_DEFINED', message: 'procedure metadata defined', data: service.define(memory, { prerequisites: csvOption(context.options, 'prerequisites'), steps: csvOption(context.options, 'steps'), verification: csvOption(context.options, 'verification'), applicability: csvOption(context.options, 'applicability'), safety: csvOption(context.options, 'safety'), risk: (optionString(context.options, 'risk') ?? 'medium') as 'low' | 'medium' | 'high' }) };
    }
    throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'supported procedure commands: ls, show, define, export, event');
  } finally {
    database.close();
  }
}

async function gardenCommand(subcommand: string | undefined, positionals: readonly string[], context: CliContext): Promise<CliResponse> {
  const database = new DatabaseStore(context.databasePath);
  try {
    const service = new GardenService(database);
    if (subcommand === 'scan') {
      const report = service.scanSafe(await new MarkdownMemoryRepository(context.brainPath).list());
      return { ok: true, code: report.degraded ? 'GARDEN_DEGRADED' : 'GARDEN_SCANNED', message: 'garden scan completed', data: report, ...(report.warnings.length === 0 ? {} : { warnings: report.warnings }) };
    }
    if (subcommand === 'schedule') {
      const day = new Date().toISOString().slice(0, 10);
      const id = `garden-scan:${day}`;
      const queued = database.enqueueJobIfAbsent({ id, kind: 'garden.scan', payload: JSON.stringify({ scheduledAt: new Date().toISOString() }) });
      return { ok: true, code: queued ? 'GARDEN_SCHEDULED' : 'GARDEN_ALREADY_SCHEDULED', message: queued ? 'garden scan scheduled' : 'garden scan already scheduled', data: { id, queued } };
    }
    if (subcommand === 'list' || subcommand === 'ls') {
      const status = optionString(context.options, 'status');
      const selected = status === undefined ? undefined : parseGardenStatus(status);
      return { ok: true, code: 'GARDEN_LIST', message: 'garden proposals loaded', data: service.list(selected) };
    }
    if (subcommand === 'show') {
      const id = optionString(context.options, 'proposal') ?? positionals[0];
      if (id === undefined) throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'garden show requires --proposal=<id>');
      const proposal = service.get(id);
      if (proposal === null) throw new CliFailure(exitCodes.notFound, 'NOT_FOUND', 'garden proposal not found', { id });
      return { ok: true, code: 'GARDEN_PROPOSAL', message: 'garden proposal loaded', data: proposal };
    }
    if (subcommand === 'accept' || subcommand === 'reject' || subcommand === 'ignore') {
      const id = optionString(context.options, 'proposal') ?? positionals[0];
      if (id === undefined) throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', `garden ${subcommand} requires --proposal=<id>`);
      if (subcommand === 'accept' && !isConfirmed(context.options)) throw new CliFailure(exitCodes.confirmationRequired, 'CONFIRMATION_REQUIRED', 'garden accept requires --yes');
      const config = await readConfig(context.configPath);
      const reviewed = await service.review(id, subcommand as 'accepted' | 'rejected' | 'ignored', {
        repository: new MarkdownMemoryRepository(context.brainPath),
        audit: new SqliteAuditLog(database),
        actor: { actor: 'user' },
        ...(optionString(context.options, 'action') === undefined ? {} : { action: optionString(context.options, 'action') as GardenAction }),
        ...(optionString(context.options, 'target') === undefined ? {} : { targetId: optionString(context.options, 'target') as string }),
        ...(optionString(context.options, 'replacement') === undefined ? {} : { replacementId: optionString(context.options, 'replacement') as string }),
      });
      const message = subcommand === 'accept' ? 'garden proposal accepted' : subcommand === 'reject' ? 'garden proposal rejected' : 'garden proposal ignored';
      return { ok: true, code: 'GARDEN_REVIEWED', message, data: { proposal: reviewed, config: config === null ? 'not-configured' : 'configured' } };
    }
    throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'supported garden commands: scan, schedule, list, show, accept, reject, ignore');
  } finally {
    database.close();
  }
}

async function digestCommand(subcommand: string | undefined, context: CliContext): Promise<CliResponse> {
  if (subcommand !== undefined && !['show', 'refresh', 'export'].includes(subcommand)) throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'supported digest commands: show, refresh, export');
  const database = new DatabaseStore(context.databasePath);
  try {
    const daemon = await daemonStatus(context.brainPath);
    const data = await new MetricsService(database).digest({
      ...metricsQuery(context),
      refreshRequested: subcommand === 'refresh',
      daemonAvailable: daemon.running,
    });
    const notifications = new NotificationService(database, new SqliteAuditLog(database));
    const delivered = await notifications.deliverPending('L1');
    return { ok: true, code: data.degraded ? 'DIGEST_DEGRADED' : 'DIGEST_READY', message: 'local digest generated', data: { ...data, notifications: delivered }, ...(data.warnings.length === 0 ? {} : { warnings: data.warnings }) };
  } finally {
    database.close();
  }
}

async function notificationCommand(subcommand: string | undefined, positionals: readonly string[], context: CliContext): Promise<CliResponse> {
  const database = new DatabaseStore(context.databasePath);
  try {
    const service = new NotificationService(database, new SqliteAuditLog(database));
    if (subcommand === undefined || subcommand === 'ls' || subcommand === 'list') {
      return { ok: true, code: 'NOTIFICATIONS_LISTED', message: 'local notifications loaded', data: service.list({ includeSuppressed: context.options.get('all') === true }) };
    }
    if (subcommand === 'feedback') {
      const id = optionString(context.options, 'id') ?? positionals[0];
      const kind = optionString(context.options, 'kind');
      if (id === undefined || !isNotificationFeedback(kind)) throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'notification feedback requires an id and --kind=opened|cited|useful|not_useful|dismissed');
      return { ok: true, code: 'NOTIFICATION_FEEDBACK_RECORDED', message: 'notification feedback recorded', data: await service.feedback(id, kind) };
    }
    throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'supported notification commands: ls, feedback');
  } finally {
    database.close();
  }
}

async function statsCommand(subcommand: string | undefined, context: CliContext): Promise<CliResponse> {
  const database = new DatabaseStore(context.databasePath);
  try {
    if (subcommand === 'baseline') {
      const baselineTokens = numberOption(context.options, 'baseline-tokens');
      const contextTokens = numberOption(context.options, 'context-tokens');
      if (baselineTokens === undefined || contextTokens === undefined) throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'stats baseline requires --baseline-tokens and --context-tokens');
      return {
        ok: true,
        code: 'TOKEN_BASELINE_RECORDED',
        message: 'token comparison recorded',
        data: new MetricsService(database).recordTokenComparison({
          baselineTokens,
          contextTokens,
          source: optionString(context.options, 'source') ?? 'manual',
          ...(optionString(context.options, 'project-id') === undefined ? {} : { projectId: optionString(context.options, 'project-id') as string }),
          ...(optionString(context.options, 'agent-id') === undefined ? {} : { agentId: optionString(context.options, 'agent-id') as string }),
          ...(optionString(context.options, 'task-id') === undefined ? {} : { taskId: optionString(context.options, 'task-id') as string }),
        }),
      };
    }
    if (subcommand !== undefined && subcommand !== 'show') throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'supported stats commands: show, baseline');
    return { ok: true, code: 'STATS_READY', message: 'local usage statistics generated', data: await new MetricsService(database).stats(metricsQuery(context)) };
  } finally {
    database.close();
  }
}

async function vectorCommand(subcommand: string | undefined, context: CliContext): Promise<CliResponse> {
  const database = new DatabaseStore(context.databasePath);
  try {
    const index = new ZvecMemoryIndex(join(context.brainPath, '.taga', 'semantic'));
    if (subcommand === undefined || subcommand === 'status') {
      const integrity = await index.integrity();
      const jobs = database.listJobs().filter((job) => job.kind.startsWith('semantic.'));
      return {
        ok: true,
        code: integrity.ok ? 'VECTOR_STATUS' : 'VECTOR_DEGRADED',
        message: integrity.ok ? 'semantic vector status loaded' : 'semantic vector index needs attention',
        data: {
          mode: process.env.TAGA_SEMANTIC_MODE ?? 'off',
          modelPathConfigured: typeof process.env.TAGA_BGE_M3_MODEL_PATH === 'string' && process.env.TAGA_BGE_M3_MODEL_PATH.length > 0,
          integrity,
          jobs: jobs.map(({ id, kind, status, attempts, lastError }) => ({ id, kind, status, attempts, lastError })),
        },
      };
    }
    if (subcommand === 'rebuild' || subcommand === 'sync') {
      const queued = enqueueSemanticRebuild(database);
      return { ok: true, code: subcommand === 'sync' ? 'VECTOR_SYNC_QUEUED' : 'VECTOR_REBUILD_QUEUED', message: queued ? `semantic vector ${subcommand} queued` : `semantic vector ${subcommand} already queued`, data: { queued } };
    }
    if (subcommand === 'optimize') {
      const queued = enqueueSemanticOptimize(database);
      return { ok: true, code: 'VECTOR_OPTIMIZE_QUEUED', message: queued ? 'semantic vector optimization queued' : 'semantic vector optimization already queued', data: { queued } };
    }
    throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'supported vector commands: status, sync, rebuild, optimize');
  } finally {
    database.close();
  }
}

async function ledgerCommand(context: CliContext): Promise<CliResponse> {
  const database = new DatabaseStore(context.databasePath);
  try {
    return { ok: true, code: 'LEDGER_READY', message: 'efficiency ledger generated', data: await new MetricsService(database).ledger(metricsQuery(context)) };
  } finally {
    database.close();
  }
}

function outcomeCommand(subcommand: string | undefined, positionals: readonly string[], context: CliContext): CliResponse {
  if (subcommand !== 'record') throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'supported outcome command: record');
  const kind = optionString(context.options, 'kind');
  if (!isOutcomeKind(kind)) throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'outcome record requires a supported --kind');
  const subjectId = optionString(context.options, 'subject-id') ?? positionals[0];
  if (subjectId === undefined) throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'outcome record requires --subject-id=<id>');
  const database = new DatabaseStore(context.databasePath);
  try {
    return {
      ok: true,
      code: 'OUTCOME_RECORDED',
      message: 'outcome event recorded',
      data: new MetricsService(database).record({
        kind,
        subjectType: optionString(context.options, 'subject-type') ?? 'memory',
        subjectId,
        ...(optionString(context.options, 'project-id') === undefined ? {} : { projectId: optionString(context.options, 'project-id') as string }),
        ...(optionString(context.options, 'agent-id') === undefined ? {} : { agentId: optionString(context.options, 'agent-id') as string }),
        ...(optionString(context.options, 'source-agent-id') === undefined ? {} : { sourceAgentId: optionString(context.options, 'source-agent-id') as string }),
        ...(optionString(context.options, 'task-id') === undefined ? {} : { taskId: optionString(context.options, 'task-id') as string }),
      }),
    };
  } finally {
    database.close();
  }
}

async function releaseCommand(subcommand: string | undefined, context: CliContext): Promise<CliResponse> {
  const database = new DatabaseStore(context.databasePath);
  try {
    const service = new ReleaseGateService(context.brainPath, database);
    const milestone = releaseMilestone(optionString(context.options, 'milestone'));
    if (subcommand === undefined || subcommand === 'check' || subcommand === 'export') {
      const audit = await service.check(milestone);
      return { ok: true, code: audit.passed ? `${milestone}_RELEASE_READY` : `${milestone}_RELEASE_BLOCKED`, message: audit.passed ? `${milestone} release gates passed` : `${milestone} release gates have blockers`, data: audit, ...(audit.passed ? {} : { warnings: audit.blockers }) };
    }
    if (subcommand === 'manifest') return { ok: true, code: `${milestone}_RELEASE_MANIFEST`, message: `${milestone} release gate manifest loaded`, data: service.manifest(milestone) };
    if (subcommand === 'evidence') return { ok: true, code: `${milestone}_RELEASE_EVIDENCE`, message: `${milestone} release evidence loaded`, data: service.evidence(optionString(context.options, 'gate')) };
    if (subcommand === 'reuse') {
      if (!isConfirmed(context.options)) throw new CliFailure(exitCodes.confirmationRequired, 'CONFIRMATION_REQUIRED', 'cross-agent reuse recording requires --yes');
      const sourceAgentId = optionString(context.options, 'source-agent');
      const consumingAgentId = optionString(context.options, 'consumer-agent');
      const evidenceId = optionString(context.options, 'evidence');
      const memoryId = optionString(context.options, 'memory');
      const contextArtifact = optionString(context.options, 'artifact');
      if (sourceAgentId === undefined || consumingAgentId === undefined || evidenceId === undefined || memoryId === undefined || contextArtifact === undefined) throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'release reuse requires --source-agent, --consumer-agent, --evidence, --memory, and --artifact');
      return { ok: true, code: 'M3_CROSS_AGENT_REUSE_RECORDED', message: 'cross-agent reuse evidence recorded', data: new M3AcceptanceService(database).recordCrossAgentReuse({ sourceAgentId, consumingAgentId, evidenceId, memoryId, contextArtifact }) };
    }
    if (subcommand === 'record') {
      if (!isConfirmed(context.options)) throw new CliFailure(exitCodes.confirmationRequired, 'CONFIRMATION_REQUIRED', 'release evidence recording requires --yes');
      const gateId = optionString(context.options, 'gate');
      const status = optionString(context.options, 'status');
      if (gateId === undefined || (status !== 'passed' && status !== 'failed')) throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'release record requires --gate=<id> --status=passed|failed');
      return {
        ok: true,
        code: `${milestone}_RELEASE_EVIDENCE_RECORDED`,
        message: `${milestone} release evidence recorded`,
        data: service.recordEvidence({ gateId, status, artifact: optionString(context.options, 'artifact') ?? 'manual', details: optionString(context.options, 'details') ?? 'manual release evidence' }),
      };
    }
    throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'supported release commands: manifest, check, export, evidence, record, reuse');
  } finally {
    database.close();
  }
}

function releaseMilestone(value: string | undefined): ReleaseMilestone {
  if (value === undefined || value === 'M3' || value === 'm3') return 'M3';
  if (value === 'M4' || value === 'm4') return 'M4';
  if (value === 'M2' || value === 'm2') return 'M2';
  throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', `unsupported release milestone: ${value}`);
}

async function memoryCommand(
  subcommand: string | undefined,
  positionals: readonly string[],
  context: CliContext,
): Promise<CliResponse> {
  const repository = new MarkdownMemoryRepository(context.brainPath);
  const memories = await repository.list();
  if (subcommand === 'search') {
    const query = optionString(context.options, 'query') ?? positionals[0];
    if (query === undefined || query.length === 0) throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'memory search requires --query=<text> or a query argument');
    const database = new DatabaseStore(context.databasePath);
    try {
      const provider = new FtsRetrievalProvider(database);
      const input = {
        query,
        limit: numberOption(context.options, 'limit') ?? 10,
        ...(context.options.get('include-draft') === true ? { includeDraft: true } : {}),
      };
      const mode = optionString(context.options, 'semantic-mode') ?? process.env.TAGA_SEMANTIC_MODE ?? 'off';
      const semantic = mode === 'off' ? undefined : createCliSemanticRetriever(context, database);
      const lexical = provider.searchSafe(input);
      const retrieval = mode === 'off'
        ? lexical
        : mode === 'shadow'
          ? await provider.searchHybrid(input, semantic).then((observed) => ({ ...lexical, degraded: observed.degraded }))
          : await provider.searchHybrid(input, semantic);
      return { ok: true, code: 'MEMORY_SEARCH', message: 'memories searched', data: { mode, degraded: retrieval.degraded, results: retrieval.items } };
    } finally {
      database.close();
    }
  }
  if (subcommand === 'ls') {
    const filtered = memories.filter((memory) => {
      const type = optionString(context.options, 'type');
      const status = optionString(context.options, 'status');
      return (type === undefined || memory.type === type) && (status === undefined || memory.status === status);
    });
    return { ok: true, code: 'MEMORY_LIST', message: 'memories loaded', data: filtered };
  }
  const id = positionals[0];
  if (id === undefined) {
    throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'memory id is required');
  }
  const memory = memories.find((item) => item.id === id);
  if (memory === undefined) {
    throw new CliFailure(exitCodes.notFound, 'NOT_FOUND', 'memory not found', { id });
  }
  if (subcommand === 'show') {
    return { ok: true, code: 'MEMORY_SHOW', message: 'memory loaded', data: { memory, body: await readMemoryBody(context.brainPath, memory) } };
  }
  if (subcommand === 'why') {
    const database = new DatabaseStore(context.databasePath);
    try {
      const provider = new FtsRetrievalProvider(database);
      const query = optionString(context.options, 'query') ?? memory.title;
      const mode = optionString(context.options, 'semantic-mode') ?? process.env.TAGA_SEMANTIC_MODE ?? 'off';
      if (mode === 'off') return { ok: true, code: 'MEMORY_WHY', message: 'memory rationale loaded', data: provider.why(id, query) };
      const retrieval = await provider.searchHybrid({ query, limit: 50 }, createCliSemanticRetriever(context, database));
      return { ok: true, code: 'MEMORY_WHY', message: 'memory rationale loaded', data: retrieval.items.find((item) => item.memory.id === id)?.matchReason ?? [] };
    } finally {
      database.close();
    }
  }
  if (subcommand === 'edit') {
    const database = new DatabaseStore(context.databasePath);
    try {
      const body = optionString(context.options, 'body') ?? await readMemoryBody(context.brainPath, memory);
      const title = optionString(context.options, 'title');
      const summary = optionString(context.options, 'summary');
      const nextId = `memory-${randomUUID()}`;
      const editedRepository = new MarkdownMemoryRepository(context.brainPath);
      editedRepository.setBody(nextId, body);
      const updated = await new GovernanceService(editedRepository, new SqliteAuditLog(database)).edit(
        id,
        nextId,
        {
          ...(title === undefined ? {} : { title }),
          ...(summary === undefined ? {} : { summary }),
          contentHash: contentHash(body),
        },
        { actor: 'user' },
        'edit from CLI',
      );
      new FtsRetrievalProvider(database).upsert(updated, body);
      enqueueSemanticUpsert(database, updated.id, updated.contentHash);
      return { ok: true, code: 'MEMORY_EDITED', message: 'memory edit created a draft version', data: updated };
    } finally {
      database.close();
    }
  }
  if (subcommand === 'timeline') {
    const database = new DatabaseStore(context.databasePath);
    try {
      return { ok: true, code: 'MEMORY_TIMELINE', message: 'memory timeline loaded', data: new FtsRetrievalProvider(database).timeline(id) };
    } finally {
      database.close();
    }
  }
  const commandBySubcommand: Record<string, { type: 'activate' | 'refresh' | 'mark_stale' | 'forget'; confirmed?: true }> = {
    promote: { type: 'activate' },
    demote: { type: 'mark_stale' },
    stale: { type: 'mark_stale' },
    forget: { type: 'forget' },
  };
  const lifecycle = subcommand === undefined ? undefined : commandBySubcommand[subcommand];
  if (lifecycle === undefined) {
    throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', `unknown memory command: ${subcommand ?? ''}`);
  }
  if (lifecycle.type === 'forget' && !isConfirmed(context.options)) {
    const database = new DatabaseStore(context.databasePath);
    try {
      const preview = await new RecoveryService(context.brainPath, database).preview(id);
      throw new CliFailure(exitCodes.confirmationRequired, 'CONFIRMATION_REQUIRED', 'forget requires --yes', preview);
    } finally {
      database.close();
    }
  }
  if (lifecycle.type === 'forget') {
    const database = new DatabaseStore(context.databasePath);
    try {
      const config = await readConfig(context.configPath);
      const targetPaths = config?.agents.map((agent) => agent.targetPath) ?? [];
      const result = await new RecoveryService(context.brainPath, database).forget(id, true, 'forget from CLI', targetPaths);
      enqueueSemanticRemove(database, id);
      await new SqliteAuditLog(database).append({
        eventType: 'memory.forgotten',
        actor: 'user',
        subjectType: 'memory',
        subjectId: id,
        occurredAt: new Date().toISOString(),
        reason: 'forget from CLI',
        payload: { recovery: result },
      });
      return { ok: true, code: 'MEMORY_FORGOTTEN', message: 'memory forgotten', data: result };
    } finally {
      database.close();
    }
  }
  const database = new DatabaseStore(context.databasePath);
  try {
    const audit = new SqliteAuditLog(database);
    const service = new GovernanceService(repository, audit);
    const actor: LifecycleActor = { actor: 'user' };
    const updated = await service.transition(id, { type: lifecycle.type }, actor, `${subcommand} from CLI`);
    const body = await readMemoryBody(context.brainPath, updated);
    if (updated.status === 'forgotten') {
      new FtsRetrievalProvider(database).remove(updated.id);
      enqueueSemanticRemove(database, updated.id);
    } else {
      new FtsRetrievalProvider(database).upsert(updated, body);
      enqueueSemanticUpsert(database, updated.id, updated.contentHash);
    }
    return { ok: true, code: 'MEMORY_UPDATED', message: 'memory lifecycle updated', data: updated };
  } finally {
    database.close();
  }
}

function createCliSemanticRetriever(context: CliContext, database: DatabaseStore): ZvecSemanticRetriever {
  return new ZvecSemanticRetriever({
    database,
    index: new ZvecMemoryIndex(join(context.brainPath, '.taga', 'semantic')),
    embedder: createLocalBgeM3Embedder({ modelPath: process.env.TAGA_BGE_M3_MODEL_PATH ?? '', batchSize: 4 }),
  });
}

async function contextCommand(subcommand: string | undefined, context: CliContext): Promise<CliResponse> {
  if (!['start', 'preview', 'explain', 'trace'].includes(subcommand ?? '')) {
    throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'supported context commands: start, preview, explain, trace');
  }
  const repository = new MarkdownMemoryRepository(context.brainPath);
  const records = await repository.records();
  if (subcommand === 'start') {
    const sessionId = optionString(context.options, 'session-id');
    if (sessionId === undefined) throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'context start requires --session-id=<id>');
    const database = new DatabaseStore(context.databasePath);
    try {
      const result = await new SessionContextService(context.brainPath, database).start({
        agentId: optionString(context.options, 'agent') ?? 'local',
        sessionId,
        ...(optionString(context.options, 'project') === undefined ? {} : { projectId: optionString(context.options, 'project') as string }),
        ...(optionString(context.options, 'task') === undefined ? {} : { task: optionString(context.options, 'task') as string }),
        cwd: context.cwd,
        refresh: context.options.get('refresh') === true,
      }, records);
      let injectedPath: string | undefined;
      if (context.options.get('inject') === true) {
        const config = await readConfig(context.configPath);
        const target = optionString(context.options, 'file') ?? config?.agents.find((agent) => agent.id === (optionString(context.options, 'agent') ?? 'local'))?.targetPath;
        if (target === undefined) throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'context start --inject requires --file=<path> or an initialized agent target');
        injectedPath = resolve(context.cwd, target);
        await new ContextPackBuilder().inject(injectedPath, result.pack);
      }
      await new SqliteAuditLog(database).append({
        eventType: 'context.session_started',
        actor: 'user',
        subjectType: 'session',
        subjectId: sessionId,
        occurredAt: new Date().toISOString(),
        reason: 'context start from CLI',
        payload: { packId: result.pack.id, source: result.source, stale: result.stale },
      });
      return { ok: true, code: 'CONTEXT_SESSION_STARTED', message: 'session context loaded', data: { ...result, ...(injectedPath === undefined ? {} : { injectedPath }) } };
    } finally {
      database.close();
    }
  }
  const projectId = optionString(context.options, 'project');
  const builder = new ContextPackBuilder();
  const pack = builder.build({
    agentId: optionString(context.options, 'agent') ?? 'local',
    ...(projectId === undefined ? {} : { projectId }),
    task: optionString(context.options, 'task'),
    channel: 'preview',
    candidates: records.map(({ memory, body }) => ({ memory, body })),
  });
  if (subcommand === 'preview') {
    const database = new DatabaseStore(context.databasePath);
    try {
      await new SqliteAuditLog(database).append({
        eventType: 'context.pack_built',
        actor: 'user',
        subjectType: 'context_pack',
        subjectId: pack.id,
        occurredAt: new Date().toISOString(),
        reason: 'context preview from CLI',
        payload: { projectId, task: optionString(context.options, 'task') },
      });
    } finally {
      database.close();
    }
    return { ok: true, code: 'CONTEXT_PREVIEW', message: 'context preview built', data: pack };
  }
  return { ok: true, code: subcommand === 'explain' ? 'CONTEXT_EXPLAIN' : 'CONTEXT_TRACE', message: 'context decisions loaded', data: subcommand === 'explain' ? builder.explain(pack) : builder.trace(pack) };
}

async function precheckCommand(context: CliContext): Promise<CliResponse> {
  const file = optionString(context.options, 'file');
  const symbol = optionString(context.options, 'symbol');
  const commit = optionString(context.options, 'commit');
  if (file === undefined && symbol === undefined && commit === undefined) throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'precheck requires --file, --symbol, or --commit');
  const database = new DatabaseStore(context.databasePath);
  try {
    const audit = new SqliteAuditLog(database);
    const notifications = new NotificationService(database, audit, {
      policy: { ...DEFAULT_PROACTIVE_POLICY, allowL2Reminders: context.options.get('remind') === true },
    });
    const result = await new MemoryPrecheckService(database, new MarkdownMemoryRepository(context.brainPath), audit, { notifications }).run({
      target: {
        ...(file === undefined ? {} : { file: resolve(context.cwd, file) }),
        ...(numberOption(context.options, 'line') === undefined ? {} : { line: numberOption(context.options, 'line') as number }),
        ...(symbol === undefined ? {} : { symbol }),
        ...(commit === undefined ? {} : { commit }),
      },
      ...(optionString(context.options, 'task') === undefined ? {} : { task: optionString(context.options, 'task') as string }),
      ...(optionString(context.options, 'project') === undefined ? {} : { projectId: optionString(context.options, 'project') as string }),
      ...(optionString(context.options, 'agent') === undefined ? {} : { agentId: optionString(context.options, 'agent') as string }),
      cwd: context.cwd,
      ...(numberOption(context.options, 'timeout-ms') === undefined ? {} : { timeoutMs: numberOption(context.options, 'timeout-ms') as number }),
    });
    return { ok: true, code: result.degraded ? 'PRECHECK_DEGRADED' : 'PRECHECK_READY', message: 'memory precheck completed', data: result, ...(result.diagnostics.length === 0 ? {} : { warnings: result.diagnostics }) };
  } finally {
    database.close();
  }
}

async function injectCommand(subcommand: string | undefined, context: CliContext): Promise<CliResponse> {
  const config = await readConfig(context.configPath);
  const selectedAgent = optionString(context.options, 'agent');
  const targets = config?.agents
    .filter((agent) => selectedAgent === undefined || agent.id === selectedAgent || (selectedAgent === 'claude' && agent.id === 'claude-code'))
    .map((agent) => agent.targetPath) ?? [];
  if (subcommand === 'ls') {
    return { ok: true, code: 'INJECT_TARGETS', message: 'injection targets loaded', data: await Promise.all(targets.map(async (path) => ({ path, ...(await checkPath(path)) }))) };
  }
  const target = optionString(context.options, 'file') ?? targets[0];
  if (target === undefined) {
    throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'inject requires --file=<path> or an initialized agent target');
  }
  const targetPath = resolve(context.cwd, target);
  if (subcommand === 'disable') {
    const current = await readFile(targetPath, 'utf8');
    const block = parseManagedBlock(current);
    const updated = `${current.slice(0, block.start)}${current.slice(block.end)}`.replace(/\n{3,}/gu, '\n\n');
    await atomicWrite(targetPath, updated);
    const database = new DatabaseStore(context.databasePath);
    try {
      await new SqliteAuditLog(database).append({ eventType: 'context.injection_disabled', actor: 'user', subjectType: 'injection_target', subjectId: targetPath, occurredAt: new Date().toISOString(), reason: 'disable from CLI', payload: {} });
    } finally {
      database.close();
    }
    return { ok: true, code: 'INJECTION_DISABLED', message: 'context injection disabled', data: { path: targetPath } };
  }
  const packResponse = await contextCommand('preview', context);
  const data = packResponse.data;
  if (!isContextPack(data)) {
    throw new CliFailure(exitCodes.internal, 'INTERNAL_ERROR', 'context pack could not be built');
  }
  await new ContextPackBuilder().inject(targetPath, data);
  const database = new DatabaseStore(context.databasePath);
  try {
    await new SqliteAuditLog(database).append({ eventType: 'context.injected', actor: 'user', subjectType: 'injection_target', subjectId: targetPath, occurredAt: new Date().toISOString(), reason: 'inject from CLI', payload: { packId: data.id } });
  } finally {
    database.close();
  }
  return { ok: true, code: 'INJECTED', message: 'context injected', data: { path: targetPath, hash: contentHash(data.content) } };
}

async function daemonCommand(subcommand: string | undefined, context: CliContext): Promise<CliResponse> {
  const manager = daemonServiceManager(context);
  if (subcommand === 'status' || subcommand === undefined) {
    const status = await daemonStatus(context.brainPath);
    const service = manager === null ? null : await manager.status();
    return { ok: true, code: status.running ? 'DAEMON_RUNNING' : 'DAEMON_STOPPED', message: status.running ? 'daemon is running' : 'daemon is stopped', data: { ...status, service } };
  }
  if (subcommand === 'install') {
    if (manager === null) throw new CliFailure(exitCodes.degraded, 'SERVICE_MANAGER_UNAVAILABLE', 'managed user service installation is available on Linux and macOS; use daemon start or daemon run');
    return { ok: true, code: 'DAEMON_SERVICE_INSTALLED', message: 'daemon user service installed', data: await manager.install() };
  }
  if (subcommand === 'uninstall') {
    if (manager === null) throw new CliFailure(exitCodes.degraded, 'SERVICE_MANAGER_UNAVAILABLE', 'managed user service uninstallation is available on Linux and macOS');
    return { ok: true, code: 'DAEMON_SERVICE_UNINSTALLED', message: 'daemon user service uninstalled; Brain data was preserved', data: await manager.uninstall() };
  }
  if (subcommand === 'restart') {
    if (manager !== null && (await manager.status()).installed) {
      return { ok: true, code: 'DAEMON_RESTARTED', message: 'daemon user service restarted', data: await manager.restart() };
    }
    await stopDaemon(context.brainPath);
    const status = await startDaemonProcess(context.brainPath, daemonEntryPath(context), process.env);
    return { ok: true, code: 'DAEMON_RESTARTED', message: 'daemon restarted', data: status };
  }
  if (subcommand === 'start') {
    if (manager !== null && (await manager.status()).installed) {
      return { ok: true, code: 'DAEMON_STARTED', message: 'daemon user service started', data: await manager.start() };
    }
    const status = await startDaemonProcess(context.brainPath, daemonEntryPath(context), process.env);
    return { ok: true, code: 'DAEMON_STARTED', message: 'daemon started', data: status };
  }
  if (subcommand === 'stop') {
    if (manager !== null && (await manager.status()).installed) {
      return { ok: true, code: 'DAEMON_STOPPED', message: 'daemon user service stopped', data: await manager.stop() };
    }
    const status = await stopDaemon(context.brainPath);
    return { ok: true, code: 'DAEMON_STOPPED', message: 'daemon stopped', data: status };
  }
  if (subcommand === 'run') {
    await (await createDefaultDaemonRuntime(context.brainPath)).run();
    return { ok: true, code: 'DAEMON_EXITED', message: 'daemon exited' };
  }
  throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'supported daemon commands: start, stop, restart, status, run, install, uninstall');
}

function daemonEntryPath(context: CliContext): string {
  return optionString(context.options, 'entry')
    ?? process.env.TAGA_DAEMON_ENTRY
    ?? fileURLToPath(new URL('../../daemon/src/main.js', import.meta.url));
}

function systemdManager(context: CliContext): SystemdUserServiceManager {
  return new SystemdUserServiceManager({
    brainPath: context.brainPath,
    daemonEntryPath: daemonEntryPath(context),
  });
}

function launchdManager(context: CliContext): LaunchdUserServiceManager {
  return new LaunchdUserServiceManager({
    brainPath: context.brainPath,
    daemonEntryPath: daemonEntryPath(context),
  });
}

function daemonServiceManager(context: CliContext): SystemdUserServiceManager | LaunchdUserServiceManager | null {
  if (process.platform === 'linux') return systemdManager(context);
  if (process.platform === 'darwin') return launchdManager(context);
  return null;
}

async function agentCommand(subcommand: string | undefined, positionals: readonly string[], context: CliContext): Promise<CliResponse> {
  const registry = new AgentAdapterRegistry();
  const selected = optionString(context.options, 'agent') ?? positionals[0];
  if (subcommand === undefined || subcommand === 'status') {
    const detections = await registry.detect();
    const filtered = selected === undefined ? detections : detections.filter((detection) => detection.id === (selected === 'claude' ? 'claude-code' : selected));
    if (selected !== undefined && filtered.length === 0) throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', `unsupported agent: ${selected}`);
    const projectPath = resolve(context.cwd, optionString(context.options, 'project') ?? context.cwd);
    return { ok: true, code: 'AGENT_STATUS', message: 'agent capabilities detected', data: filtered.map((detection) => ({ ...detection, targetPaths: registry.get(detection.id)?.staticTargets(projectPath) ?? [] })) };
  }
  if (subcommand === 'targets') {
    const projectPath = resolve(context.cwd, optionString(context.options, 'project') ?? context.cwd);
    const adapters = selected === undefined ? registry.all() : [registry.get(selected)].filter((adapter) => adapter !== null);
    if (adapters.length === 0) throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', `unsupported agent: ${selected}`);
    return { ok: true, code: 'AGENT_TARGETS', message: 'agent static targets loaded', data: adapters.map((adapter) => ({ id: adapter.id, targets: adapter.staticTargets(projectPath) })) };
  }
  if (subcommand === 'ingest') {
    if (selected !== undefined && registry.get(selected) === null) throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', `unsupported agent: ${selected}`);
    const database = new DatabaseStore(context.databasePath);
    try {
      const report = await new AgentIngestionService(database, registry).runOnce(selected === undefined ? undefined : [selected]);
      return { ok: true, code: 'AGENT_INGESTED', message: 'agent sources ingested', data: report, ...(report.errors.length === 0 ? {} : { warnings: report.errors.map((error) => `${error.path}:${error.offset}:${error.reason}`) }) };
    } finally {
      database.close();
    }
  }
  if (subcommand === 'verify') {
    if (selected === undefined) throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'agent verify requires --agent=<id>');
    if (!isConfirmed(context.options)) throw new CliFailure(exitCodes.confirmationRequired, 'CONFIRMATION_REQUIRED', 'real-agent verification reads a local session and requires --yes');
    const projectPath = resolve(context.cwd, optionString(context.options, 'project') ?? context.cwd);
    const projectId = optionString(context.options, 'project-id') ?? await projectIdentity(projectPath);
    const report = await new AgentAcceptanceService(registry).verify({ agentId: selected, brainPath: context.brainPath, projectId, confirmed: true });
    return { ok: true, code: 'AGENT_E2E_VERIFIED', message: 'real-agent Evidence, review, and recall path verified', data: report };
  }
  throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'supported agent commands: status, targets, ingest, verify');
}

function packCommand(subcommand: string | undefined, context: CliContext): CliResponse {
  const database = new DatabaseStore(context.databasePath);
  try {
    const domain = optionString(context.options, 'domain');
    if (domain !== undefined) {
      if (!isDomainPackId(domain)) throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', `unsupported domain pack: ${domain}`);
      const service = new DomainPackService(database);
      if (subcommand === undefined || subcommand === 'ls') {
        return { ok: true, code: 'DOMAIN_PACK_LIST', message: 'domain pack status loaded', data: service.list().filter((pack) => pack.id === domain) };
      }
      if (subcommand === 'enable' || subcommand === 'disable') {
        const enabled = subcommand === 'enable';
        service.setEnabled(domain, enabled);
        return { ok: true, code: enabled ? 'DOMAIN_PACK_ENABLED' : 'DOMAIN_PACK_DISABLED', message: `domain pack ${enabled ? 'enabled' : 'disabled'}`, data: { domain, enabled } };
      }
      if (subcommand === 'context') {
        return { ok: true, code: 'DOMAIN_PACK_CONTEXT', message: 'domain pack context loaded', data: service.contextContribution(domain) };
      }
      if (subcommand === 'record') {
        const raw = optionString(context.options, 'input');
        const locator = optionString(context.options, 'source');
        const sourceKind = optionString(context.options, 'source-kind') ?? 'file';
        if (raw === undefined || locator === undefined || !isSourceRefKind(sourceKind)) throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'pack record requires --domain, --input, --source, and a valid --source-kind');
        const unavailableReason = optionString(context.options, 'unavailable-reason');
        const safetyFailure = optionString(context.options, 'safety-failure');
        const result = service.record({
          packId: domain,
          raw,
          sourceRef: { kind: sourceKind, locator },
          ...(optionString(context.options, 'project-id') === undefined ? {} : { projectId: optionString(context.options, 'project-id') as string }),
          ...(optionString(context.options, 'task-id') === undefined ? {} : { taskId: optionString(context.options, 'task-id') as string }),
          ...(unavailableReason === undefined ? {} : { applicability: { status: 'unavailable', reason: unavailableReason } }),
          ...(safetyFailure === undefined ? {} : { safetyConditions: [{ id: safetyFailure, passed: false }] }),
        });
        return { ok: true, code: `DOMAIN_PACK_${result.status.toUpperCase()}`, message: 'domain pack input processed', data: result, ...(result.diagnostics.length === 0 ? {} : { warnings: result.diagnostics }) };
      }
      throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'supported domain pack commands: ls, enable, disable, record, context');
    }
    const agent = optionString(context.options, 'agent') ?? 'local';
    const key = `pack:enabled:${agent}`;
    const current = database.getMetadata(key);
    if (subcommand === undefined || subcommand === 'ls') {
      return { ok: true, code: 'PACK_LIST', message: 'pack status loaded', data: { agent, enabled: current !== 'false' } };
    }
    if (subcommand !== 'enable' && subcommand !== 'disable') {
      throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'supported pack commands: ls, enable, disable');
    }
    const enabled = subcommand === 'enable';
    database.upsertMetadata(key, String(enabled));
    return { ok: true, code: enabled ? 'PACK_ENABLED' : 'PACK_DISABLED', message: `pack ${enabled ? 'enabled' : 'disabled'}`, data: { agent, enabled } };
  } finally {
    database.close();
  }
}

function isSourceRefKind(value: string): value is SourceRef['kind'] {
  return ['file', 'line', 'symbol', 'url', 'commit', 'test', 'tool_call'].includes(value);
}

async function reviewCommand(subcommand: string | undefined, positionals: readonly string[], context: CliContext): Promise<CliResponse> {
  const repository = new MarkdownMemoryRepository(context.brainPath);
  const memories = await repository.list();
  const database = new DatabaseStore(context.databasePath);
  if (subcommand === undefined || subcommand === 'ls') {
    try {
      return {
        ok: true,
        code: 'REVIEW_LIST',
        message: 'review queue loaded',
        data: {
          memories: memories.filter((memory) => memory.status === 'candidate' || memory.status === 'draft'),
          candidates: database.listCandidates().filter((candidate) => candidate.decision === 'pending'),
        },
      };
    } finally {
      database.close();
    }
  }
  if (subcommand !== 'accept') {
    database.close();
    throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'supported review commands: ls, accept');
  }
  const id = optionString(context.options, 'memory') ?? positionals[0];
  if (id === undefined) {
    database.close();
    throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'review accept requires --memory=<id> or a candidate id');
  }
  try {
    const audit = new SqliteAuditLog(database);
    const candidate = database.getCandidate(id);
    const updated = candidate === null
      ? await new GovernanceService(repository, audit).transition(id, { type: 'activate' }, { actor: 'user' }, 'review accept from CLI')
      : await new ReviewService(new DatabaseCandidateRepository(database), repository, audit).accept(id, { actor: 'user' }, 'review candidate accept from CLI');
    const body = await readMemoryBody(context.brainPath, updated);
    new FtsRetrievalProvider(database).upsert(updated, body);
    enqueueSemanticUpsert(database, updated.id, updated.contentHash);
    return { ok: true, code: 'REVIEW_ACCEPTED', message: 'memory accepted into active recall', data: updated };
  } finally {
    database.close();
  }
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const command: string[] = [];
  const positionals: string[] = [];
  const options = new Map<string, string | true>();
  for (const argument of argv) {
    if (argument.startsWith('--')) {
      const [key, value] = argument.slice(2).split('=', 2);
      options.set(key ?? '', value ?? true);
    } else if (command.length < 2) {
      command.push(argument);
    } else {
      positionals.push(argument);
    }
  }
  return { command, options, positionals };
}

function isConfirmed(options: ReadonlyMap<string, string | true>): boolean {
  return options.get('yes') === true || options.get('confirm') === true;
}

function optionString(options: ReadonlyMap<string, string | true>, key: string): string | undefined {
  const value = options.get(key);
  return typeof value === 'string' ? value : undefined;
}

function numberOption(options: ReadonlyMap<string, string | true>, key: string): number | undefined {
  const value = optionString(options, key);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function csvOption(options: ReadonlyMap<string, string | true>, key: string): string[] {
  return (optionString(options, key) ?? '').split(',').map((item) => item.trim()).filter((item) => item.length > 0);
}

function metricsQuery(context: CliContext): { from?: string; to?: string; windowDays?: number; projectId?: string; agentId?: string } {
  return {
    ...(optionString(context.options, 'from') === undefined ? {} : { from: optionString(context.options, 'from') as string }),
    ...(optionString(context.options, 'to') === undefined ? {} : { to: optionString(context.options, 'to') as string }),
    ...(numberOption(context.options, 'days') === undefined ? {} : { windowDays: numberOption(context.options, 'days') as number }),
    ...(optionString(context.options, 'project-id') === undefined ? {} : { projectId: optionString(context.options, 'project-id') as string }),
    ...(optionString(context.options, 'agent-id') === undefined ? {} : { agentId: optionString(context.options, 'agent-id') as string }),
  };
}

function isOutcomeKind(value: string | undefined): value is OutcomeKind {
  return value !== undefined && ['recall', 'open', 'cite', 'useful', 'not_useful', 'verified', 'conflict', 'candidate_accepted', 'reminder_delivered', 'reminder_dismissed'].includes(value);
}

function isNotificationFeedback(value: string | undefined): value is NotificationFeedback {
  return value !== undefined && ['opened', 'cited', 'useful', 'not_useful', 'dismissed'].includes(value);
}

function parseGardenStatus(value: string): GardenProposalStatus {
  if (value === 'pending' || value === 'accepted' || value === 'rejected' || value === 'ignored') return value;
  throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', `unsupported garden proposal status: ${value}`);
}

function requestedAgentIds(value: string, registry: AgentAdapterRegistry): readonly string[] {
  const requested = value === 'all' ? registry.all().map((adapter) => adapter.id) : value.split(',').map((id) => id.trim()).filter((id) => id.length > 0);
  const normalized = requested.map((id) => id === 'claude' ? 'claude-code' : id);
  for (const id of normalized) {
    if (id !== 'local' && registry.get(id) === null) throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', `unsupported agent: ${id}`);
  }
  return [...new Set(normalized)];
}

function stableProjectId(projectPath: string): string {
  return `project-${contentHash(projectPath.replaceAll('\\', '/')).slice(-16)}`;
}

async function projectIdentity(projectPath: string): Promise<string> {
  try {
    const remote = (await promisify(execFile)('git', ['-C', projectPath, 'remote', 'get-url', 'origin'])).stdout.trim();
    if (remote.length > 0) return `project-${contentHash(remote.toLowerCase().replace(/\.git$/u, '')).slice(-16)}`;
  } catch {
    return stableProjectId(projectPath);
  }
  return stableProjectId(projectPath);
}

function memoryPath(brainPath: string, memory: Memory): string {
  const layout = new BrainLayout(brainPath);
  return layout.memoryFilePath(memory.type, memory.scope, memory.id);
}

async function visit(path: string, result: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  for (const entry of entries) {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) await visit(entryPath, result);
    else if (entry.isFile() && entry.name.endsWith('.md')) result.push(entryPath);
  }
}

async function readMemoryBody(brainPath: string, memory: Memory): Promise<string> {
  const parsed = parseMarkdownDocument(await readFile(memoryPath(brainPath, memory), 'utf8'));
  return parsed.body;
}

async function readConfig(path: string): Promise<ConfigFile | null> {
  try {
    const parsed: unknown = parseYaml(await readFile(path, 'utf8'));
    return parsed as ConfigFile;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function checkPath(path: string): Promise<{ ok: boolean; status: string; detail?: string }> {
  try {
    await access(path, constants.R_OK);
    return { ok: true, status: 'ok' };
  } catch (error) {
    return { ok: false, status: 'missing', detail: errorMessage(error) };
  }
}

async function checkPermission(path: string): Promise<{ ok: boolean; status: string; detail?: string }> {
  try {
    await mkdir(path, { recursive: true });
    await access(path, constants.R_OK | constants.W_OK);
    return { ok: true, status: 'ok' };
  } catch (error) {
    return { ok: false, status: 'failed', detail: errorMessage(error) };
  }
}

async function scanMarkdown(brainPath: string): Promise<{ records: readonly { memory: Memory; path: string }[]; orphans: readonly string[] }> {
  const paths: string[] = [];
  await visit(brainPath, paths);
  const records: { memory: Memory; path: string }[] = [];
  const orphans: string[] = [];
  for (const path of paths) {
    try {
      const parsed = parseMarkdownDocument(await readFile(path, 'utf8'));
      records.push({ memory: parseMemory(parsed.frontmatter), path });
    } catch {
      orphans.push(path);
    }
  }
  return { records, orphans };
}

async function markerHealth(config: ConfigFile | null): Promise<{ ok: boolean; status: string; detail?: string }> {
  if (config === null || config.agents.length === 0) return { ok: true, status: 'not-configured' };
  const failures: string[] = [];
  for (const agent of config.agents) {
    try {
      const content = await readFile(agent.targetPath, 'utf8');
      const begin = content.includes(markerBegin);
      const end = content.includes(markerEnd);
      if (begin !== end) failures.push(`${agent.targetPath}:unbalanced`);
    } catch {
      failures.push(`${agent.targetPath}:missing`);
    }
  }
  return failures.length === 0
    ? { ok: true, status: 'healthy' }
    : { ok: false, status: 'invalid', detail: JSON.stringify(failures) };
}

function writeResponse(streams: CliStreams, json: boolean, response: CliResponse): void {
  if (json) {
    streams.stdout.write(`${JSON.stringify(response)}\n`);
    return;
  }
  streams.stdout.write(`${response.message}\n`);
  if (response.data !== undefined) streams.stdout.write(`${JSON.stringify(response.data, null, 2)}\n`);
  if (response.warnings !== undefined) streams.stderr.write(`${response.warnings.join('\n')}\n`);
}

function toErrorResponse(error: unknown, requestId: string): CliResponse {
  if (error instanceof CliFailure) {
    return { ok: false, code: error.responseCode, message: error.message, ...(error.data === undefined ? {} : { data: error.data }), ...(error.warnings === undefined ? {} : { warnings: error.warnings }), request_id: requestId };
  }
  if (isTagaError(error)) {
    return { ok: false, code: error.code, message: error.message, data: error.details, request_id: requestId };
  }
  return { ok: false, code: 'INTERNAL_ERROR', message: errorMessage(error), request_id: requestId };
}

function responseExitCode(error: unknown): number {
  if (error instanceof CliFailure) return error.exitCode;
  if (isTagaError(error)) {
    if (error.code === errorCodes.notFound) return exitCodes.notFound;
    if (error.code === errorCodes.validationFailed) return exitCodes.invalidInput;
    if (error.code === errorCodes.conflict) return exitCodes.consistency;
  }
  if (isPermissionError(error)) return exitCodes.permission;
  return exitCodes.internal;
}

function isContextPack(value: unknown): value is ContextPack {
  return typeof value === 'object' && value !== null && 'content' in value && typeof value.content === 'string';
}

async function ensureMarkerFile(path: string): Promise<void> {
  let current = '';
  try {
    current = await readFile(path, 'utf8');
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (current.includes(markerBegin) || current.includes(markerEnd)) {
    parseManagedBlock(current);
    return;
  }
  await atomicWrite(path, `${current}${current.length === 0 ? '' : '\n'}${markerBegin}\n${markerEnd}\n`);
}

async function writeYaml(path: string, value: unknown): Promise<void> {
  await atomicWrite(path, stringifyYaml(value));
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isPermissionError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && ['EACCES', 'EPERM', 'EBUSY'].includes(String(error.code));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
