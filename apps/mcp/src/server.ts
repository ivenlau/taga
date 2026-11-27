import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z, ZodError } from 'zod';
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
import { ContextPackBuilder, summarizePack } from '../../../packages/context/src/index.js';
import { BrainBrowser } from '../../../packages/browsing/src/index.js';
import {
  FtsRetrievalProvider,
  type HybridRecallCandidate,
  type HybridRetrievalResult,
  type RecallCandidate,
  type RetrievalResult,
  type SemanticRetriever,
} from '../../../packages/retrieval/src/index.js';
import { createRpcEmbedder, type Embedder } from '../../../packages/embedding/src/index.js';
import { enqueueSemanticUpsert, ZvecMemoryIndex, ZvecSemanticRetriever } from '../../../packages/semantic-index/src/index.js';
import { observationKindSchema, parseMemory, type Memory } from '../../../packages/domain/src/index.js';
import { NotificationService } from '../../../packages/notifications/src/index.js';
import { MemoryPrecheckService } from '../../../packages/precheck/src/index.js';
import { selectContextCandidates, SessionContextService, observationContentHash } from '../../../packages/session/src/index.js';
import { DomainPackService } from '../../../packages/domain-packs/src/index.js';
import { AgentAdapterRegistry } from '../../../packages/adapters/src/index.js';
import { createDefaultConfig, type FeatureMode, type ResolvedConfig } from '../../../packages/config/src/index.js';
import { resolveProjectContext, type ProjectContext } from '../../../packages/project-context/src/index.js';
import { daemonStatus } from '../../daemon/src/lifecycle.js';

const sessionHint = 'Session id from memory_session_start; scopes the call to its project.';
const projectHint = "Explicit project id; must match the session's project.";
const sourceRefShape = {
  kind: z.enum(['file', 'line', 'symbol', 'url', 'commit', 'test', 'tool_call']).describe('Reference kind.'),
  locator: z.string().min(1).describe('Path, line path, symbol, URL, commit, test name, or tool call.'),
  label: z.string().min(1).optional().describe('Optional display name.'),
  hash: z.string().min(1).optional().describe('Optional content hash.'),
};

const searchInputSchema = z.object({
  query: z.string().min(1).describe('What to find. Lexical retrieval: space-separated keywords plus exact identifiers. Hybrid retrieval: one natural-language sentence.'),
  alternates: z.array(z.string().min(1).max(200)).max(6).optional().describe('Up to 6 other wordings (synonyms or translations). They feed the lexical branch only.'),
  session_id: z.string().min(1).optional().describe(sessionHint),
  project_id: z.string().min(1).optional().describe(projectHint),
  type: z.array(z.enum(['preferences', 'environment', 'procedures', 'lessons', 'projects'])).optional().describe('Only return these memory types.'),
  k: z.number().int().positive().max(100).optional().describe('Maximum number of results (default 5).'),
  include_draft: z.boolean().default(false).describe('Also search draft memories. They are unverified, down-ranked, and marked status:draft:unverified.'),
  semantic_mode: z.enum(['off', 'shadow', 'on']).optional().describe("Override the configured retrieval mode for this call: 'off' lexical only, 'shadow' lexical results with semantic retrieval observed, 'on' hybrid."),
});

const timelineInputSchema = z.object({
  memory_id: z.string().min(1).describe('Memory id from search results or a Context Pack entry.'),
  session_id: z.string().min(1).optional().describe('Only include observations from this session.'),
  task_id: z.string().min(1).optional().describe('Only include observations from this task.'),
  include_observations: z.boolean().default(true).describe('Include session observations linked to this memory (default true).'),
  include_body: z.boolean().default(false).describe('Include observation bodies (default false; summaries only).'),
  limit: z.number().int().positive().max(200).optional().describe('Maximum number of observations.'),
});

const sessionStartInputSchema = z.object({
  agent_id: z.string().min(1).default('local').describe('Identifier of the calling agent, for example claude-code or codex.'),
  session_id: z.string().min(1).describe('Id for this session: any stable unique string, for example <date>-<project>-<suffix>. Reuse it in later calls.'),
  project_id: z.string().min(1).optional().describe('Explicit project id. Normally omitted so the project is resolved from cwd.'),
  project_root: z.string().min(1).optional().describe('Explicit project root directory. Normally omitted so the project is resolved from cwd.'),
  cwd: z.string().min(1).optional().describe('Current working directory of the agent, used to resolve the project. Defaults to the server process directory.'),
  task: z.string().min(1).optional().describe('One sentence on what the user wants to do. It is the retrieval query; without it memories are selected without relevance ranking.'),
  token_budget: z.number().int().positive().max(10_000).optional().describe('Context Pack budget in tokens (default 1300).'),
  refresh: z.boolean().default(false).describe('Rebuild the pack instead of reusing a cached one (default false).'),
  target_path: z.string().min(1).optional().describe('File to write the pack into when inject is true. It must already contain the taga:begin/end managed markers.'),
  inject: z.boolean().default(false).describe('Also write the pack into target_path (default false). Rarely needed: the pack is returned to the agent anyway.'),
});

