import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PROACTIVE_POLICY,
  GovernanceService,
  SqliteAuditLog,
  type LifecycleActor,
} from '../../../packages/application/src/index.js';
import {
  ConfigurationError,
  configDirectory,
  configFileFromResolved,
  loadConfig,
  redactedConfig,
  stringifyConfig,
  type ConfigOverrides,
  type FeatureMode,
  type LoadedConfig,
  type ResolvedConfig,
} from '../../../packages/config/src/index.js';
import { ContextPackBuilder, summarizePack } from '../../../packages/context/src/index.js';
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
  SystemdUserServiceManager,
} from '../../../packages/platform/src/index.js';
import { AgentAdapterRegistry, DEFAULT_AGENT_INSTRUCTIONS } from '../../../packages/adapters/src/index.js';
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
  type MemoryType,
  type SourceRef,
} from '../../../packages/domain/src/index.js';
import { runLearn, runLearnWatch } from '../../../packages/learning/src/index.js';
import { FtsRetrievalProvider } from '../../../packages/retrieval/src/index.js';
import { createLocalBgeM3Embedder, downloadBgeM3Model } from '../../../packages/embedding/src/index.js';
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
  instructionBlockBegin,
  instructionBlockEnd,
  markerBegin,
  markerEnd,
  parseManagedBlock,
  parseMarkdownDocument,
  upsertManagedBlock,
} from '../../../packages/storage/src/index.js';
import { selectContextCandidates, SessionContextService } from '../../../packages/session/src/index.js';
import { resolveProjectContext, type ProjectContext } from '../../../packages/project-context/src/index.js';
import { runInitWizard, type InitWizardUi } from './init-wizard.js';

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
  readonly silent?: boolean;
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
  readonly env: NodeJS.ProcessEnv;
  readonly loadedConfig: LoadedConfig;
  readonly config: ResolvedConfig;
  readonly json: boolean;
  readonly options: ReadonlyMap<string, string | true>;
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
    const context = await createContext(parsed, cwd, options.env ?? process.env);
    const result = await dispatch(parsed, context);
    writeResponse(streams, json, { ...result, request_id: requestId });
    return result.ok ? exitCodes.success : exitCodes.partial;
  } catch (error) {
    const response = toErrorResponse(error, requestId);
    writeResponse(streams, json, response);
    return response.ok ? exitCodes.success : responseExitCode(error);
  }
}

async function createContext(parsed: ParsedArgs, cwd: string, env: NodeJS.ProcessEnv): Promise<CliContext> {
  const configuredBrain = optionString(parsed.options, 'brain');
  const requestedConfig = optionString(parsed.options, 'config') ?? env.TAGA_CONFIG;
  const configPath = requestedConfig ?? (configuredBrain === undefined ? undefined : join(resolve(cwd, configuredBrain), 'config.yaml'));
  const loadedConfig = await loadConfig({
    cwd,
    env,
    ...(configPath === undefined ? {} : { configPath }),
    ...(configuredBrain === undefined ? {} : { isolatedBrainPath: configuredBrain, overrides: { paths: { brain: configuredBrain } } }),
  });
  const brainPath = loadedConfig.config.paths.brain;
  return {
    cwd,
    brainPath,
    configPath: loadedConfig.configPath,
    databasePath: join(brainPath, 'taga.db'),
    env,
    loadedConfig,
    config: loadedConfig.config,
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
    case 'config':
      return configCommand(subcommand, context);
    case 'daemon':
      return daemonCommand(subcommand, context);
    case 'agent':
      return agentCommand(subcommand, args.positionals, context);
    case 'project':
      return projectCommand(subcommand, context);
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
    case 'learn':
      return learnCommand(context);
    default:
      throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', `unknown command: ${root}`);
  }
}

const isInteractiveTerminal = (): boolean => process.stdout.isTTY === true && process.stdin.isTTY === true;

