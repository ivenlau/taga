import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import {
  DEFAULT_PROACTIVE_POLICY,
  GovernanceService,
  SqliteAuditLog,
  enqueueConsolidationScan,
} from '../../../packages/application/src/index.js';
import { enqueueLearnCorrection } from '../../../packages/learning/src/index.js';
import {
  contentHash,
  DatabaseStore,
  MarkdownMemoryRepository,
  markerBegin,
  markerEnd,
  parseMarkdownDocument,
} from '../../../packages/storage/src/index.js';
import { ContextPackBuilder } from '../../../packages/context/src/index.js';
import { BrainBrowser } from '../../../packages/browsing/src/index.js';
import {
  FtsRetrievalProvider,
  type HybridRetrievalResult,
  type RetrievalResult,
  type SemanticRetriever,
} from '../../../packages/retrieval/src/index.js';
import { createLocalBgeM3Embedder, type Embedder } from '../../../packages/embedding/src/index.js';
import { enqueueSemanticUpsert, ZvecMemoryIndex, ZvecSemanticRetriever } from '../../../packages/semantic-index/src/index.js';
import { parseMemory, type Memory } from '../../../packages/domain/src/index.js';
import { NotificationService } from '../../../packages/notifications/src/index.js';
import { MemoryPrecheckService } from '../../../packages/precheck/src/index.js';
import { SessionContextService, observationContentHash } from '../../../packages/session/src/index.js';
import { AgentAdapterRegistry } from '../../../packages/adapters/src/index.js';
import { createDefaultConfig, type ResolvedConfig } from '../../../packages/config/src/index.js';
import { resolveProjectContext, type ProjectContext } from '../../../packages/project-context/src/index.js';

const searchInputSchema = z.object({
  query: z.string().min(1),
  session_id: z.string().min(1).optional(),
  project_id: z.string().min(1).optional(),
  type: z.array(z.enum(['preferences', 'environment', 'procedures', 'lessons', 'projects'])).optional(),
  k: z.number().int().positive().max(100).optional(),
  include_draft: z.boolean().default(false),
  semantic_mode: z.enum(['off', 'shadow', 'on']).optional(),
});

const timelineInputSchema = z.object({
  memory_id: z.string().min(1),
  source: z.string().min(1).optional(),
  session_id: z.string().min(1).optional(),
  task_id: z.string().min(1).optional(),
  include_observations: z.boolean().default(true),
  include_body: z.boolean().default(false),
  limit: z.number().int().positive().max(200).optional(),
});

const sessionStartInputSchema = z.object({
  agent_id: z.string().min(1).default('local'),
  session_id: z.string().min(1),
  project_id: z.string().min(1).optional(),
  project_root: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  task: z.string().min(1).optional(),
  token_budget: z.number().int().positive().max(10_000).optional(),
  refresh: z.boolean().default(false),
  target_path: z.string().min(1).optional(),
  inject: z.boolean().default(false),
});

const sessionObservationInputSchema = z.object({
  session_id: z.string().min(1),
  task_id: z.string().min(1).optional(),
  project_id: z.string().min(1).optional(),
  occurred_at: z.string().datetime().optional(),
  sequence: z.number().int().nonnegative(),
  kind: z.string().min(1),
  summary: z.string().min(1),
  body: z.string().max(20_000).optional(),
  memory_ids: z.array(z.string().min(1)).default([]),
  source_refs: z.array(z.string().min(1)).default([]),
  visibility: z.enum(['normal', 'redacted', 'excluded']).default('normal'),
});

const getInputSchema = z.object({
  memory_id: z.string().min(1),
  include_body: z.boolean().default(false),
  include_evidence: z.boolean().default(false),
  include_audit: z.boolean().default(false),
  include_versions: z.boolean().default(false),
});

const recordInputSchema = z.object({
  type: z.enum(['preferences', 'environment', 'procedures', 'lessons', 'projects']),
  scope: z.string().min(1).default('auto'),
  session_id: z.string().min(1).optional(),
  project_id: z.string().min(1).nullable().optional(),
  title: z.string().min(1),
  body: z.string().min(1),
  tags: z.array(z.string().min(1)).default([]),
  sources: z.array(z.object({
    kind: z.enum(['file', 'line', 'symbol', 'url', 'commit', 'test', 'tool_call']),
    locator: z.string().min(1),
    label: z.string().min(1).optional(),
    hash: z.string().min(1).optional(),
  })).min(1),
  anchors: z.array(z.object({
    kind: z.enum(['file', 'line', 'symbol', 'url', 'commit', 'test', 'tool_call']),
    locator: z.string().min(1),
    label: z.string().min(1).optional(),
    hash: z.string().min(1).optional(),
  })).default([]),
  requested_status: z.enum(['candidate', 'draft', 'active']).default('candidate'),
  actor: z.enum(['user', 'agent']).default('agent'),
});

const feedbackInputSchema = z.object({
  memory_id: z.string().min(1),
  kind: z.enum(['useful', 'not_useful', 'verified', 'conflict', 'cite', 'outcome']),
  note: z.string().max(1000).optional(),
  project_id: z.string().min(1).optional(),
  session_id: z.string().min(1).optional(),
});