const sessionObservationInputSchema = z.object({
  session_id: z.string().min(1).describe(sessionHint),
  task_id: z.string().min(1).optional().describe('Task label used to group observations.'),
  project_id: z.string().min(1).optional().describe(projectHint),
  occurred_at: z.string().describe('ISO 8601 timestamp of the observation; defaults to now.')
    .refine((value) => !Number.isNaN(Date.parse(value)), 'occurred_at must be an ISO 8601 timestamp').optional(),
  sequence: z.number().int().nonnegative().describe('Order of the observation within the session, starting at 0.'),
  kind: observationKindSchema.describe('problem: something went wrong; decision: a choice was made; procedure: verified steps; preference: user preference; environment: environment fact; exploration: context worth keeping as history.'),
  summary: z.string().min(1).describe('One or two redacted sentences describing what happened.'),
  body: z.string().max(20_000).optional().describe('Optional redacted details (up to 20000 characters).'),
  memory_ids: z.array(z.string().min(1)).default([]).describe('Memory ids this observation relates to.'),
  source_refs: z.array(z.string().min(1)).default([]).describe('Files, symbols, or commands this observation came from.'),
  visibility: z.enum(['normal', 'redacted', 'excluded']).default('normal').describe("normal: nothing sensitive; redacted: sensitive content was removed; excluded: must not be recalled."),
});

const getInputSchema = z.object({
  memory_id: z.string().min(1).describe('Memory id from search results or a Context Pack entry.'),
  include_body: z.boolean().default(false).describe('Include the full body (default false: metadata and summary only).'),
  include_evidence: z.boolean().default(false).describe('Also return the source references under evidence.'),
  include_audit: z.boolean().default(false).describe('Include the audit trail of the memory.'),
  include_versions: z.boolean().default(false).describe('Include the ids of earlier and later versions of the memory.'),
});

const recordInputSchema = z.object({
  type: z.enum(['preferences', 'environment', 'procedures', 'lessons', 'projects'])
    .describe('preferences: user preferences and habits; environment: environment and configuration facts; procedures: verified step-by-step procedures; lessons: pitfalls, root causes, and fixes (the usual choice); projects: project decisions and goals.'),
  scope: z.string().min(1).default('auto').describe("'auto' (default): preferences are global and other types belong to the bound project; or 'global', 'project', 'domain:<id>', 'project:<id>'."),
  session_id: z.string().min(1).optional().describe(sessionHint),
  project_id: z.string().min(1).nullable().optional().describe(projectHint),
  title: z.string().min(1).describe('One self-contained sentence stating the fact. Search matches it with the highest weight.'),
  body: z.string().min(1).describe('The fact itself with concrete identifiers (commands, error codes, paths) and when it applies.'),
  tags: z.array(z.string().min(1)).default([]).describe('Lowercase keywords. They double as search aliases.'),
  sources: z.array(z.object(sourceRefShape)).min(1).describe('At least one reference showing where the fact comes from.'),
  anchors: z.array(z.object(sourceRefShape)).default([]).describe('File, line, symbol, or commit references that memory_precheck matches against the target being edited. Add them for memories tied to specific code.'),
  requested_status: z.enum(['candidate', 'draft', 'active']).default('draft').describe("'draft' (default) for agent-authored memories awaiting review; 'candidate' for raw unreviewed material. 'active' is not available here and is recorded as draft."),
  actor: z.enum(['user', 'agent']).default('agent').describe("'agent' (default). Use 'user' only when the user explicitly dictated the fact."),
});

const feedbackInputSchema = z.object({
  memory_id: z.string().min(1).describe('Memory id from search results or a Context Pack entry.'),
  kind: z.enum(['useful', 'not_useful', 'verified', 'conflict', 'cite', 'outcome'])
    .describe('useful: it helped; not_useful: it was irrelevant; conflict: it is wrong or outdated; verified: it is still correct; cite: it was referenced; outcome: acting on it produced a result.'),
  note: z.string().max(1000).optional().describe('Up to 1000 characters on what was wrong, what is correct instead, or what was confirmed.'),
  project_id: z.string().min(1).optional().describe(projectHint),
  session_id: z.string().min(1).optional().describe(sessionHint),
});

const contextTraceInputSchema = z.object({
  agent_id: z.string().min(1).default('local').describe('Identifier of the calling agent.'),
  session_id: z.string().min(1).optional().describe(sessionHint),
  project_id: z.string().min(1).optional().describe(projectHint),
  task: z.string().min(1).optional().describe('The task sentence to evaluate, as it would be passed to memory_session_start.'),
});