async function initCommand(context: CliContext): Promise<CliResponse> {
  const options = new Map(context.options);
  const projectOptions = ['project', 'project-root', 'project-id'].filter((option) => options.has(option));
  if (projectOptions.length > 0) {
    throw new CliFailure(
      exitCodes.invalidInput,
      'INVALID_INPUT',
      `init does not accept project context options (${projectOptions.map((option) => `--${option}`).join(', ')}); projects are detected at runtime from the Agent working directory`,
    );
  }
  const interactive = isInteractiveTerminal()
    && context.options.get('yes') !== true
    && context.options.get('no-interactive') !== true
    && !context.json;
  let brainPath = context.brainPath;
  let configPath = context.configPath;
  const registry = new AgentAdapterRegistry();
  let wizardUi: InitWizardUi | undefined;
  let interactiveConfirmed = false;
  let downloadSemanticModel = false;
  if (interactive) {
    const { createClackInitUi } = await import('./clack-init-ui.js');
    wizardUi = createClackInitUi();
    const enabledAgents = requestedAgentIds(
      optionString(options, 'agent') ?? (context.config.agents.enabled.length === 0 ? 'claude-code,codex' : context.config.agents.enabled.join(',')),
      registry,
    );
    const result = await runInitWizard({
      cwd: context.cwd,
      brainPath,
      agents: registry.all().map((adapter) => ({ value: adapter.id, label: agentDisplayName(adapter.id) })),
      enabledAgents: enabledAgents.filter((agentId) => registry.get(agentId) !== null),
      semanticMode: context.config.retrieval.semantic.mode,
      semanticModelPath: context.config.retrieval.semantic.modelPath,
      llmMode: context.config.llm.mode,
      llmEndpoint: context.config.llm.endpoint,
      llmModel: context.config.llm.model,
      ...(context.config.llm.dailyCap === undefined ? {} : { llmDailyCap: context.config.llm.dailyCap }),
      consolidationEnabled: context.config.consolidation.enabled,
      reflectionEnabled: context.config.reflection.enabled,
      learnAllowNetwork: context.config.learning.allowNetwork,
      configPathForBrain: (selectedBrainPath) => initConfigPath(context, selectedBrainPath),
    }, wizardUi);
    if (result === undefined) return { ok: true, code: 'INIT_CANCELLED', message: 'initialization cancelled', silent: true };
    brainPath = result.brainPath;
    configPath = initConfigPath(context, brainPath);
    options.set('agent', result.agentIds.join(','));
    options.set('semantic-file-mode', result.semanticMode);
    if (result.semanticModelPath.length > 0) options.set('semantic-file-model-path', result.semanticModelPath);
    options.set('llm-file-mode', result.llmMode);
    if (result.llmEndpoint !== undefined) options.set('llm-file-endpoint', result.llmEndpoint);
    if (result.llmModel !== undefined) options.set('llm-file-model', result.llmModel);
    options.set('llm-file-daily-cap', result.llmDailyCap?.toString() ?? '0');
    options.set('consolidation-file-mode', result.consolidationEnabled ? 'on' : 'off');
    options.set('reflect-file-mode', result.reflectionEnabled ? 'on' : 'off');
    options.set('learn-file-allow-network', result.learnAllowNetwork ? 'true' : 'false');
    interactiveConfirmed = true;
    downloadSemanticModel = result.downloadSemanticModel;
  }
  const requested = requestedAgentIds(optionString(options, 'agent') ?? (context.config.agents.enabled.length === 0 ? 'local' : context.config.agents.enabled.join(',')), registry);
  const agents = requested.map((agentId) => ({ id: registry.get(agentId)?.id ?? agentId }));
  const semanticMode = optionString(options, 'semantic-file-mode');
  const llmMode = optionString(options, 'llm-file-mode');
  const consolidationMode = optionString(options, 'consolidation-file-mode');
  const reflectionMode = optionString(options, 'reflect-file-mode');
  const overrides: ConfigOverrides = {
    paths: { brain: brainPath },
    agents: {
      enabled: agents.map((agent) => agent.id),
      writeInstructions: options.get('no-instructions') === true ? false : context.config.agents.writeInstructions,
    },
    retrieval: {
      semantic: {
        ...(semanticMode === undefined ? {} : { mode: semanticMode as FeatureMode }),
        ...(optionString(options, 'semantic-file-model-path') === undefined ? {} : { modelPath: optionString(options, 'semantic-file-model-path') as string }),
      },
    },
    llm: {
      ...(llmMode === undefined ? {} : { mode: llmMode as FeatureMode }),
      ...(optionString(options, 'llm-file-endpoint') === undefined ? {} : { endpoint: optionString(options, 'llm-file-endpoint') as string }),
      ...(optionString(options, 'llm-file-model') === undefined ? {} : { model: optionString(options, 'llm-file-model') as string }),
      ...(numberOption(options, 'llm-file-daily-cap') === undefined ? {} : { dailyCap: numberOption(options, 'llm-file-daily-cap') as number }),
    },
    consolidation: consolidationMode === undefined ? {} : { enabled: consolidationMode === 'on' },
    reflection: reflectionMode === undefined ? {} : { enabled: reflectionMode === 'on' },
    learning: optionString(options, 'learn-file-allow-network') === undefined ? {} : { allowNetwork: optionString(options, 'learn-file-allow-network') === 'true' },
  };
  const initialized = await loadConfig({ cwd: context.cwd, env: context.env, configPath, overrides });
  const preview = {
    brainPath,
    configPath,
    network: initialized.config.learning.allowNetwork ? 'enabled' : 'disabled',
    agents: agents.map((agent) => ({ id: agent.id })),
    changes: [configPath],
  };
  if (!interactiveConfirmed && !isConfirmed(options)) {
    throw new CliFailure(
      exitCodes.confirmationRequired,
      'CONFIRMATION_REQUIRED',
      'init preview is ready; rerun with --yes to write changes',
      preview,
    );
  }
  await ensurePrivateDirectory(brainPath);
  if (downloadSemanticModel) {
    const activity = wizardUi?.activity();
    let lastProgress = '';
    activity?.start('Downloading BGE-M3 model');
    try {
      await downloadBgeM3Model({
        brainPath,
        onProgress: ({ file, loaded, total }) => {
          const progress = `Downloading ${file} (${formatPercent(loaded, total)})`;
          if (progress !== lastProgress) {
            lastProgress = progress;
            activity?.update(progress);
          }
        },
      });
      activity?.stop('BGE-M3 downloaded and verified');
    } catch (error) {
      activity?.error('BGE-M3 download failed; configuration was not written');
      throw error;
    }
  }
  await mkdir(configDirectory(configPath), { recursive: true });
  await atomicWrite(configPath, stringifyConfig(configFileFromResolved(initialized.config)));
  const initWarnings = [...initialized.warnings];
  await mkdir(join(brainPath, 'global'), { recursive: true });
  const database = new DatabaseStore(join(brainPath, 'taga.db'));
  try {
    for (const agent of agents) database.upsertMetadata(`pack:enabled:${agent.id}`, 'true');
    if (database.getMetadata('brain.initialized') === null) {
      await new SqliteAuditLog(database).append({
        eventType: 'brain.initialized',
        actor: 'user',
        subjectType: 'brain',
        subjectId: 'brain',
        occurredAt: new Date().toISOString(),
        reason: 'init --yes',
        payload: { agentIds: agents.map((agent) => agent.id) },
      });
      database.upsertMetadata('brain.initialized', new Date().toISOString());
    }
  } finally {
    database.close();
  }
  const warnings = optionString(options, 'llm-file-api-key') === undefined ? initWarnings : [...initWarnings, '--llm-file-api-key is ignored; use TAGA_LLM_API_KEY'];
  if (wizardUi !== undefined) {
    for (const warning of warnings) wizardUi.warn(warning);
    wizardUi.outro('Taga is ready.');
  }
  return { ok: true, code: 'INITIALIZED', message: 'taga initialized', data: preview, ...(warnings.length === 0 ? {} : { warnings }), ...(interactive ? { silent: true } : {}) };
}