const contextTraceInputSchema = z.object({
  agent_id: z.string().min(1).default('local'),
  session_id: z.string().min(1).optional(),
  project_id: z.string().min(1).optional(),
  task: z.string().min(1).optional(),
});

const precheckInputSchema = z.object({
  file: z.string().min(1).optional(),
  line: z.number().int().positive().optional(),
  symbol: z.string().min(1).optional(),
  commit: z.string().min(1).optional(),
  task: z.string().min(1).optional(),
  session_id: z.string().min(1).optional(),
  project_id: z.string().min(1).optional(),
  agent_id: z.string().min(1).optional(),
  allow_reminder: z.boolean().default(false),
  timeout_ms: z.number().int().positive().max(10_000).optional(),
}).refine((value) => value.file !== undefined || value.symbol !== undefined || value.commit !== undefined, 'file, symbol, or commit is required');

const brainListInputSchema = z.object({
  type: z.enum(['preferences', 'environment', 'procedures', 'lessons', 'projects']).optional(),
  status: z.enum(['candidate', 'draft', 'active', 'stale', 'superseded', 'forgotten']).optional(),
  project_id: z.string().min(1).optional(),
  scope: z.enum(['global', 'domain', 'project']).optional(),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(200).optional(),
});

const brainDetailInputSchema = z.object({
  memory_id: z.string().min(1),
  include_body: z.boolean().default(false),
  include_evidence: z.boolean().default(false),
});

const knowledgeIngestInputSchema = z.object({
  content: z.string().min(1).max(200_000),
  type: z.enum(['preferences', 'environment', 'procedures', 'lessons', 'projects']).optional(),
  project: z.string().min(1).optional(),
});

const toolCallSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]),
  method: z.literal('tools/call'),
  params: z.object({
    name: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()).default({}),
  }),
});

const requestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]),
  method: z.string().min(1),
});

const notificationSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.string().min(1),
});

const initializeSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]),
  method: z.literal('initialize'),
  params: z.object({ protocolVersion: z.string().min(1).optional() }).optional(),
});

export interface McpTool {
  readonly name: string;
  readonly version: 'v1';
  readonly description: string;
}

export interface McpResponse {
  readonly jsonrpc: '2.0';
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

interface MemoryFile {
  readonly memory: Memory;
  readonly body: string;
}

const tools: readonly McpTool[] = [
  { name: 'memory_search', version: 'v1', description: 'Search active memory summaries with FTS5.' },
  { name: 'memory_timeline', version: 'v1', description: 'Read a memory timeline without sensitive raw evidence.' },
  { name: 'memory_session_start', version: 'v1', description: 'Build or load a bounded session-start context pack.' },
  { name: 'memory_session_observation', version: 'v1', description: 'Record a redacted session observation for later timeline recall.' },
  { name: 'memory_get', version: 'v1', description: 'Read memory metadata and optionally its body.' },
  { name: 'memory_record', version: 'v1', description: 'Record a candidate or draft memory for review.' },
  { name: 'memory_feedback', version: 'v1', description: 'Record auditable feedback about a memory.' },
  { name: 'context_trace', version: 'v1', description: 'Explain context pack inclusion, exclusion, and truncation decisions.' },
  { name: 'memory_precheck', version: 'v1', description: 'Check relevant active memories and procedures before editing without executing actions.' },
  { name: 'brain_tree', version: 'v1', description: 'Browse canonical Brain Markdown paths.' },
  { name: 'brain_list', version: 'v1', description: 'Browse visible Memory metadata with filters and pagination.' },
  { name: 'brain_summary', version: 'v1', description: 'Summarize visible Brain partitions and statuses.' },
  { name: 'brain_detail', version: 'v1', description: 'Read Brain relations and optionally expand body or Evidence references.' },
  { name: 'brain_rebuild', version: 'v1', description: 'Rebuild derived Brain relations from canonical Markdown.' },
  { name: 'knowledge_ingest', version: 'v1', description: 'Queue user-supplied knowledge text for distillation into reviewable candidates.' },
];

const mcpProtocolVersion = '2025-06-18';
const serverInfo = { name: 'taga-mcp', version: '0.1.0' } as const;

const toolInputSchemas: Readonly<Record<string, z.ZodType | undefined>> = {
  memory_search: searchInputSchema,
  memory_timeline: timelineInputSchema,
  memory_session_start: sessionStartInputSchema,
  memory_session_observation: sessionObservationInputSchema,
  memory_get: getInputSchema,
  memory_record: recordInputSchema,
  memory_feedback: feedbackInputSchema,
  context_trace: contextTraceInputSchema,
  memory_precheck: precheckInputSchema,
  brain_tree: undefined,
  brain_list: brainListInputSchema,
  brain_summary: undefined,
  brain_detail: brainDetailInputSchema,
  brain_rebuild: undefined,
  knowledge_ingest: knowledgeIngestInputSchema,
};

interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

function mcpTools(): readonly McpToolDefinition[] {
  return tools.map((tool) => {
    const schema = toolInputSchemas[tool.name];
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: schema === undefined ? { type: 'object', properties: {} } : z.toJSONSchema(schema, { io: 'input' }),
    };
  });
}