const precheckInputSchema = z.object({
  file: z.string().min(1).optional().describe('Path of the file about to be edited: absolute, or relative to the agent working directory.'),
  line: z.number().int().positive().optional().describe('Line about to be edited.'),
  symbol: z.string().min(1).optional().describe('Function, class, or other symbol about to be edited.'),
  commit: z.string().min(1).optional().describe('Commit about to be made or inspected.'),
  task: z.string().min(1).optional().describe('What you intend to change; used for keyword matching.'),
  session_id: z.string().min(1).optional().describe(sessionHint),
  project_id: z.string().min(1).optional().describe(projectHint),
  agent_id: z.string().min(1).optional().describe('Identifier of the calling agent.'),
  allow_reminder: z.boolean().default(false).describe('Let Taga notify the user when a strongly related memory is found (default false).'),
  timeout_ms: z.number().int().positive().max(10_000).optional().describe('Give up after this many milliseconds and continue (default 1500).'),
}).describe('Requires file, symbol, or commit.').refine((value) => value.file !== undefined || value.symbol !== undefined || value.commit !== undefined, 'file, symbol, or commit is required');

const brainListInputSchema = z.object({
  type: z.enum(['preferences', 'environment', 'procedures', 'lessons', 'projects']).optional().describe('Only these memory types.'),
  status: z.enum(['candidate', 'draft', 'active', 'stale', 'superseded', 'forgotten']).optional().describe('Only memories in this status, for example draft to review the backlog.'),
  project_id: z.string().min(1).optional().describe('Only memories of this project.'),
  scope: z.enum(['global', 'domain', 'project']).optional().describe('Only memories of this scope kind.'),
  offset: z.number().int().nonnegative().optional().describe('Number of memories to skip (default 0).'),
  limit: z.number().int().positive().max(200).optional().describe('Maximum number of memories to return (up to 200).'),
});

const brainDetailInputSchema = z.object({
  memory_id: z.string().min(1).describe('Memory id from search results or a Context Pack entry.'),
  include_body: z.boolean().default(false).describe('Include the full body (default false).'),
  include_evidence: z.boolean().default(false).describe('Expand the evidence references (default false).'),
});