async function configCommand(subcommand: string | undefined, context: CliContext): Promise<CliResponse> {
  if (subcommand === 'validate' || subcommand === undefined) {
    return {
      ok: true,
      code: 'CONFIG_VALID',
      message: 'configuration is valid',
      data: {
        configPath: context.configPath,
        loadedFrom: context.loadedConfig.loadedFrom,
        schemaVersion: context.config.schemaVersion,
        legacy: context.loadedConfig.legacy,
      },
      ...(context.loadedConfig.warnings.length === 0 ? {} : { warnings: context.loadedConfig.warnings }),
    };
  }
  if (subcommand === 'show') {
    return {
      ok: true,
      code: 'CONFIG_EFFECTIVE',
      message: 'effective configuration loaded',
      data: {
        configPath: context.configPath,
        loadedFrom: context.loadedConfig.loadedFrom,
        config: redactedConfig(context.config),
        sources: context.loadedConfig.sources,
      },
      ...(context.loadedConfig.warnings.length === 0 ? {} : { warnings: context.loadedConfig.warnings }),
    };
  }
  if (subcommand === 'migrate') {
    if (!context.loadedConfig.legacy || context.loadedConfig.file === null) {
      return { ok: true, code: 'CONFIG_CURRENT', message: 'configuration already uses schemaVersion 4', data: { configPath: context.configPath } };
    }
    const preview = { from: context.loadedConfig.loadedFrom, to: context.configPath, schemaVersion: 4 };
    if (context.options.get('write') !== true) {
      return { ok: true, code: 'CONFIG_MIGRATION_PREVIEW', message: 'configuration migration preview ready; rerun with --write', data: preview, warnings: context.loadedConfig.warnings };
    }
    await mkdir(configDirectory(context.configPath), { recursive: true });
    await atomicWrite(context.configPath, stringifyConfig(context.loadedConfig.file));
    return { ok: true, code: 'CONFIG_MIGRATED', message: 'configuration migrated to schemaVersion 4', data: preview, warnings: context.loadedConfig.warnings };
  }
  throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'supported config commands: validate, show, migrate');
}