function toolCallResult(payload: unknown): { content: Array<{ type: 'text'; text: string }>; structuredContent: unknown } {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
}

export class LiteMcpServer {
  private semanticIndex: ZvecMemoryIndex | undefined;
  private semanticEmbedder: Embedder | undefined;

  constructor(
    private readonly brainPath: string,
    private readonly clock: () => Date = () => new Date(),
    private readonly config: ResolvedConfig = createDefaultConfig(process.cwd(), brainPath),
  ) {}

  close(): void {
    this.semanticIndex?.close();
    this.semanticIndex = undefined;
    this.semanticEmbedder = undefined;
  }

  async handle(input: unknown): Promise<McpResponse | null> {
    const base = requestSchema.safeParse(input);
    if (!base.success) {
      if (notificationSchema.safeParse(input).success) return null;
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid JSON-RPC request' } };
    }
    if (base.data.method === 'initialize') {
      const parsed = initializeSchema.safeParse(input);
      const requested = parsed.success ? parsed.data.params?.protocolVersion : undefined;
      return {
        jsonrpc: '2.0',
        id: base.data.id,
        result: {
          protocolVersion: requested ?? mcpProtocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo,
        },
      };
    }
    if (base.data.method === 'ping') {
      return { jsonrpc: '2.0', id: base.data.id, result: {} };
    }
    if (base.data.method === 'tools/list') {
      return { jsonrpc: '2.0', id: base.data.id, result: { tools: mcpTools() } };
    }
    const call = toolCallSchema.safeParse(input);
    if (!call.success) {
      return { jsonrpc: '2.0', id: base.data.id, error: { code: -32601, message: 'unsupported method' } };
    }
    try {
      const payload = await this.callTool(call.data.params.name, call.data.params.arguments);
      return { jsonrpc: '2.0', id: call.data.id, result: toolCallResult(payload) };
    } catch (error) {
      return { jsonrpc: '2.0', id: call.data.id, error: { code: -32602, message: safeErrorMessage(error) } };
    }
  }

  private async callTool(name: string, input: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'memory_search':
        return this.search(input);
      case 'memory_timeline':
        return this.timeline(input);
      case 'memory_session_start':
        return this.sessionStart(input);
      case 'memory_session_observation':
        return this.sessionObservation(input);
      case 'memory_get':
        return this.get(input);
      case 'memory_record':
        return this.record(input);
      case 'memory_feedback':
        return this.feedback(input);
      case 'context_trace':
        return this.contextTrace(input);
      case 'memory_precheck':
        return this.precheck(input);
      case 'brain_tree':
        return this.brainTree();
      case 'brain_list':
        return this.brainList(input);
      case 'brain_summary':
        return this.brainSummary();
      case 'brain_detail':
        return this.brainDetail(input);
      case 'brain_rebuild':
        return this.brainRebuild();
      case 'knowledge_ingest':
        return this.knowledgeIngest(input);
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }

  private knowledgeIngest(input: Record<string, unknown>): Promise<unknown> {
    const parsed = knowledgeIngestInputSchema.parse(input);
    const database = new DatabaseStore(join(this.brainPath, 'taga.db'));
    try {
      const jobId = `learn-distill-${contentHash(parsed.content)}`;
      const queued = database.enqueueJobIfAbsent({
        id: jobId,
        kind: 'learn.distill',
        payload: JSON.stringify({
          text: parsed.content,
          ...(parsed.type === undefined ? {} : { type: parsed.type }),
          ...(parsed.project === undefined ? {} : { project: parsed.project }),
        }),
      });
      return Promise.resolve({
        ok: true,
        data: { queued, job_id: jobId, status_hint: queued ? 'the daemon will distill this into reviewable candidates' : 'this content is already queued' },
        degraded: false,
        warnings: [],
        next_actions: [{ tool: 'brain_summary' }],
      });
    } finally {
      database.close();
    }
  }

  private async brainTree(): Promise<unknown> {
    const database = new DatabaseStore(join(this.brainPath, 'taga.db'));
    try {
      return { ok: true, data: await new BrainBrowser(this.brainPath, database).tree(), degraded: false, warnings: [], next_actions: [] };
    } finally {
      database.close();
    }
  }

  private async brainList(input: Record<string, unknown>): Promise<unknown> {
    const parsed = brainListInputSchema.parse(input);
    const database = new DatabaseStore(join(this.brainPath, 'taga.db'));
    try {
      return {
        ok: true,
        data: await new BrainBrowser(this.brainPath, database).list({
          ...(parsed.type === undefined ? {} : { type: parsed.type }),
          ...(parsed.status === undefined ? {} : { status: parsed.status }),
          ...(parsed.project_id === undefined ? {} : { projectId: parsed.project_id }),
          ...(parsed.scope === undefined ? {} : { scope: parsed.scope }),
          ...(parsed.offset === undefined ? {} : { offset: parsed.offset }),
          ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
        }),
        degraded: false,
        warnings: [],
        next_actions: [],
      };
    } finally {
      database.close();
    }
  }