const knowledgeIngestInputSchema = z.object({
  content: z.string().min(1).max(200_000).describe('The text to distill: plain text or Markdown, up to 200000 characters.'),
  type: z.enum(['preferences', 'environment', 'procedures', 'lessons', 'projects']).optional().describe('Hint for the memory type of the resulting candidates.'),
  project: z.string().min(1).optional().describe('Project name or id to associate with the resulting candidates.'),
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
  readonly title: string;
  readonly annotations: ToolAnnotations;
}

export interface ToolAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

export interface McpResponse {
  readonly jsonrpc: '2.0';
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

interface McpToolResult {
  readonly content: Array<{ type: 'text'; text: string }>;
  readonly structuredContent: unknown;
  readonly isError?: boolean;
}

/** Failure of one tool call; `hint` tells the agent how to recover. */
class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

interface MemoryFile {
  readonly memory: Memory;
  readonly body: string;
}

// MCP defaults every annotation to "unknown" (and destructiveHint to true), so only the hints that matter are sent.
const READ_ONLY: ToolAnnotations = { readOnlyHint: true };
const APPEND_ONLY: ToolAnnotations = { destructiveHint: false };
const STATEFUL: ToolAnnotations = { destructiveHint: false, idempotentHint: true };

const DEFAULT_SEARCH_RESULTS = 5;
const MAX_SEARCH_RESULTS = 100;
// Search results carry the start of the body, so reading a hit usually needs no second call.
const SEARCH_BODY_MAX_CHARS = 600;
const NO_PROJECT_CONTEXT = 'no project context: only global and domain memories were searched; call memory_session_start or pass project_id to include project memories';

const tools: readonly McpTool[] = [
  { name: 'memory_search', version: 'v1', title: 'Search memories', annotations: READ_ONLY, description: 'Search active memories and return the id, title, and start of each matching body. Use it before solving a problem that earlier lessons, procedures, environment facts, or decisions could inform. match_reason explains why each result matched. candidate and draft memories are skipped unless include_draft=true. Zero results means nothing matched this wording, not that nothing was recorded: retry with other keywords or alternates before concluding.' },
  { name: 'memory_timeline', version: 'v1', title: 'Read memory timeline', annotations: READ_ONLY, description: 'Read the audit history of one memory (created, recalled, opened, feedback, status changes) plus optional session observations. Use it to see how a memory was produced or how often it was used. It does not return the memory body: use memory_get.' },
  { name: 'memory_session_start', version: 'v1', title: 'Start session with context pack', annotations: STATEFUL, description: 'Call once at the start of a task, before other taga tools. It binds session_id to the project resolved from cwd and returns a bounded Context Pack: the active memories relevant to task, each with a [memory_id: ...] reference, plus decisions explaining what was excluded. Later calls that pass the same session_id inherit the project binding.' },
  { name: 'memory_session_observation', version: 'v1', title: 'Record session observation', annotations: APPEND_ONLY, description: 'Append a short, redacted observation to the session timeline (a problem, decision, procedure, preference, environment fact, or exploration). Use it for context worth keeping as history that does not deserve a memory_record. Never include secrets.' },
  { name: 'memory_get', version: 'v1', title: 'Read memory', annotations: READ_ONLY, description: "Read one memory's metadata: type, scope, status, title, summary, confidence, source_trust, tags, and sources. The body is only returned with include_body=true; use it when a search result or Context Pack entry was cut short." },
  { name: 'memory_record', version: 'v1', title: 'Record memory', annotations: APPEND_ONLY, description: 'Save one reusable fact as a draft memory for review: a lesson (pitfall, root cause, fix), procedure, environment fact, project decision, or user preference. Do not record one-off details, intermediate steps, guesses, or secrets. Check memory_search first: if a close memory exists, give memory_feedback (kind conflict or not_useful) instead of duplicating it. Use knowledge_ingest for long user-provided documents. New memories are drafts: they are recalled only after `taga review` or consolidation activates them.' },
  { name: 'memory_feedback', version: 'v1', title: 'Give memory feedback', annotations: APPEND_ONLY, description: 'Report how a memory worked out, by memory_id: useful (it helped), not_useful (irrelevant), conflict (wrong or outdated; say what is correct in note), verified (still correct), cite (referenced), or outcome (acting on it produced a result). Feedback adjusts confidence and drives promotion and staleness. Give it at the end of a task for the memories that mattered.' },
  { name: 'context_trace', version: 'v1', title: 'Trace context selection', annotations: READ_ONLY, description: 'Explain which memories a Context Pack would include, exclude, or truncate for a task, using the same selection as memory_session_start, and why. Use it when recall looks wrong.' },
  { name: 'memory_precheck', version: 'v1', title: 'Precheck before editing', annotations: APPEND_ONLY, description: 'Check for memories anchored to the file, symbol, or commit you are about to edit, before editing. Results carry anchor_state: valid means the memory references the file or symbol you named. Read valid items first; the others are ranked by keyword overlap and may be unrelated. Nothing is executed.' },
  { name: 'brain_tree', version: 'v1', title: 'Browse Brain files', annotations: READ_ONLY, description: 'List the canonical Markdown files of the Brain. Browsing aid; not needed for normal recall.' },
  { name: 'brain_list', version: 'v1', title: 'List memories', annotations: READ_ONLY, description: 'List memory metadata with filters (type, status, project_id, scope) and pagination. Use it to review what exists, for example status=draft. To search by meaning, use memory_search.' },
  { name: 'brain_summary', version: 'v1', title: 'Summarize Brain', annotations: READ_ONLY, description: 'Count memories by type and status. Use it for a quick overview of the Brain.' },
  { name: 'brain_detail', version: 'v1', title: 'Read memory relations', annotations: READ_ONLY, description: 'Read one memory together with its file path, related memories, evidence references, and audit trail. Heavier than memory_get; use it when relations or evidence are needed.' },
  { name: 'brain_rebuild', version: 'v1', title: 'Rebuild Brain relations', annotations: STATEFUL, description: 'Rebuild the derived Brain relations from the canonical Markdown. Maintenance operation: call only when relations look out of date, never as part of normal recall.' },
  { name: 'knowledge_ingest', version: 'v1', title: 'Ingest knowledge text', annotations: STATEFUL, description: 'Queue a longer text (document, article, pasted notes) for background distillation into reviewable candidate memories. Returns immediately; candidates appear once the taga daemon has processed the job and still need `taga review`. Use memory_record for a single fact. Never submit secrets.' },
];

// Tool descriptions follow the retrieval mode actually in effect, so the agent queries the way the engine expects.
const retrievalGuidance: Readonly<Record<FeatureMode, string>> = {
  off: 'Retrieval is lexical only (FTS5): whole words and prefixes match, and Chinese text is not word-segmented. Query with space-separated keywords and exact identifiers (commands, error codes, paths), plus alternates for synonyms or translations.',
  shadow: 'Retrieval is lexical (FTS5) and semantic retrieval is only observed: whole words and prefixes match, and Chinese text is not word-segmented. Query with space-separated keywords and exact identifiers (commands, error codes, paths), plus alternates for synonyms or translations.',
  on: 'Hybrid retrieval is enabled (local BGE-M3 embeddings fused with FTS5): describe what you need in one natural-language sentence. Exact identifiers and alternates still improve the lexical branch. If warnings report degraded semantic retrieval, fall back to keywords.',
};
const taskGuidance: Readonly<Record<FeatureMode, string>> = {
  off: 'task is matched lexically, so name the keywords and identifiers the memories use.',
  shadow: 'task is matched lexically, so name the keywords and identifiers the memories use.',
  on: 'task is matched by meaning and keywords, so a full sentence describing the goal works best.',
};

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
  readonly title: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly annotations: ToolAnnotations;
}

function mcpTools(mode: FeatureMode): readonly McpToolDefinition[] {
  return tools.map((tool) => {
    const schema = toolInputSchemas[tool.name];
    const guidance = tool.name === 'memory_search' ? retrievalGuidance[mode] : tool.name === 'memory_session_start' ? taskGuidance[mode] : undefined;
    return {
      name: tool.name,
      title: tool.title,
      description: guidance === undefined ? tool.description : `${tool.description} ${guidance}`,
      inputSchema: schema === undefined ? { type: 'object', properties: {} } : z.toJSONSchema(schema, { io: 'input' }),
      annotations: tool.annotations,
    };
  });
}

function toolCallResult(payload: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
}

/** Tool failures travel as isError results, so the agent reads the cause and the way to recover instead of a protocol error. */
function toolFailureResult(error: unknown): McpToolResult {
  const failure = error instanceof ToolError
    ? error
    : error instanceof ZodError
      ? new ToolError('INVALID_ARGUMENTS', `invalid arguments: ${error.issues.map((issue) => issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)
      : new ToolError('TOOL_FAILED', safeErrorMessage(error));
  return {
    isError: true,
    ...toolCallResult({
      ok: false,
      error: { code: failure.code, message: failure.message, ...(failure.hint === undefined ? {} : { hint: failure.hint }) },
      next_actions: [],
    }),
  };
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
      return { jsonrpc: '2.0', id: base.data.id, result: { tools: mcpTools(this.config.retrieval.semantic.mode) } };
    }
    const call = toolCallSchema.safeParse(input);
    if (!call.success) {
      return { jsonrpc: '2.0', id: base.data.id, error: { code: -32601, message: 'unsupported method' } };
    }
    if (!tools.some((tool) => tool.name === call.data.params.name)) {
      return { jsonrpc: '2.0', id: call.data.id, error: { code: -32602, message: `unknown tool: ${call.data.params.name}` } };
    }
    const result = await this.runTool(call.data.params.name, call.data.params.arguments);
    return { jsonrpc: '2.0', id: call.data.id, result };
  }

  private async runTool(name: string, input: Record<string, unknown>): Promise<McpToolResult> {
    try {
      return toolCallResult(await this.callTool(name, input));
    } catch (error) {
      return toolFailureResult(error);
    }
  }

  private openDatabase(): DatabaseStore {
    try {
      // The daemon writes continuously (ingestion, distillation); a longer busy timeout lets
      // a tool call wait out contention instead of failing the agent's request.
      return new DatabaseStore(join(this.brainPath, 'taga.db'), { busyTimeoutMs: 15_000 });
    } catch (error) {
      throw new ToolError(
        'BRAIN_UNAVAILABLE',
        `cannot open the Brain database under ${this.brainPath}: ${safeErrorMessage(error)}`,
        'Initialize the Brain first with `taga init --brain=<path>` (check with `taga doctor`), then retry.',
      );
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
        throw new ToolError('UNKNOWN_TOOL', `unknown tool: ${name}`);
    }
  }

  private async knowledgeIngest(input: Record<string, unknown>): Promise<unknown> {
    const parsed = knowledgeIngestInputSchema.parse(input);
    const database = this.openDatabase();
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
      // Only the daemon distills queued jobs, so an idle daemon means nothing will come out of this call yet.
      const running = (await daemonStatus(this.brainPath)).running;
      return {
        ok: true,
        data: {
          queued,
          job_id: jobId,
          status_hint: !running
            ? 'queued, but the taga daemon is not running: nothing is distilled until it starts'
            : queued ? 'queued: the daemon will distill this into reviewable candidate memories' : 'this content is already queued',
        },
        degraded: false,
        warnings: running ? [] : ['taga daemon is not running; run `taga daemon start` so queued jobs are processed'],
        next_actions: [],
      };
    } finally {
      database.close();
    }
  }

  private async brainTree(): Promise<unknown> {
    const database = this.openDatabase();
    try {
      return { ok: true, data: await new BrainBrowser(this.brainPath, database).tree(), degraded: false, warnings: [], next_actions: [] };
    } finally {
      database.close();
    }
  }

  private async brainList(input: Record<string, unknown>): Promise<unknown> {
    const parsed = brainListInputSchema.parse(input);
    const database = this.openDatabase();
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
    const database = this.openDatabase();
    try {
      return { ok: true, data: await new BrainBrowser(this.brainPath, database).summary(), degraded: false, warnings: [], next_actions: [] };
    } finally {
      database.close();
    }
  }

  private async brainDetail(input: Record<string, unknown>): Promise<unknown> {
    const parsed = brainDetailInputSchema.parse(input);
    const database = this.openDatabase();
    try {
      const detail = await new BrainBrowser(this.brainPath, database).detail(parsed.memory_id, { includeBody: parsed.include_body, includeEvidence: parsed.include_evidence });
      if (detail === null) throw memoryNotFound(parsed.memory_id);
      return { ok: true, data: detail, degraded: false, warnings: [], next_actions: [] };
    } finally {
      database.close();
    }
  }

  private async brainRebuild(): Promise<unknown> {
    const database = this.openDatabase();
    try {
      return { ok: true, data: await new BrainBrowser(this.brainPath, database).rebuildRelations(), degraded: false, warnings: [], next_actions: [] };
    } finally {
      database.close();
    }
  }

  private async search(input: Record<string, unknown>): Promise<unknown> {
    const parsed = searchInputSchema.parse(input);
    const database = this.openDatabase();
    try {
      const projectId = resolveBoundProjectId(database, parsed.session_id, parsed.project_id);
      const provider = new FtsRetrievalProvider(database);
      const catalog = new Map((await this.readMemoryFiles()).map((item) => [item.memory.id, item.memory]));
      const mode = parsed.semantic_mode ?? this.config.retrieval.semantic.mode;
      const requested = parsed.k ?? DEFAULT_SEARCH_RESULTS;
      const searchInput = {
        query: parsed.query,
        ...(parsed.alternates === undefined ? {} : { alternates: parsed.alternates }),
        ...(projectId === undefined ? {} : { scope: { kind: 'project' as const, id: projectId } }),
        ...(parsed.include_draft === true ? { includeDraft: true } : {}),
        // A type filter is applied after retrieval, so a wider pool is needed to fill the requested count.
        limit: parsed.type === undefined ? requested : Math.min(MAX_SEARCH_RESULTS, requested * 4),
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
          const catalogMemory = catalog.get(item.memory.id);
          return catalogMemory !== undefined && parsed.type?.includes(catalogMemory.type) === true;
        });
      const now = this.clock();
      const results = filtered.slice(0, requested).map((item) => searchResult(item, catalog, now));
      const audit = new SqliteAuditLog(database);
      if (shadowObservation !== undefined) {
        await audit.append({
          eventType: 'memory.semantic_shadow',
          actor: 'agent',
          subjectType: 'search',
          subjectId: queryId,
          occurredAt: now.toISOString(),
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
          occurredAt: now.toISOString(),
          reason: 'memory_search via MCP',
          payload: { query: parsed.query, queryId },
        });
      }
      // Semantic retrieval only shaped these results when it was requested and did not fail.
      const hybrid = mode === 'on' && !retrieval.degraded;
      const warnings = retrieval.degraded
        ? [mode === 'off' ? 'FTS unavailable; run taga reindex --apply' : 'semantic retrieval degraded; FTS5 results returned']
        : [];
      // An unbound search silently drops project memories; say so whenever that could explain an empty result.
      if (projectId === undefined && results.length === 0) warnings.push(NO_PROJECT_CONTEXT);
      return {
        ok: true,
        data: {
          query_id: queryId,
          scope: projectId === undefined ? 'global, domain' : `project:${projectId}, global, domain`,
          retrieval: hybrid ? 'hybrid (semantic + FTS5)' : 'lexical (FTS5)',
          results,
          ...(results.length === 0 ? { hint: zeroResultHint(hybrid) } : {}),
        },
        degraded: retrieval.degraded,
        warnings,
        // Only results whose body was cut short need a follow-up.
        next_actions: [...new Set(results.filter((result) => result.body_truncated === true).map((result) => result.id))]
          .slice(0, 3)
          .map((memory_id) => ({ tool: 'memory_get', memory_id, include_body: true })),
      };
    } finally {
      database.close();
    }
  }

  private semanticRetriever(database: DatabaseStore): SemanticRetriever {
    this.semanticIndex ??= new ZvecMemoryIndex(join(this.brainPath, '.taga', 'semantic'));
    this.semanticEmbedder ??= createRpcEmbedder(this.brainPath);
    return new ZvecSemanticRetriever({
      database,
      index: this.semanticIndex,
      embedder: this.semanticEmbedder,
    });
  }

  private trySemanticRetriever(database: DatabaseStore): SemanticRetriever | undefined {
    if (this.config.retrieval.semantic.mode === 'off') return undefined;
    try {
      return this.semanticRetriever(database);
    } catch {
      return undefined;
    }
  }

  private async timeline(input: Record<string, unknown>): Promise<unknown> {
    const parsed = timelineInputSchema.parse(input);
    const database = this.openDatabase();
    try {
      const memory = (await this.readMemoryFiles()).find((item) => item.memory.id === parsed.memory_id);
      if (memory === undefined) throw memoryNotFound(parsed.memory_id);
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
    const database = this.openDatabase();
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
        channel: parsed.inject ? 'static' : 'mcp',
        domainContributions: new DomainPackService(database).contextContributions(),
      }, await this.readMemoryFiles(), this.trySemanticRetriever(database));
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
          stats: summarizePack(result.pack),
        },
      });
      // Semantic retrieval was configured but could not take part in the selection.
      const semanticUnavailable = this.config.retrieval.semantic.mode === 'on' && result.degraded;
      const warnings = [
        ...(result.stale ? ['cached context pack is older than six hours; rerun with refresh=true'] : []),
        ...(semanticUnavailable ? ['semantic retrieval unavailable; the context pack was selected by lexical search only'] : []),
      ];
      // An entry that did not fit the budget comes back in full when the same task is searched.
      const task = parsed.task;
      const truncated = task !== undefined && result.pack.decisions.some((decision) => decision.decision === 'truncated');
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
          // Sections repeat what `content` already renders, so only their memory ids travel back.
          sections: result.pack.sections.map((section) => ({ kind: section.kind, title: section.title, memory_ids: section.memoryIds, token_estimate: section.tokenEstimate })),
          decisions: result.pack.decisions,
          token_estimate: result.pack.tokenEstimate,
          source: result.source,
          stale: result.stale,
          cache_key: result.cacheKey,
          ...(injectedPath === undefined ? {} : { injected_path: injectedPath }),
        },
        degraded: result.pack.degraded || semanticUnavailable,
        warnings,
        next_actions: truncated && task !== undefined ? [{ tool: 'memory_search', query: task }] : [],
      };
    } finally {
      database.close();
    }
  }

  private sessionObservation(input: Record<string, unknown>): unknown {
    const parsed = sessionObservationInputSchema.parse(input);
    const database = this.openDatabase();
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
    if (memory === undefined) throw memoryNotFound(parsed.memory_id);
    const database = this.openDatabase();
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
    const database = this.openDatabase();
    try {
      const projectId = resolveBoundProjectId(database, parsed.session_id, parsed.project_id);
      const selection = await selectContextCandidates(database, {
        ...(parsed.task === undefined ? {} : { task: parsed.task }),
        ...(projectId === undefined ? {} : { projectId }),
      }, records, this.trySemanticRetriever(database));
      const pack = new ContextPackBuilder().build({
        agentId: parsed.agent_id,
        ...(projectId === undefined ? {} : { projectId }),
        ...(parsed.task === undefined ? {} : { task: parsed.task }),
        channel: 'mcp',
        candidates: selection.candidates,
        domainContributions: new DomainPackService(database).contextContributions(),
      });
      return { ok: true, data: new ContextPackBuilder().trace(pack), degraded: false, warnings: [], next_actions: [] };
    } finally {
      database.close();
    }
  }

  private async precheck(input: Record<string, unknown>): Promise<unknown> {
    const parsed = precheckInputSchema.parse(input);
    const database = this.openDatabase();
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
      return {
        ok: true,
        data: {
          ...result,
          hint: 'Read items with anchor_state "valid" first: they reference the file or symbol you named. The other items are ranked by keyword overlap and may be unrelated.',
        },
        degraded: result.degraded,
        warnings: result.diagnostics,
        next_actions: result.items.filter((item) => item.anchorState === 'valid').slice(0, 3).map((item) => ({ tool: 'memory_get', memory_id: item.memoryId, include_body: true })),
      };
    } finally {
      database.close();
    }
  }

  private async record(input: Record<string, unknown>): Promise<unknown> {
    const parsed = recordInputSchema.parse(input);
    const database = this.openDatabase();
    try {
      const projectId = resolveBoundProjectId(database, parsed.session_id, parsed.project_id ?? undefined);
      const scope = parseScope(parsed.scope, parsed.type, projectId);
      if (scope.kind === 'project' && projectId !== undefined && scope.id !== projectId) {
        throw new ToolError('CONFLICT', 'explicit project scope conflicts with session project', "Use scope 'auto', or record without session_id and pass the matching project_id.");
      }
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
        data: {
          memory_id: saved.id,
          candidate_id: saved.id,
          status: saved.status,
          review_command: `taga review --memory=${saved.id}`,
          hint: `recorded as ${saved.status}: it is recalled only after \`taga review\` (or consolidation) activates it`,
        },
        degraded: false,
        warnings: parsed.requested_status === 'active' ? ["'active' is not available through memory_record; recorded as draft for review"] : [],
        next_actions: [],
      };
    } finally {
      database.close();
    }
  }

  private async feedback(input: Record<string, unknown>): Promise<unknown> {
    const parsed = feedbackInputSchema.parse(input);
    const database = this.openDatabase();
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
      const pending = updated.status === 'draft' || updated.status === 'candidate';
      return {
        ok: true,
        data: {
          memory_id: updated.id,
          kind: parsed.kind,
          status: updated.status,
          confidence: updated.confidence,
          useful_count: updated.usefulCount,
          not_useful_count: updated.notUsefulCount,
          ...(pending ? { hint: 'this memory is not recalled yet: it becomes recallable after `taga review` activates it' } : {}),
        },
        degraded: false,
        warnings: [],
        next_actions: [],
      };
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
  const bindProjectHint = "Call memory_session_start first and pass its session_id, or pass the matching project_id with scope 'project:<id>'.";
  if (value === 'auto') {
    if (type === 'preferences') return { kind: 'global' };
    if (projectId !== undefined) return { kind: 'project', id: projectId };
    if (type === 'projects') throw new ToolError('PROJECT_REQUIRED', 'project memory requires a project session or explicit project scope', bindProjectHint);
    return { kind: 'global' };
  }
  if (value === 'project') {
    if (projectId === undefined) throw new ToolError('PROJECT_REQUIRED', 'project scope requires a project session or explicit project_id', bindProjectHint);
    return { kind: 'project', id: projectId };
  }
  if (value === 'global') return { kind: 'global' };
  const separator = value.indexOf(':');
  const id = separator < 1 || separator === value.length - 1 ? '' : value.slice(separator + 1);
  const kind = separator < 1 ? '' : value.slice(0, separator);
  if ((kind !== 'domain' && kind !== 'project') || id.length === 0) {
    throw new ToolError('INVALID_ARGUMENTS', 'scope must be auto, global, project, domain:<id>, or project:<id>');
  }
  return { kind, id };
}