async function doctorCommand(context: CliContext): Promise<CliResponse> {
  const checks: Record<string, { ok: boolean; status: string; detail?: string }> = {};
  Object.assign(checks, await platformHealth(context.brainPath));
  checks.configuration = context.loadedConfig.loadedFrom === null
    ? { ok: false, status: 'missing', detail: 'run taga init --yes' }
    : { ok: true, status: context.loadedConfig.legacy ? 'legacy' : 'ok', detail: context.loadedConfig.loadedFrom };
  checks.permissions = await checkPermission(context.brainPath);
  checks.brain_path = await checkPath(context.brainPath);
  const scanned = await scanMarkdown(context.brainPath);
  checks.orphan_markdown = scanned.orphans.length === 0
    ? { ok: true, status: 'clean' }
    : { ok: false, status: 'orphaned', detail: JSON.stringify(scanned.orphans) };
  const pendingReview = scanned.records.filter(({ memory }) => memory.status === 'draft' || memory.status === 'candidate');
  checks.review_backlog = pendingReview.length === 0
    ? { ok: true, status: 'clean' }
    : { ok: true, status: 'pending-review', detail: JSON.stringify({ count: pendingReview.length, ids: pendingReview.map(({ memory }) => memory.id), review: 'taga review' }) };
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
  checks.marker = await markerHealth(context);
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
    const project = await resolveCliProject(context);
    const projectPath = project.root;
    const projectId = project.id;
    database.saveProjectContext(projectRecord(project));
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
      const reviewed = await service.review(id, subcommand as 'accepted' | 'rejected' | 'ignored', {
        repository: new MarkdownMemoryRepository(context.brainPath),
        audit: new SqliteAuditLog(database),
        actor: { actor: 'user' },
        ...(optionString(context.options, 'action') === undefined ? {} : { action: optionString(context.options, 'action') as GardenAction }),
        ...(optionString(context.options, 'target') === undefined ? {} : { targetId: optionString(context.options, 'target') as string }),
        ...(optionString(context.options, 'replacement') === undefined ? {} : { replacementId: optionString(context.options, 'replacement') as string }),
      });
      const message = subcommand === 'accept' ? 'garden proposal accepted' : subcommand === 'reject' ? 'garden proposal rejected' : 'garden proposal ignored';
      return { ok: true, code: 'GARDEN_REVIEWED', message, data: { proposal: reviewed, config: context.loadedConfig.loadedFrom === null ? 'not-configured' : 'configured' } };
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
          mode: context.config.retrieval.semantic.mode,
          modelPathConfigured: context.config.retrieval.semantic.modelPath.length > 0,
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
      const mode = featureModeOption(context.options, 'semantic-mode') ?? context.config.retrieval.semantic.mode;
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
      const mode = featureModeOption(context.options, 'semantic-mode') ?? context.config.retrieval.semantic.mode;
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
      const targetPaths = (await configuredAgentTargets(context)).flatMap((agent) => agent.targetPaths);
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
    embedder: createLocalBgeM3Embedder({ modelPath: context.config.retrieval.semantic.modelPath, batchSize: 4 }),
  });
}

function safeCliSemanticRetriever(context: CliContext, database: DatabaseStore): ZvecSemanticRetriever | undefined {
  if (context.config.retrieval.semantic.mode === 'off') return undefined;
  try {
    return createCliSemanticRetriever(context, database);
  } catch {
    return undefined;
  }
}