  private async brainSummary(): Promise<unknown> {
    const database = new DatabaseStore(join(this.brainPath, 'taga.db'));
    try {
      return { ok: true, data: await new BrainBrowser(this.brainPath, database).summary(), degraded: false, warnings: [], next_actions: [] };
    } finally {
      database.close();
    }
  }

  private async brainDetail(input: Record<string, unknown>): Promise<unknown> {
    const parsed = brainDetailInputSchema.parse(input);
    const database = new DatabaseStore(join(this.brainPath, 'taga.db'));
    try {
      const detail = await new BrainBrowser(this.brainPath, database).detail(parsed.memory_id, { includeBody: parsed.include_body, includeEvidence: parsed.include_evidence });
      if (detail === null) throw new Error('memory not found or not browseable');
      return { ok: true, data: detail, degraded: false, warnings: [], next_actions: [] };
    } finally {
      database.close();
    }
  }

  private async brainRebuild(): Promise<unknown> {
    const database = new DatabaseStore(join(this.brainPath, 'taga.db'));
    try {
      return { ok: true, data: await new BrainBrowser(this.brainPath, database).rebuildRelations(), degraded: false, warnings: [], next_actions: [] };
    } finally {
      database.close();
    }
  }

  private async search(input: Record<string, unknown>): Promise<unknown> {
    const parsed = searchInputSchema.parse(input);
    const database = new DatabaseStore(join(this.brainPath, 'taga.db'));
    try {
      const projectId = resolveBoundProjectId(database, parsed.session_id, parsed.project_id);
      const provider = new FtsRetrievalProvider(database);
      const catalog = new Map((await this.readMemoryFiles()).map((item) => [item.memory.id, item.memory]));
      const mode = parsed.semantic_mode ?? this.config.retrieval.semantic.mode;
      const searchInput = {
        query: parsed.query,
        ...(projectId === undefined ? {} : { scope: { kind: 'project' as const, id: projectId } }),
        ...(parsed.include_draft === true ? { includeDraft: true } : {}),
        limit: parsed.k ?? 5,
      };
      const semantic = mode === 'off' ? undefined : this.semanticRetriever(database);
      const lexical = provider.searchSafe(searchInput);
      const queryId = `q-${randomUUID()}`;
      let shadowObservation: HybridRetrievalResult | undefined;
      let retrieval: RetrievalResult | HybridRetrievalResult;
      if (mode === 'off') {
        retrieval = lexical;
      } else if (mode === 'shadow') {
        shadowObservation = await provider.searchHybrid(searchInput, semantic);
        retrieval = { ...lexical, degraded: shadowObservation.degraded };
      } else {
        retrieval = await provider.searchHybrid(searchInput, semantic);
      }
      const filtered = parsed.type === undefined
        ? retrieval.items
        : retrieval.items.filter((item) => {
          const memory = catalog.get(item.memory.id);
          return memory !== undefined && parsed.type?.includes(memory.type) === true;
        });
      const results = filtered.slice(0, parsed.k ?? 5).map((item) => ({
        id: item.memory.id,
        type: catalog.get(item.memory.id)?.type ?? 'lessons',
        scope: item.memory.scopeId === null ? item.memory.scopeKind : `${item.memory.scopeKind}:${item.memory.scopeId}`,
        status: item.memory.status,
        title: item.memory.title,
        summary: item.memory.summary,
        score: item.score,
        match_reason: item.matchReason,
        proof: {
          useful_count: item.memory.usefulCount ?? 0,
          not_useful_count: item.memory.notUsefulCount ?? 0,
          ...(item.memory.lastVerified === undefined || item.memory.lastVerified === null ? {} : { verified_at: item.memory.lastVerified }),
        },
        freshness: freshnessFor(item.memory.updatedAt, this.clock()),
        suggested_action: 'memory_timeline',
        detail_id: item.memory.id,
      }));
      const audit = new SqliteAuditLog(database);
      if (shadowObservation !== undefined) {
        await audit.append({
          eventType: 'memory.semantic_shadow',
          actor: 'agent',
          subjectType: 'search',
          subjectId: queryId,
          occurredAt: this.clock().toISOString(),
          reason: 'shadow semantic recall via MCP',
          payload: {
            query: parsed.query,
            lexicalIds: lexical.items.map((item) => item.memory.id),
            semanticIds: shadowObservation.items.filter((item) => item.source !== 'fts5').map((item) => item.memory.id),
            degraded: shadowObservation.degraded,
          },
        });
      }
      for (const result of results) {
        await audit.append({
          eventType: 'memory.recalled',
          actor: 'agent',
          subjectType: 'memory',
          subjectId: result.id,
          occurredAt: this.clock().toISOString(),
          reason: 'memory_search via MCP',
          payload: { query: parsed.query, queryId },
        });
      }
      return {
        ok: true,
        data: {
          query_id: queryId,
          results,
        },
        degraded: retrieval.degraded,
        warnings: retrieval.degraded
          ? [mode === 'off' ? 'FTS unavailable; run taga reindex --apply' : 'semantic retrieval degraded; FTS5 results returned']
          : [],
        next_actions: results.map((result) => ({ tool: 'memory_timeline', memory_id: result.id })),
      };
    } finally {
      database.close();
    }
  }