function resolveBoundProjectId(database: DatabaseStore, sessionId?: string, explicitProjectId?: string): string | undefined {
  if (sessionId === undefined) return explicitProjectId;
  const session = database.getSessionContext(sessionId);
  if (session === null) {
    throw new ToolError(
      'UNKNOWN_SESSION',
      `unknown session_id: ${sessionId}`,
      'Call memory_session_start with this session_id first; it registers the session and binds it to a project. Or omit session_id and pass project_id.',
    );
  }
  if (explicitProjectId !== undefined && explicitProjectId !== session.projectId) {
    throw new ToolError('CONFLICT', 'explicit project_id conflicts with session project', 'Pass only session_id, or start a session in the other project with memory_session_start.');
  }
  return session.projectId;
}

function memoryNotFound(memoryId: string): ToolError {
  return new ToolError('NOT_FOUND', `memory not found: ${memoryId}`, 'Use a memory_id from memory_search results or a Context Pack entry.');
}

interface SearchResult {
  readonly id: string;
  readonly type: Memory['type'];
  readonly scope: string;
  readonly status: string;
  readonly title: string;
  readonly summary?: string;
  readonly body: string;
  readonly body_truncated?: true;
  readonly score: number;
  readonly match_reason: readonly string[];
  readonly proof: {
    readonly useful_count: number;
    readonly not_useful_count: number;
    readonly verified_at?: string;
  };
  readonly freshness: 'fresh' | 'aging' | 'stale';
}