async function contextCommand(subcommand: string | undefined, context: CliContext, channel: 'preview' | 'static' = 'preview'): Promise<CliResponse> {
  if (!['start', 'preview', 'explain', 'trace'].includes(subcommand ?? '')) {
    throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'supported context commands: start, preview, explain, trace');
  }
  const repository = new MarkdownMemoryRepository(context.brainPath);
  const records = await repository.records();
  const project = await resolveCliProject(context);
  if (subcommand === 'start') {
    const sessionId = optionString(context.options, 'session-id');
    if (sessionId === undefined) throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'context start requires --session-id=<id>');
    const database = new DatabaseStore(context.databasePath);
    try {
      database.saveProjectContext(projectRecord(project));
      database.saveSessionContext({ sessionId, projectId: project.id, projectRoot: project.root, cwd: project.cwd, agentId: optionString(context.options, 'agent') ?? 'local', source: project.source });
      const result = await new SessionContextService(context.brainPath, database).start({
        agentId: optionString(context.options, 'agent') ?? 'local',
        sessionId,
        projectId: project.id,
        ...(optionString(context.options, 'task') === undefined ? {} : { task: optionString(context.options, 'task') as string }),
        cwd: context.cwd,
        refresh: context.options.get('refresh') === true,
        channel: context.options.get('inject') === true ? 'static' : 'mcp',
        domainContributions: new DomainPackService(database).contextContributions(),
      }, records, safeCliSemanticRetriever(context, database));
      let injectedPath: string | undefined;
      if (context.options.get('inject') === true) {
        const selectedAgent = optionString(context.options, 'agent') ?? 'local';
        const target = optionString(context.options, 'file') ?? (await configuredAgentTargets(context, project)).find((agent) => agent.id === selectedAgent || (selectedAgent === 'claude' && agent.id === 'claude-code'))?.targetPaths[0];
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
        payload: { packId: result.pack.id, source: result.source, stale: result.stale, stats: summarizePack(result.pack) },
      });
      return { ok: true, code: 'CONTEXT_SESSION_STARTED', message: 'session context loaded', data: { ...result, ...(injectedPath === undefined ? {} : { injectedPath }) } };
    } finally {
      database.close();
    }
  }
  const projectId = project.id;
  const builder = new ContextPackBuilder();
  const database = new DatabaseStore(context.databasePath);
  try {
    const selection = await selectContextCandidates(database, {
      ...(optionString(context.options, 'task') === undefined ? {} : { task: optionString(context.options, 'task') as string }),
      ...(projectId === undefined ? {} : { projectId }),
    }, records, safeCliSemanticRetriever(context, database));
    const pack = builder.build({
      agentId: optionString(context.options, 'agent') ?? 'local',
      ...(projectId === undefined ? {} : { projectId }),
      task: optionString(context.options, 'task'),
      channel,
      candidates: selection.candidates,
      domainContributions: new DomainPackService(database).contextContributions(),
    });
    if (subcommand === 'preview') {
      await new SqliteAuditLog(database).append({
        eventType: 'context.pack_built',
        actor: 'user',
        subjectType: 'context_pack',
        subjectId: pack.id,
        occurredAt: new Date().toISOString(),
        reason: 'context preview from CLI',
        payload: { projectId, task: optionString(context.options, 'task'), stats: summarizePack(pack) },
      });
      return { ok: true, code: 'CONTEXT_PREVIEW', message: 'context preview built', data: pack };
    }
    return { ok: true, code: subcommand === 'explain' ? 'CONTEXT_EXPLAIN' : 'CONTEXT_TRACE', message: 'context decisions loaded', data: subcommand === 'explain' ? builder.explain(pack) : builder.trace(pack) };
  } finally {
    database.close();
  }
}

async function precheckCommand(context: CliContext): Promise<CliResponse> {
  const file = optionString(context.options, 'file');
  const symbol = optionString(context.options, 'symbol');
  const commit = optionString(context.options, 'commit');
  if (file === undefined && symbol === undefined && commit === undefined) throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'precheck requires --file, --symbol, or --commit');
  const database = new DatabaseStore(context.databasePath);
  try {
    const project = await resolveCliProject(context);
    database.saveProjectContext(projectRecord(project));
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
      projectId: project.id,
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
  const selectedAgent = optionString(context.options, 'agent');
  const targets = (await configuredAgentTargets(context))
    .filter((agent) => selectedAgent === undefined || agent.id === selectedAgent || (selectedAgent === 'claude' && agent.id === 'claude-code'))
    .flatMap((agent) => agent.targetPaths);
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
  const packResponse = await contextCommand('preview', context, 'static');
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
    const status = await startDaemonProcess(context.brainPath, daemonEntryPath(context), daemonEnvironment(context));
    return { ok: true, code: 'DAEMON_RESTARTED', message: 'daemon restarted', data: status };
  }
  if (subcommand === 'start') {
    if (manager !== null && (await manager.status()).installed) {
      return { ok: true, code: 'DAEMON_STARTED', message: 'daemon user service started', data: await manager.start() };
    }
    const status = await startDaemonProcess(context.brainPath, daemonEntryPath(context), daemonEnvironment(context));
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
    await (await createDefaultDaemonRuntime(context.brainPath, context.config)).run();
    return { ok: true, code: 'DAEMON_EXITED', message: 'daemon exited' };
  }
  throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'supported daemon commands: start, stop, restart, status, run, install, uninstall');
}

function daemonEntryPath(context: CliContext): string {
  return optionString(context.options, 'entry')
    ?? context.env.TAGA_DAEMON_ENTRY
    ?? fileURLToPath(new URL('../../daemon/src/main.js', import.meta.url));
}