  private semanticRetriever(database: DatabaseStore): SemanticRetriever {
    this.semanticIndex ??= new ZvecMemoryIndex(join(this.brainPath, '.taga', 'semantic'));
    this.semanticEmbedder ??= createLocalBgeM3Embedder({ modelPath: this.config.retrieval.semantic.modelPath, batchSize: 4 });
    return new ZvecSemanticRetriever({
      database,
      index: this.semanticIndex,
      embedder: this.semanticEmbedder,
    });
  }

  private async timeline(input: Record<string, unknown>): Promise<unknown> {
    const parsed = timelineInputSchema.parse(input);
    const database = new DatabaseStore(join(this.brainPath, 'taga.db'));
    try {
      const memory = (await this.readMemoryFiles()).find((item) => item.memory.id === parsed.memory_id);
      if (memory === undefined) throw new Error('memory not found');
      const audit = await new SqliteAuditLog(database).list();
      const events = [
        ...audit
          .filter((event) => event.subjectType === 'memory' && event.subjectId === parsed.memory_id)
          .map((event) => ({
            occurred_at: event.occurredAt,
            event: event.eventType,
            summary: event.reason,
            source_refs: memory.memory.sources,
            session_id: typeof event.payload?.sessionId === 'string' ? event.payload.sessionId : parsed.session_id ?? null,
            task_id: typeof event.payload?.taskId === 'string' ? event.payload.taskId : parsed.task_id ?? null,
          })),
        ...new FtsRetrievalProvider(database).timeline(parsed.memory_id).map((event) => ({
          occurred_at: event.occurredAt,
          event: event.event,
          summary: 'Memory indexed',
          source_refs: memory.memory.sources,
          session_id: parsed.session_id ?? null,
          task_id: parsed.task_id ?? null,
        })),
        ...(parsed.include_observations
          ? new SessionContextService(this.brainPath, database).timeline({
            memoryId: parsed.memory_id,
            ...(parsed.session_id === undefined ? {} : { sessionId: parsed.session_id }),
            ...(parsed.task_id === undefined ? {} : { taskId: parsed.task_id }),
            ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
            includeBody: parsed.include_body,
          }).map((observation) => ({
            occurred_at: observation.occurredAt,
            event: `observation:${observation.kind}`,
            summary: observation.summary,
            source_refs: observation.sourceRefs,
            session_id: observation.sessionId,
            task_id: observation.taskId ?? null,
            ...(observation.body === undefined ? {} : { body: observation.body }),
          }))
          : []),
      ].filter((event, index, all) => index === all.findIndex((candidate) => candidate.event === event.event && candidate.occurred_at === event.occurred_at));
      events.sort((left, right) => left.occurred_at.localeCompare(right.occurred_at));
      await new SqliteAuditLog(database).append({
        eventType: 'memory.opened',
        actor: 'agent',
        subjectType: 'memory',
        subjectId: parsed.memory_id,
        occurredAt: this.clock().toISOString(),
        reason: 'memory_timeline via MCP',
        payload: {
          ...(parsed.session_id === undefined ? {} : { sessionId: parsed.session_id }),
          ...(parsed.task_id === undefined ? {} : { taskId: parsed.task_id }),
        },
      });
      return { ok: true, data: { memory_id: parsed.memory_id, events }, degraded: false, warnings: [], next_actions: [] };
    } finally {
      database.close();
    }
  }

  private async sessionStart(input: Record<string, unknown>): Promise<unknown> {
    const parsed = sessionStartInputSchema.parse(input);
    const database = new DatabaseStore(join(this.brainPath, 'taga.db'));
    try {
      const project = await resolveProjectContext({
        cwd: parsed.cwd ?? process.cwd(),
        ...(parsed.project_root === undefined ? {} : { projectRoot: parsed.project_root }),
        ...(parsed.project_id === undefined ? {} : { projectId: parsed.project_id }),
        markerFile: this.config.projectResolution.markerFile,
        preferGitRoot: this.config.projectResolution.preferGitRoot,
        preferGitRemote: this.config.projectResolution.preferGitRemote,
      });
      database.saveProjectContext(projectRecord(project));
      database.saveSessionContext({
        sessionId: parsed.session_id,
        projectId: project.id,
        projectRoot: project.root,
        cwd: project.cwd,
        agentId: parsed.agent_id,
        source: project.source,
      });
      const result = await new SessionContextService(this.brainPath, database, this.clock).start({
        agentId: parsed.agent_id,
        sessionId: parsed.session_id,
        projectId: project.id,
        cwd: project.cwd,
        ...(parsed.task === undefined ? {} : { task: parsed.task }),
        ...(parsed.token_budget === undefined ? {} : { tokenBudget: parsed.token_budget }),
        refresh: parsed.refresh,
      }, await this.readMemoryFiles());
      let injectedPath: string | undefined;
      if (parsed.inject && parsed.target_path !== undefined) {
        await new ContextPackBuilder().inject(parsed.target_path, result.pack);
        injectedPath = parsed.target_path;
      }
      await new SqliteAuditLog(database).append({
        eventType: 'context.session_started',
        actor: 'agent',
        subjectType: 'session',
        subjectId: parsed.session_id,
        occurredAt: this.clock().toISOString(),
        reason: 'memory_session_start via MCP',
        payload: {
          agentId: parsed.agent_id,
          projectId: project.id,
          projectRoot: project.root,
          source: result.source,
          stale: result.stale,
          packId: result.pack.id,
        },
      });
      return {
        ok: true,
        data: {
          session_id: result.sessionId,
          project_id: project.id,
          project_root: project.root,
          project_name: project.name,
          project_source: project.source,
          pack_id: result.pack.id,
          content: result.pack.content,
          sections: result.pack.sections,
          decisions: result.pack.decisions,
          token_estimate: result.pack.tokenEstimate,
          source: result.source,
          stale: result.stale,
          cache_key: result.cacheKey,
          ...(injectedPath === undefined ? {} : { injected_path: injectedPath }),
        },
        degraded: result.pack.degraded,
        warnings: result.stale ? ['cached context pack is older than six hours; rerun with refresh=true'] : [],
        next_actions: [{ tool: 'memory_search', query: parsed.task ?? 'recent project decisions' }],
      };
    } finally {
      database.close();
    }
  }