function searchResult(item: RecallCandidate | HybridRecallCandidate, catalog: ReadonlyMap<string, Memory>, now: Date): SearchResult {
  const body = clipBody(item.memory.body, SEARCH_BODY_MAX_CHARS);
  const summary = item.memory.summary.trim();
  return {
    id: item.memory.id,
    type: catalog.get(item.memory.id)?.type ?? 'lessons',
    scope: item.memory.scopeId === null ? item.memory.scopeKind : `${item.memory.scopeKind}:${item.memory.scopeId}`,
    status: item.memory.status,
    title: item.memory.title,
    // Agent-written memories use the start of their body as summary; repeat it only when it says something else.
    ...(summary.length === 0 || body.text.startsWith(summary) ? {} : { summary }),
    body: body.text,
    ...(body.truncated ? { body_truncated: true } : {}),
    score: item.score,
    match_reason: item.matchReason,
    proof: {
      useful_count: item.memory.usefulCount ?? 0,
      not_useful_count: item.memory.notUsefulCount ?? 0,
      ...(item.memory.lastVerified === undefined || item.memory.lastVerified === null ? {} : { verified_at: item.memory.lastVerified }),
    },
    freshness: freshnessFor(item.memory.updatedAt, now),
  };
}

function clipBody(text: string, maxChars: number): { readonly text: string; readonly truncated: boolean } {
  return text.length <= maxChars ? { text, truncated: false } : { text: `${text.slice(0, maxChars)}…`, truncated: true };
}

function zeroResultHint(hybrid: boolean): string {
  const retry = hybrid
    ? 'Nothing matched by meaning or keyword. Retry with a different wording or alternates.'
    : 'Nothing matched by keyword: FTS5 compares whole words and prefixes and does not segment Chinese. Retry with shorter space-separated keywords, exact identifiers (commands, error codes, paths), or alternates.';
  return `${retry} candidate and draft memories are not searched unless include_draft=true.`;
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