function daemonEnvironment(context: CliContext): NodeJS.ProcessEnv {
  return { ...context.env, TAGA_BRAIN: context.brainPath, TAGA_CONFIG: context.configPath };
}

function systemdManager(context: CliContext): SystemdUserServiceManager {
  return new SystemdUserServiceManager({
    brainPath: context.brainPath,
    configPath: context.configPath,
    daemonEntryPath: daemonEntryPath(context),
  });
}

function launchdManager(context: CliContext): LaunchdUserServiceManager {
  return new LaunchdUserServiceManager({
    brainPath: context.brainPath,
    configPath: context.configPath,
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
    const project = await resolveCliProject(context);
    return { ok: true, code: 'AGENT_STATUS', message: 'agent capabilities detected', data: filtered.map((detection) => ({ ...detection, targetPaths: registry.get(detection.id)?.staticTargets(project.root) ?? [] })) };
  }
  if (subcommand === 'targets') {
    const project = await resolveCliProject(context);
    const adapters = selected === undefined ? registry.all() : [registry.get(selected)].filter((adapter) => adapter !== null);
    if (adapters.length === 0) throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', `unsupported agent: ${selected}`);
    return { ok: true, code: 'AGENT_TARGETS', message: 'agent static targets loaded', data: adapters.map((adapter) => ({ id: adapter.id, targets: adapter.staticTargets(project.root) })) };
  }
  if (subcommand === 'install') {
    const project = await resolveCliProject(context);
    const requested = requestedAgentIds(selected ?? (context.config.agents.enabled.length === 0 ? 'local' : context.config.agents.enabled.join(',')), registry);
    const targets = requested.map((id) => ({ id, targetPaths: agentTargetPaths(registry, id, project.root) }));
    const preview = { project, agents: targets };
    if (!isConfirmed(context.options)) throw new CliFailure(exitCodes.confirmationRequired, 'CONFIRMATION_REQUIRED', 'agent install preview is ready; rerun with --yes', preview);
    for (const agent of targets) {
      const primaryTarget = agent.targetPaths[0];
      if (primaryTarget !== undefined) await ensureMarkerFile(primaryTarget);
      for (const target of agent.targetPaths) {
        await upsertManagedBlock(target, DEFAULT_AGENT_INSTRUCTIONS, { begin: instructionBlockBegin, end: instructionBlockEnd });
      }
    }
    const enabled = [...new Set([...context.config.agents.enabled, ...requested])];
    const updated = await loadConfig({ cwd: context.cwd, env: context.env, configPath: context.configPath, overrides: { agents: { enabled, writeInstructions: true } } });
    await mkdir(configDirectory(context.configPath), { recursive: true });
    await atomicWrite(context.configPath, stringifyConfig(configFileFromResolved(updated.config)));
    const database = new DatabaseStore(context.databasePath);
    try {
      database.saveProjectContext(projectRecord(project));
    } finally {
      database.close();
    }
    return { ok: true, code: 'AGENT_INSTALLED', message: 'agent instructions installed for current project', data: preview };
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
    const project = await resolveCliProject(context);
    const report = await new AgentAcceptanceService(registry).verify({ agentId: selected, brainPath: context.brainPath, projectId: project.id, confirmed: true });
    return { ok: true, code: 'AGENT_E2E_VERIFIED', message: 'real-agent Evidence, review, and recall path verified', data: report };
  }
  throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'supported agent commands: status, targets, install, ingest, verify');
}