  private sessionObservation(input: Record<string, unknown>): unknown {
    const parsed = sessionObservationInputSchema.parse(input);
    const database = new DatabaseStore(join(this.brainPath, 'taga.db'));
    try {
      const projectId = resolveBoundProjectId(database, parsed.session_id, parsed.project_id);
      const occurredAt = parsed.occurred_at ?? this.clock().toISOString();
      const observation = {
        id: `obs-${randomUUID()}`,
        sessionId: parsed.session_id,
        ...(parsed.task_id === undefined ? {} : { taskId: parsed.task_id }),
        ...(projectId === undefined ? {} : { projectId }),
        occurredAt,
        sequence: parsed.sequence,
        kind: parsed.kind,
        summary: parsed.summary,
        ...(parsed.body === undefined ? {} : { body: parsed.body }),
        memoryIds: parsed.memory_ids,
        sourceRefs: parsed.source_refs,
        contentHash: observationContentHash({ sessionId: parsed.session_id, sequence: parsed.sequence, kind: parsed.kind, summary: parsed.summary }),
        visibility: parsed.visibility,
      };
      const created = new SessionContextService(this.brainPath, database).recordObservation(observation);
      return {
        ok: true,
        data: { observation_id: observation.id, created, session_id: observation.sessionId },
        degraded: false,
        warnings: [],
        next_actions: [],
      };
    } finally {
      database.close();
    }
  }

  private async get(input: Record<string, unknown>): Promise<unknown> {
    const parsed = getInputSchema.parse(input);
    const records = await this.readMemoryFiles();
    const memory = records.find((item) => item.memory.id === parsed.memory_id);
    if (memory === undefined) throw new Error('memory not found');
    const database = new DatabaseStore(join(this.brainPath, 'taga.db'));
    try {
      const audit = parsed.include_audit
        ? (await new SqliteAuditLog(database).list()).filter((event) => event.subjectType === 'memory' && event.subjectId === parsed.memory_id)
        : undefined;
      const versions = parsed.include_versions ? versionIds(records, parsed.memory_id) : undefined;
      const injection = await this.injectionStatus(memory.memory);
      const warnings = injection === 'unknown' ? ['injection target is not configured'] : [];
      await new SqliteAuditLog(database).append({
        eventType: 'memory.opened',
        actor: 'agent',
        subjectType: 'memory',
        subjectId: parsed.memory_id,
        occurredAt: this.clock().toISOString(),
        reason: 'memory_get via MCP',
        payload: {},
      });
      return {
        ok: true,
        data: {
          id: memory.memory.id,
          type: memory.memory.type,
          scope: memory.memory.scope,
          status: memory.memory.status,
          title: memory.memory.title,
          summary: memory.memory.summary,
          confidence: memory.memory.confidence,
          source_trust: memory.memory.sourceTrust,
          tags: memory.memory.tags,
          sources: memory.memory.sources,
          supersedes: memory.memory.supersedes,
          superseded_by: records.find((item) => item.memory.supersedes === memory.memory.id)?.memory.id ?? null,
          conflicts: records.filter((item) => item.memory.id !== memory.memory.id && item.memory.contentHash === memory.memory.contentHash).map((item) => item.memory.id),
          injection_status: injection,
          ...(parsed.include_body ? { body: memory.body } : {}),
          ...(parsed.include_evidence ? { evidence: memory.memory.sources } : {}),
          ...(audit === undefined ? {} : { audit }),
          ...(versions === undefined ? {} : { versions }),
        },
        degraded: warnings.length > 0,
        warnings,
        next_actions: [],
      };
    } finally {
      database.close();
    }
  }

  private async contextTrace(input: Record<string, unknown>): Promise<unknown> {
    const parsed = contextTraceInputSchema.parse(input);
    const records = await this.readMemoryFiles();
    const database = new DatabaseStore(join(this.brainPath, 'taga.db'));
    try {
      const projectId = resolveBoundProjectId(database, parsed.session_id, parsed.project_id);
      const pack = new ContextPackBuilder().build({
        agentId: parsed.agent_id,
        ...(projectId === undefined ? {} : { projectId }),
        ...(parsed.task === undefined ? {} : { task: parsed.task }),
        channel: 'mcp',
        candidates: records.map(({ memory, body }) => ({ memory, body })),
      });
      return { ok: true, data: new ContextPackBuilder().trace(pack), degraded: false, warnings: [], next_actions: [] };
    } finally {
      database.close();
    }
  }

  private async precheck(input: Record<string, unknown>): Promise<unknown> {
    const parsed = precheckInputSchema.parse(input);
    const database = new DatabaseStore(join(this.brainPath, 'taga.db'));
    try {
      const projectId = resolveBoundProjectId(database, parsed.session_id, parsed.project_id);
      const audit = new SqliteAuditLog(database);
      const notifications = new NotificationService(database, audit, {
        policy: { ...DEFAULT_PROACTIVE_POLICY, allowL2Reminders: parsed.allow_reminder },
        clock: this.clock,
      });
      const result = await new MemoryPrecheckService(database, new MarkdownMemoryRepository(this.brainPath), audit, { notifications, clock: this.clock }).run({
        target: {
          ...(parsed.file === undefined ? {} : { file: parsed.file }),
          ...(parsed.line === undefined ? {} : { line: parsed.line }),
          ...(parsed.symbol === undefined ? {} : { symbol: parsed.symbol }),
          ...(parsed.commit === undefined ? {} : { commit: parsed.commit }),
        },
        ...(parsed.task === undefined ? {} : { task: parsed.task }),
        ...(projectId === undefined ? {} : { projectId }),
        ...(parsed.agent_id === undefined ? {} : { agentId: parsed.agent_id }),
        ...(parsed.timeout_ms === undefined ? {} : { timeoutMs: parsed.timeout_ms }),
      });
      return { ok: true, data: result, degraded: result.degraded, warnings: result.diagnostics, next_actions: result.items.slice(0, 3).map((item) => ({ tool: 'memory_get', memory_id: item.memoryId })) };
    } finally {
      database.close();
    }
  }

  private async record(input: Record<string, unknown>): Promise<unknown> {
    const parsed = recordInputSchema.parse(input);
    const database = new DatabaseStore(join(this.brainPath, 'taga.db'));
    try {
      const projectId = resolveBoundProjectId(database, parsed.session_id, parsed.project_id ?? undefined);
      const scope = parseScope(parsed.scope, parsed.type, projectId);
      if (scope.kind === 'project' && projectId !== undefined && scope.id !== projectId) throw new Error('explicit project scope conflicts with session project');
      const status = parsed.requested_status === 'active' ? 'draft' : parsed.requested_status;
      const now = this.clock().toISOString();
      const id = `mem-${randomUUID()}`;
      const memory = parseMemory({
        schemaVersion: 1,
        id,
        type: parsed.type,
        scope,
        projectId: scope.kind === 'project' ? scope.id : null,
        status,
        title: parsed.title,
        summary: parsed.body.slice(0, 240),
        confidence: 0.5,
        sourceTrust: parsed.actor === 'user' ? 'user_authored' : 'observed',
        visibility: 'private',
        created: now,
        updated: now,
        lastVerified: null,
        lastRecalled: null,
        reviewCount: 0,
        usefulCount: 0,
        notUsefulCount: 0,
        expiresAt: null,
        contentHash: contentHash(parsed.body),
        sources: parsed.sources,
        anchors: parsed.anchors,
        tags: parsed.tags,
        supersedes: null,
      });
      const repository = new MarkdownMemoryRepository(this.brainPath);
      repository.setBody(memory.id, parsed.body);
      const saved = await new GovernanceService(repository, new SqliteAuditLog(database), this.clock)
        .create(memory, { actor: parsed.actor }, 'memory_record via MCP');
      new FtsRetrievalProvider(database).upsert(saved, parsed.body);
      enqueueSemanticUpsert(database, saved.id, saved.contentHash);
      enqueueConsolidationScan(database);
      return {
        ok: true,
        data: { candidate_id: saved.id, status: saved.status, review_command: `taga review --memory=${saved.id}` },
        degraded: false,
        warnings: [],
        next_actions: [{ tool: 'memory_get', memory_id: saved.id }],
      };
    } finally {
      database.close();
    }
  }