async function projectCommand(subcommand: string | undefined, context: CliContext): Promise<CliResponse> {
  if (subcommand === undefined || subcommand === 'show' || subcommand === 'inspect') {
    const project = await resolveCliProject(context);
    return { ok: true, code: 'PROJECT_CONTEXT', message: 'runtime project context resolved', data: project };
  }
  if (subcommand === 'list') {
    const database = new DatabaseStore(context.databasePath);
    try {
      return { ok: true, code: 'PROJECT_LIST', message: 'known projects loaded', data: database.listProjectContexts() };
    } finally {
      database.close();
    }
  }
  throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'supported project commands: show, inspect, list');
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
  if (subcommand !== 'accept' && subcommand !== 'reject') {
    database.close();
    throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'supported review commands: ls, accept, reject');
  }
  const id = optionString(context.options, 'memory') ?? positionals[0];
  if (id === undefined) {
    database.close();
    throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', `review ${subcommand} requires --memory=<id> or a candidate id`);
  }
  if (subcommand === 'reject') {
    try {
      const audit = new SqliteAuditLog(database);
      const candidate = database.getCandidate(id);
      if (candidate !== null) {
        const rejected = await new ReviewService(new DatabaseCandidateRepository(database), repository, audit).reject(id, { actor: 'user' }, 'review candidate reject from CLI');
        return { ok: true, code: 'REVIEW_REJECTED', message: 'candidate rejected', data: rejected };
      }
      const updated = await new GovernanceService(repository, audit).forget(id, { actor: 'user' }, 'review reject from CLI', true);
      new FtsRetrievalProvider(database).remove(updated.id);
      enqueueSemanticRemove(database, updated.id);
      return { ok: true, code: 'REVIEW_REJECTED', message: 'memory rejected and forgotten', data: updated };
    } finally {
      database.close();
    }
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

function featureModeOption(options: ReadonlyMap<string, string | true>, key: string): FeatureMode | undefined {
  const value = optionString(options, key);
  if (value === undefined) return undefined;
  if (value === 'off' || value === 'shadow' || value === 'on') return value;
  throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', `${key} must be off, shadow, or on`);
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

const LEARN_TYPES: readonly string[] = ['preferences', 'environment', 'procedures', 'lessons', 'projects'];

async function learnCommand(context: CliContext): Promise<CliResponse> {
  const text = optionString(context.options, 'text');
  const file = optionString(context.options, 'file');
  const dir = optionString(context.options, 'dir');
  const url = optionString(context.options, 'url');
  if (text === undefined && file === undefined && dir === undefined && url === undefined) {
    throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'learn requires one of --text, --file, --dir, --url');
  }
  const type = optionString(context.options, 'type');
  if (type !== undefined && !LEARN_TYPES.includes(type)) {
    throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', `unsupported learn type: ${type}; expected one of ${LEARN_TYPES.join(', ')}`);
  }
  const include = optionString(context.options, 'include');
  const project = optionString(context.options, 'project-id');
  const maxBlocks = numberOption(context.options, 'max-blocks');
  const intervalMs = numberOption(context.options, 'interval-ms');
  const maxCycles = numberOption(context.options, 'max-cycles');
  const allowNetwork = context.options.get('allow-network') === true
    ? true
    : context.options.get('no-allow-network') === true
      ? false
      : context.config.learning.allowNetwork;
  await ensurePrivateDirectory(context.brainPath);
  if (context.options.get('watch') === true) {
    if (dir === undefined) throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', 'learn --watch requires --dir=<path>');
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    process.once('SIGTERM', () => controller.abort());
    const reports = await runLearnWatch({
      dir,
      ...(include === undefined ? {} : { include }),
      ...(type === undefined ? {} : { type: type as MemoryType }),
      ...(project === undefined ? {} : { project }),
      allowNetwork,
    }, {
      brainPath: context.brainPath,
      semantic: { modelPath: context.config.retrieval.semantic.modelPath },
      ...(intervalMs === undefined ? {} : { intervalMs }),
      ...(maxCycles === undefined ? {} : { maxCycles }),
      signal: controller.signal,
    });
    const totals = reports.reduce((sum, report) => ({
      blocks: sum.blocks + report.blocks,
      candidates: sum.candidates + report.candidates,
      duplicates: sum.duplicates + report.duplicates,
    }), { blocks: 0, candidates: 0, duplicates: 0 });
    return { ok: true, code: 'LEARN_WATCH_STOPPED', message: 'learn watch stopped', data: { cycles: reports.length, ...totals, reports } };
  }
  const report = await runLearn({
    ...(text === undefined ? {} : { text }),
    ...(file === undefined ? {} : { file }),
    ...(dir === undefined ? {} : { dir }),
    ...(url === undefined ? {} : { url }),
    ...(include === undefined ? {} : { include }),
    ...(type === undefined ? {} : { type: type as MemoryType }),
    ...(project === undefined ? {} : { project }),
    allowNetwork,
  }, {
    brainPath: context.brainPath,
    semantic: { modelPath: context.config.retrieval.semantic.modelPath },
    ...(maxBlocks === undefined ? {} : { maxBlocks }),
  });
  return { ok: true, code: 'LEARN_COMPLETED', message: 'learn run completed', data: report };
}

function requestedAgentIds(value: string, registry: AgentAdapterRegistry): readonly string[] {
  const requested = value === 'all' ? registry.all().map((adapter) => adapter.id) : value.split(',').map((id) => id.trim()).filter((id) => id.length > 0);
  const normalized = requested.map((id) => id === 'claude' ? 'claude-code' : id);
  for (const id of normalized) {
    if (id !== 'local' && registry.get(id) === null) throw new CliFailure(exitCodes.invalidInput, 'INVALID_INPUT', `unsupported agent: ${id}`);
  }
  return [...new Set(normalized)];
}

function initConfigPath(context: CliContext, brainPath: string): string {
  const requestedConfig = optionString(context.options, 'config') ?? context.env.TAGA_CONFIG;
  if (requestedConfig !== undefined && requestedConfig.length > 0) return resolve(context.cwd, requestedConfig);
  return optionString(context.options, 'brain') === undefined ? context.configPath : join(brainPath, 'config.yaml');
}

function agentDisplayName(id: string): string {
  const names: Readonly<Record<string, string>> = {
    'claude-code': 'Claude Code',
    codex: 'Codex',
    pi: 'Pi',
    opencode: 'OpenCode',
    cursor: 'Cursor',
    windsurf: 'Windsurf',
    cline: 'Cline',
    roo: 'Roo Code',
  };
  return names[id] ?? id;
}

function formatPercent(loaded: number, total: number): string {
  if (total <= 0) return 'preparing';
  return `${Math.min(100, Math.max(0, Math.round((loaded / total) * 100)))}%`;
}

async function configuredAgentTargets(context: CliContext, resolvedProject?: ProjectContext): Promise<readonly { readonly id: string; readonly targetPaths: readonly string[] }[]> {
  const project = resolvedProject ?? await resolveCliProject(context);
  const registry = new AgentAdapterRegistry();
  return context.config.agents.enabled.map((configuredId) => {
    const id = configuredId === 'claude' ? 'claude-code' : configuredId;
    return {
      id,
      targetPaths: agentTargetPaths(registry, id, project.root),
    };
  });
}

function agentTargetPaths(registry: AgentAdapterRegistry, id: string, projectRoot: string): readonly string[] {
  return registry.get(id)?.staticTargets(projectRoot)
    ?? [join(projectRoot, id === 'claude-code' ? 'CLAUDE.md' : 'AGENTS.md')];
}

async function resolveCliProject(context: CliContext): Promise<ProjectContext> {
  const legacyProject = optionString(context.options, 'project');
  const legacyProjectId = legacyProject?.startsWith('project-') === true ? legacyProject : undefined;
  const legacyProjectRoot = legacyProjectId === undefined ? legacyProject : undefined;
  return resolveProjectContext({
    cwd: context.cwd,
    ...(optionString(context.options, 'project-root') === undefined && legacyProjectRoot === undefined ? {} : { projectRoot: optionString(context.options, 'project-root') ?? legacyProjectRoot as string }),
    ...(optionString(context.options, 'project-id') === undefined && legacyProjectId === undefined ? {} : { projectId: optionString(context.options, 'project-id') ?? legacyProjectId as string }),
    markerFile: context.config.projectResolution.markerFile,
    preferGitRoot: context.config.projectResolution.preferGitRoot,
    preferGitRemote: context.config.projectResolution.preferGitRemote,
  });
}

function projectRecord(project: ProjectContext): Parameters<DatabaseStore['saveProjectContext']>[0] {
  return {
    id: project.id,
    root: project.root,
    name: project.name,
    source: project.source,
    canonicalKey: project.canonicalKey,
    ...(project.gitRemote === undefined ? {} : { gitRemote: project.gitRemote }),
  };
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

async function markerHealth(context: CliContext): Promise<{ ok: boolean; status: string; detail?: string }> {
  if (!context.config.agents.writeInstructions) return { ok: true, status: 'not-configured' };
  const targets = (await configuredAgentTargets(context)).flatMap((agent) => agent.targetPaths);
  if (targets.length === 0) return { ok: true, status: 'not-configured' };
  const failures: string[] = [];
  for (const target of targets) {
    try {
      const content = await readFile(target, 'utf8');
      const begin = content.includes(markerBegin);
      const end = content.includes(markerEnd);
      if (begin !== end) failures.push(`${target}:unbalanced`);
    } catch {
      failures.push(`${target}:missing`);
    }
  }
  return failures.length === 0
    ? { ok: true, status: 'healthy' }
    : { ok: false, status: 'invalid', detail: JSON.stringify(failures) };
}

function writeResponse(streams: CliStreams, json: boolean, response: CliResponse): void {
  if (response.silent === true) return;
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
  if (error instanceof ConfigurationError) {
    return { ok: false, code: 'CONFIG_INVALID', message: error.message, data: { issues: error.issues }, request_id: requestId };
  }
  return { ok: false, code: 'INTERNAL_ERROR', message: errorMessage(error), request_id: requestId };
}

function responseExitCode(error: unknown): number {
  if (error instanceof CliFailure) return error.exitCode;
  if (error instanceof ConfigurationError) return exitCodes.invalidInput;
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

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isPermissionError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && ['EACCES', 'EPERM', 'EBUSY'].includes(String(error.code));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