  private async feedback(input: Record<string, unknown>): Promise<unknown> {
    const parsed = feedbackInputSchema.parse(input);
    const database = new DatabaseStore(join(this.brainPath, 'taga.db'));
    try {
      const projectId = resolveBoundProjectId(database, parsed.session_id, parsed.project_id);
      const repository = new MarkdownMemoryRepository(this.brainPath);
      const updated = await new GovernanceService(repository, new SqliteAuditLog(database), this.clock)
        .feedback(parsed.memory_id, parsed.kind, { actor: 'agent' }, parsed.note ?? 'feedback via MCP', {
          ...(projectId === undefined ? {} : { projectId }),
          ...(parsed.session_id === undefined ? {} : { sessionId: parsed.session_id }),
        });
      const body = await this.readMemoryFiles().then((records) => records.find((record) => record.memory.id === updated.id)?.body ?? updated.summary);
      if (updated.status === 'forgotten') {
        new FtsRetrievalProvider(database).remove(updated.id);
      } else {
        new FtsRetrievalProvider(database).upsert(updated, body);
      }
      enqueueSemanticUpsert(database, updated.id, updated.contentHash);
      enqueueConsolidationScan(database);
      if (parsed.kind === 'conflict') {
        enqueueLearnCorrection(database, {
          memoryId: parsed.memory_id,
          ...(parsed.note === undefined ? {} : { note: parsed.note }),
          ...(projectId === undefined ? {} : { project: projectId }),
        });
      }
      return { ok: true, data: { memory_id: updated.id, kind: parsed.kind, useful_count: updated.usefulCount, not_useful_count: updated.notUsefulCount }, degraded: false, warnings: [], next_actions: [] };
    } finally {
      database.close();
    }
  }

  private async readMemoryFiles(): Promise<MemoryFile[]> {
    const paths: string[] = [];
    await visit(this.brainPath, paths);
    const result: MemoryFile[] = [];
    for (const path of paths) {
      const parsed = parseMarkdownDocument(await readFile(path, 'utf8'));
      result.push({ memory: parseMemory(parsed.frontmatter), body: parsed.body });
    }
    return result;
  }

  private async injectionStatus(memory: Memory): Promise<'injected' | 'not_injected' | 'unknown'> {
    const registry = new AgentAdapterRegistry();
    const project = await resolveProjectContext({
      cwd: process.cwd(),
      markerFile: this.config.projectResolution.markerFile,
      preferGitRoot: this.config.projectResolution.preferGitRoot,
      preferGitRemote: this.config.projectResolution.preferGitRemote,
    });
    const targets = this.config.agents.enabled.flatMap((configuredId) => {
      const id = configuredId === 'claude' ? 'claude-code' : configuredId;
      return registry.get(id)?.staticTargets(project.root)
        ?? [join(project.root, id === 'claude-code' ? 'CLAUDE.md' : 'AGENTS.md')];
    });
    if (targets.length === 0) return 'unknown';
    for (const target of targets) {
      try {
        const content = await readFile(target, 'utf8');
        if (content.includes(markerBegin) && content.includes(markerEnd) && content.includes(memory.title)) return 'injected';
      } catch {
        continue;
      }
    }
    return 'not_injected';
  }
}

export function toolList(): readonly McpTool[] {
  return tools;
}

function parseScope(value: string, type: Memory['type'], projectId?: string): Memory['scope'] {
  if (value === 'auto') {
    if (type === 'preferences') return { kind: 'global' };
    if (projectId !== undefined) return { kind: 'project', id: projectId };
    if (type === 'projects') throw new Error('project memory requires a project session or explicit project scope');
    return { kind: 'global' };
  }
  if (value === 'project') {
    if (projectId === undefined) throw new Error('project scope requires a project session or explicit project_id');
    return { kind: 'project', id: projectId };
  }
  if (value === 'global') return { kind: 'global' };
  const separator = value.indexOf(':');
  if (separator < 1 || separator === value.length - 1) throw new Error('scope must be auto, global, project, domain:<id>, or project:<id>');
  const kind = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (kind !== 'domain' && kind !== 'project') throw new Error('scope must be auto, global, project, domain:<id>, or project:<id>');
  return { kind, id };
}

function resolveBoundProjectId(database: DatabaseStore, sessionId?: string, explicitProjectId?: string): string | undefined {
  if (sessionId === undefined) return explicitProjectId;
  const session = database.getSessionContext(sessionId);
  if (session === null) throw new Error(`unknown session_id: ${sessionId}`);
  if (explicitProjectId !== undefined && explicitProjectId !== session.projectId) throw new Error('explicit project_id conflicts with session project');
  return session.projectId;
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

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function versionIds(records: readonly MemoryFile[], memoryId: string): string[] {
  const ids = new Set<string>([memoryId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      if (typeof record.memory.supersedes === 'string' && ids.has(record.memory.supersedes) && !ids.has(record.memory.id)) {
        ids.add(record.memory.id);
        changed = true;
      }
      if (ids.has(record.memory.id) && typeof record.memory.supersedes === 'string' && !ids.has(record.memory.supersedes)) {
        ids.add(record.memory.supersedes);
        changed = true;
      }
    }
  }
  return [...ids];
}

function freshnessFor(updatedAt: string, now: Date): 'fresh' | 'aging' | 'stale' {
  const ageDays = Math.max(0, now.getTime() - Date.parse(updatedAt)) / 86_400_000;
  if (ageDays <= 30) return 'fresh';
  if (ageDays <= 180) return 'aging';
  return 'stale';
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'request failed';
}
