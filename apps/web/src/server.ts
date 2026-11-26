import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GovernanceService, SqliteAuditLog, enqueueConsolidationScan, type LifecycleActor, type MemoryFeedbackKind } from '../../../packages/application/src/index.js';
import { BrainBrowser } from '../../../packages/browsing/src/index.js';
import { ContextPackBuilder, summarizePack } from '../../../packages/context/src/index.js';
import { parseCandidate, parseMemory, type Candidate, type Memory, type MemoryCommand, type MemoryStatus, type MemoryType, type Scope } from '../../../packages/domain/src/index.js';
import { DomainPackService } from '../../../packages/domain-packs/src/index.js';
import { createRpcEmbedder, type Embedder } from '../../../packages/embedding/src/index.js';
import { FtsRetrievalProvider, type SemanticRetriever } from '../../../packages/retrieval/src/index.js';
import { RecoveryService } from '../../../packages/recovery/src/index.js';
import { enqueueSemanticRebuild, enqueueSemanticUpsert, ZvecMemoryIndex, ZvecSemanticRetriever } from '../../../packages/semantic-index/src/index.js';
import { SessionContextService } from '../../../packages/session/src/index.js';
import {
  contentHash,
  DatabaseStore,
  instructionBlockBegin,
  instructionBlockEnd,
  MarkdownMemoryRepository,
  upsertManagedBlock,
} from '../../../packages/storage/src/index.js';
import { DEFAULT_THEME_ID, THEMES } from './themes.js';

export interface WebServerOptions {
  readonly brainPath: string;
  readonly now?: () => Date;
  readonly semanticMode?: 'off' | 'shadow' | 'on';
  readonly modelPath?: string;
  readonly llm?: {
    readonly mode?: string;
    readonly provider?: string;
    readonly endpoint?: string;
    readonly model?: string;
    readonly timeoutMs?: number;
    readonly dailyCap?: number;
    readonly apiKeySet?: boolean;
    readonly apiKey?: string;
  };
}

const WEB_ACTOR: LifecycleActor = { actor: 'user', actorId: 'web' };
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const SENSITIVE_RE = /(api[_-]?key|secret|token)\s*[:=]|sk-[A-Za-z0-9]{8,}/i;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

interface RouteContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly params: Readonly<Record<string, string>>;
  readonly body: unknown;
}

type RouteHandler = (context: RouteContext) => unknown;

interface Route {
  readonly method: string;
  readonly segments: readonly string[];
  readonly handler: RouteHandler;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

function publicDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', 'public'),
    join(here, '..', '..', '..', '..', 'apps', 'web', 'public'),
    join(here, '..', '..', '..', 'public'),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return candidates[candidates.length - 1]!;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function memoryType(value: unknown): MemoryType | undefined {
  return typeof value === 'string' && ['preferences', 'environment', 'procedures', 'lessons', 'projects'].includes(value)
    ? (value as MemoryType)
    : undefined;
}

function memoryStatus(value: unknown): MemoryStatus | undefined {
  return typeof value === 'string' && ['candidate', 'draft', 'active', 'stale', 'superseded', 'forgotten'].includes(value)
    ? (value as MemoryStatus)
    : undefined;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'request body too large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim().length === 0) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'request body must be valid JSON');
  }
}

function requireRecord(body: unknown): Record<string, unknown> {
  return isRecord(body) ? body : {};
}

export function createWebServer(options: WebServerOptions): { readonly server: Server; readonly databasePath: string } {
  const brainPath = resolve(options.brainPath);
  mkdirSync(brainPath, { recursive: true });
  const databasePath = join(brainPath, 'taga.db');
  const now = options.now ?? (() => new Date());
  const staticRoot = publicDir();

  const routes: Route[] = [
    { method: 'GET', segments: ['api', 'themes'], handler: () => ({ themes: THEMES, default: DEFAULT_THEME_ID }) },
    { method: 'GET', segments: ['api', 'overview'], handler: () => overview() },
    { method: 'GET', segments: ['api', 'memories'], handler: (ctx) => listMemories(ctx) },
    { method: 'POST', segments: ['api', 'memories'], handler: (ctx) => createMemory(ctx) },
    { method: 'GET', segments: ['api', 'memories', ':id'], handler: (ctx) => getMemory(ctx) },
    { method: 'PUT', segments: ['api', 'memories', ':id'], handler: (ctx) => editMemory(ctx) },
    { method: 'POST', segments: ['api', 'memories', ':id', 'transition'], handler: (ctx) => transitionMemory(ctx) },
    { method: 'POST', segments: ['api', 'memories', ':id', 'feedback'], handler: (ctx) => feedbackMemory(ctx) },
    { method: 'GET', segments: ['api', 'search'], handler: (ctx) => search(ctx) },
    { method: 'POST', segments: ['api', 'context', 'preview'], handler: (ctx) => contextPreview(ctx) },
    { method: 'POST', segments: ['api', 'context', 'inject'], handler: (ctx) => contextInject(ctx) },
    { method: 'POST', segments: ['api', 'knowledge', 'ingest'], handler: (ctx) => knowledgeIngest(ctx) },
    { method: 'GET', segments: ['api', 'sessions'], handler: () => sessions() },
    { method: 'GET', segments: ['api', 'packs'], handler: () => packs() },
    { method: 'POST', segments: ['api', 'packs', ':id', 'toggle'], handler: (ctx) => togglePack(ctx) },
    { method: 'GET', segments: ['api', 'audit'], handler: (ctx) => auditLog(ctx) },
    { method: 'GET', segments: ['api', 'garden'], handler: (ctx) => gardenList(ctx) },
    { method: 'POST', segments: ['api', 'garden', 'scan'], handler: () => gardenScan() },
    { method: 'POST', segments: ['api', 'garden', ':id', 'review'], handler: (ctx) => gardenReview(ctx) },
    { method: 'GET', segments: ['api', 'projects'], handler: () => projects() },
    { method: 'GET', segments: ['api', 'jobs'], handler: () => jobs() },
    { method: 'POST', segments: ['api', 'jobs', ':id', 'retry'], handler: (ctx) => retryJob(ctx) },
    { method: 'GET', segments: ['api', 'system'], handler: () => system() },
    { method: 'GET', segments: ['api', 'candidates'], handler: (ctx) => listCandidates(ctx) },
    { method: 'POST', segments: ['api', 'candidates'], handler: (ctx) => createCandidate(ctx) },
    { method: 'POST', segments: ['api', 'candidates', ':id', 'accept'], handler: (ctx) => acceptCandidate(ctx) },
    { method: 'POST', segments: ['api', 'candidates', ':id', 'reject'], handler: (ctx) => rejectCandidate(ctx) },
    { method: 'POST', segments: ['api', 'system', 'reindex'], handler: (ctx) => reindex(ctx) },
    { method: 'POST', segments: ['api', 'system', 'vector-rebuild'], handler: (ctx) => vectorRebuild(ctx) },
  ];

  function openDatabase(): DatabaseStore {
    return new DatabaseStore(databasePath);
  }

  function matchRoute(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
    const segments = pathname.split('/').filter((segment) => segment.length > 0);
    for (const route of routes) {
      if (route.method !== method || route.segments.length !== segments.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let index = 0; index < route.segments.length; index += 1) {
        const expected = route.segments[index]!;
        const actual = segments[index]!;
        if (expected.startsWith(':')) params[expected.slice(1)] = decodeURIComponent(actual);
        else if (expected !== actual) {
          matched = false;
          break;
        }
      }
      if (matched) return { route, params };
    }
    return null;
  }

  async function overview(): Promise<unknown> {
    const database = openDatabase();
    try {
      const browser = new BrainBrowser(brainPath, database);
      const summary = await browser.summary();
      const records = await new MarkdownMemoryRepository(brainPath).records();
      const backlog = records
        .filter(({ memory }) => memory.status === 'draft' || memory.status === 'candidate')
        .map(({ memory }) => ({
          id: memory.id, title: memory.title, status: memory.status, type: memory.type, updated: memory.updated,
        }));
      const jobs = database.listJobs();
      const jobCounts = { queued: 0, running: 0, failed: 0, dead: 0, done: 0 } as Record<string, number>;
      for (const job of jobs) jobCounts[job.status] = (jobCounts[job.status] ?? 0) + 1;
      const indexed = database.listMemoryIndex().length;
      const audit = await new SqliteAuditLog(database).list();
      const recent = audit.slice(-10).reverse().map(compactAudit);
      return {
        summary,
        reviewBacklog: backlog.slice(0, 10),
        reviewBacklogCount: backlog.length,
        jobs: { ...jobCounts, total: jobs.length },
        index: { memories: records.length, indexed, drift: records.length !== indexed },
        audit: { total: audit.length, recent },
      };
    } finally {
      database.close();
    }
  }

  async function listMemories(ctx: RouteContext): Promise<unknown> {
    const database = openDatabase();
    try {
      const query = ctx.url.searchParams;
      const offset = Math.max(0, Number(query.get('offset') ?? '0') || 0);
      const limit = Math.min(200, Math.max(1, Number(query.get('limit') ?? '25') || 25));
      const filter = {
        ...(memoryType(query.get('type')) === undefined ? {} : { type: memoryType(query.get('type'))! }),
        ...(memoryStatus(query.get('status')) === undefined ? {} : { status: memoryStatus(query.get('status'))! }),
        ...(optionalString(query.get('projectId')) === undefined ? {} : { projectId: query.get('projectId')! }),
        ...(optionalString(query.get('scope')) === undefined ? {} : { scope: query.get('scope') as Scope['kind'] }),
        includeExcluded: query.get('includeExcluded') === 'true',
        offset: 0,
        limit: 100000,
      };
      const page = await new BrainBrowser(brainPath, database).list(filter);
      const needle = optionalString(query.get('q'))?.toLowerCase();
      const filtered = (needle === undefined
        ? page.items
        : page.items.filter((memory) =>
          memory.title.toLowerCase().includes(needle) || memory.summary.toLowerCase().includes(needle) || memory.id.toLowerCase().includes(needle)))
        .slice()
        .sort((left, right) => String(right.updated ?? '').localeCompare(String(left.updated ?? '')));
      return { items: filtered.slice(offset, offset + limit), total: filtered.length, offset, limit };
    } finally {
      database.close();
    }
  }

  async function createMemory(ctx: RouteContext): Promise<unknown> {
    const body = requireRecord(ctx.body);
    const type = memoryType(body.type);
    const scopeValue = isRecord(body.scope) ? body.scope : undefined;
    const scopeKind = optionalString(scopeValue?.kind);
    if (type === undefined || scopeKind === undefined || !['global', 'domain', 'project'].includes(scopeKind)) {
      throw new HttpError(400, 'INVALID_INPUT', 'type and scope.kind are required');
    }
    const scope: Scope = scopeKind === 'global'
      ? { kind: 'global' }
      : { kind: scopeKind as 'domain' | 'project', id: optionalString(scopeValue?.id) ?? 'default' };
    const title = optionalString(body.title) ?? '未命名记忆';
    const summary = optionalString(body.summary) ?? title;
    const markdown = optionalString(body.body) ?? summary;
    const timestamp = now().toISOString();
    const id = `mem_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const memory = parseMemory({
      schemaVersion: 1,
      id,
      type,
      scope,
      projectId: scope.kind === 'project' ? scope.id : optionalString(body.projectId) ?? null,
      status: 'draft',
      title,
      summary,
      confidence: typeof body.confidence === 'number' ? body.confidence : 0.5,
      sourceTrust: optionalString(body.sourceTrust) ?? 'user_authored',
      visibility: optionalString(body.visibility) ?? 'private',
      created: timestamp,
      updated: timestamp,
      contentHash: contentHash(markdown),
      sources: [{ kind: 'tool_call', locator: 'web-workbench', label: 'created in web workbench' }],
      anchors: [],
      tags: Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    });
    const database = openDatabase();
    try {
      const repository = new MarkdownMemoryRepository(brainPath);
      repository.setBody(id, markdown);
      const created = await new GovernanceService(repository, new SqliteAuditLog(database), now).create(memory, WEB_ACTOR, optionalString(body.reason) ?? 'created via web workbench');
      new FtsRetrievalProvider(database).upsert(created, markdown);
      enqueueSemanticUpsert(database, created.id, created.contentHash);
      enqueueConsolidationScan(database);
      return { memory: created, body: markdown };
    } finally {
      database.close();
    }
  }

  async function getMemory(ctx: RouteContext): Promise<unknown> {
    const database = openDatabase();
    try {
      const fts = new FtsRetrievalProvider(database);
      const related = (id: string, title: string) => fts
        .search({ query: title, limit: 6 })
        .filter((candidate) => candidate.memory.id !== id)
        .slice(0, 4)
        .map((candidate) => ({ id: candidate.memory.id, score: candidate.score, reason: candidate.matchReason }));
      const dedupOf = (memory: Memory): Record<string, unknown> | null => {
        const raw = database.getMetadata(`consolidation:dedup:${memory.id}:${memory.contentHash}`);
        if (raw === null) return null;
        try {
          return JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return null;
        }
      };
      const detail = await new BrainBrowser(brainPath, database).detail(ctx.params.id!, { includeBody: true, includeEvidence: true });
      const audit = (await new SqliteAuditLog(database).list())
        .filter((record) => record.subjectId === ctx.params.id)
        .map(compactAudit);
      if (detail !== null) return { ...detail, audit, related: related(detail.memory.id, detail.memory.title), dedup: dedupOf(detail.memory) };
      const repository = new MarkdownMemoryRepository(brainPath);
      const archived = await repository.get(ctx.params.id!);
      if (archived === null) throw new HttpError(404, 'NOT_FOUND', `unknown memory: ${ctx.params.id}`);
      const body = (await repository.records()).find((record) => record.memory.id === ctx.params.id)?.body ?? archived.summary;
      return { memory: archived, body, audit, related: related(archived.id, archived.title), dedup: dedupOf(archived) };
    } finally {
      database.close();
    }
  }

  async function editMemory(ctx: RouteContext): Promise<unknown> {
    const body = requireRecord(ctx.body);
    const id = ctx.params.id!;
    const database = openDatabase();
    try {
      const repository = new MarkdownMemoryRepository(brainPath);
      const current = await repository.get(id);
      if (current === null) throw new HttpError(404, 'NOT_FOUND', `unknown memory: ${id}`);
      const records = await repository.records();
      const currentBody = records.find((record) => record.memory.id === id)?.body ?? current.summary;
      const markdown = optionalString(body.body) ?? currentBody;
      const timestamp = now().toISOString();
      const changes = {
        ...(memoryType(body.type) === undefined ? {} : { type: memoryType(body.type)! }),
        ...(optionalString(body.title) === undefined ? {} : { title: body.title as string }),
        ...(optionalString(body.summary) === undefined ? {} : { summary: body.summary as string }),
        contentHash: contentHash(markdown),
      };
      const governance = new GovernanceService(repository, new SqliteAuditLog(database), now);
      if (current.status === 'active' || current.status === 'stale') {
        if (body.confirm !== true) {
          throw new HttpError(409, 'CONFIRM_REQUIRED', 'editing an active/stale memory requires explicit confirmation');
        }
        const newId = `mem_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
        repository.setBody(id, currentBody);
        repository.setBody(newId, markdown);
        const next = await governance.edit(id, newId, changes, WEB_ACTOR, optionalString(body.reason) ?? 'edited via web workbench');
        new FtsRetrievalProvider(database).upsert(await repository.get(newId) ?? next, markdown);
        return { memory: next, body: markdown, superseded: id };
      }
      const next = parseMemory({ ...current, ...changes, updated: timestamp });
      repository.setBody(id, markdown);
      await repository.save(next);
      await new SqliteAuditLog(database).append({
        eventType: 'memory.updated',
        actor: WEB_ACTOR.actor,
        ...(WEB_ACTOR.actorId === undefined ? {} : { actorId: WEB_ACTOR.actorId }),
        subjectType: 'memory',
        subjectId: id,
        occurredAt: timestamp,
        reason: optionalString(body.reason) ?? 'edited via web workbench',
        payload: { status: next.status },
      });
      new FtsRetrievalProvider(database).upsert(next, markdown);
      enqueueSemanticUpsert(database, next.id, next.contentHash);
      return { memory: next, body: markdown };
    } finally {
      database.close();
    }
  }

  async function transitionMemory(ctx: RouteContext): Promise<unknown> {
    const body = requireRecord(ctx.body);
    const id = ctx.params.id!;
    const type = optionalString(body.type);
    const reason = optionalString(body.reason) ?? `${type} via web workbench`;
    const database = openDatabase();
    try {
      const repository = new MarkdownMemoryRepository(brainPath);
      const governance = new GovernanceService(repository, new SqliteAuditLog(database), now);
      let memory: Memory;
      if (type === 'forget') {
        if (body.confirm !== true) {
          throw new HttpError(409, 'CONFIRM_REQUIRED', 'forget requires explicit confirmation');
        }
        memory = await governance.forget(id, WEB_ACTOR, reason, true);
      } else {
        const command = buildCommand(type, body);
        memory = await governance.transition(id, command, WEB_ACTOR, reason);
      }
      const records = await repository.records();
      const markdown = records.find((record) => record.memory.id === id)?.body ?? memory.summary;
      const fts = new FtsRetrievalProvider(database);
      if (memory.status === 'forgotten') fts.remove(memory.id);
      else fts.upsert(memory, markdown);
      enqueueSemanticUpsert(database, memory.id, memory.contentHash);
      enqueueConsolidationScan(database);
      return { memory };
    } finally {
      database.close();
    }
  }

  async function feedbackMemory(ctx: RouteContext): Promise<unknown> {
    const body = requireRecord(ctx.body);
    const id = ctx.params.id!;
    const kindValue = optionalString(body.kind);
    const kinds: readonly MemoryFeedbackKind[] = ['useful', 'not_useful', 'verified', 'conflict', 'cite', 'outcome'];
    if (kindValue === undefined || !kinds.includes(kindValue as MemoryFeedbackKind)) {
      throw new HttpError(400, 'INVALID_INPUT', `kind must be one of: ${kinds.join(', ')}`);
    }
    const database = openDatabase();
    try {
      const repository = new MarkdownMemoryRepository(brainPath);
      const memory = await new GovernanceService(repository, new SqliteAuditLog(database), now)
        .feedback(id, kindValue as MemoryFeedbackKind, WEB_ACTOR, optionalString(body.note) ?? 'feedback via web workbench');
      const records = await repository.records();
      const markdown = records.find((record) => record.memory.id === id)?.body ?? memory.summary;
      const fts = new FtsRetrievalProvider(database);
      if (memory.status === 'forgotten') fts.remove(memory.id);
      else fts.upsert(memory, markdown);
      enqueueConsolidationScan(database);
      return { memory };
    } finally {
      database.close();
    }
  }

  let semanticEmbedder: Embedder | undefined;

  async function runWithSemantic<T>(
    database: DatabaseStore,
    run: (semantic: SemanticRetriever | undefined) => Promise<T>,
  ): Promise<T> {
    let index: ZvecMemoryIndex | undefined;
    let retriever: SemanticRetriever | undefined;
    if (options.modelPath !== undefined) {
      try {
        semanticEmbedder ??= createRpcEmbedder(brainPath);
        index = new ZvecMemoryIndex(join(brainPath, '.taga', 'semantic'));
        retriever = new ZvecSemanticRetriever({ database, index, embedder: semanticEmbedder });
      } catch {
        retriever = undefined;
        index?.close();
        index = undefined;
      }
    }
    try {
      return await run(retriever);
    } finally {
      index?.close();
    }
  }

  async function search(ctx: RouteContext): Promise<unknown> {
    const query = ctx.url.searchParams;
    const q = optionalString(query.get('q'));
    if (q === undefined) throw new HttpError(400, 'INVALID_INPUT', 'q is required');
    const database = openDatabase();
    try {
      const scopeValue = optionalString(query.get('scope'));
      const scopeId = optionalString(query.get('scopeId'));
      const semanticParam = optionalString(query.get('semantic'));
      const mode = semanticParam === 'shadow' || semanticParam === 'on' || semanticParam === 'off'
        ? semanticParam
        : options.semanticMode ?? 'off';
      const input = {
        query: q,
        limit: Number(query.get('limit') ?? '10') || 10,
        includeDraft: query.get('includeDraft') === 'true',
        ...(scopeValue !== undefined && scopeId !== undefined ? { scope: { kind: scopeValue, id: scopeId } as Scope } : {}),
      };
      const result = mode === 'off'
        ? await new FtsRetrievalProvider(database).searchHybrid(input, undefined)
        : await runWithSemantic(database, (retriever) => new FtsRetrievalProvider(database).searchHybrid(input, retriever));
      return {
        query: q,
        semanticMode: mode,
        semanticAvailable: result.semanticAvailable,
        degraded: result.degraded,
        items: result.items.map((item) => ({
          id: item.memory.id,
          status: item.memory.status,
          type: item.memory.type,
          title: item.memory.title,
          summary: item.memory.summary,
          excerpt: item.memory.body.slice(0, 160),
          score: item.score,
          relevance: item.relevance,
          ...(item.lexicalScore === undefined ? {} : { lexicalScore: item.lexicalScore }),
          ...(item.semanticScore === undefined ? {} : { semanticScore: item.semanticScore }),
          matchReason: item.matchReason,
          source: item.source,
        })),
        note: mode !== 'off' && !result.semanticAvailable
          ? '语义检索不可用（daemon 未运行 / 索引缺失），已降级纯 FTS5'
          : query.get('includeDraft') === 'true'
            ? 'include_draft：draft 结果已标记并降权'
            : 'draft / candidate 未进入默认召回',
      };
    } finally {
      database.close();
    }
  }

  async function contextPreview(ctx: RouteContext): Promise<unknown> {
    const body = requireRecord(ctx.body);
    const database = openDatabase();
    try {
      const records = await new MarkdownMemoryRepository(brainPath).records();
      const service = new SessionContextService(brainPath, database, now);
      const result = await runWithSemantic(database, (semantic) => service.start({
        sessionId: `web-preview-${randomUUID().slice(0, 8)}`,
        agentId: optionalString(body.agentId) ?? 'web',
        channel: 'static',
        refresh: true,
        ...(optionalString(body.projectId) === undefined ? {} : { projectId: body.projectId as string }),
        ...(optionalString(body.task) === undefined ? {} : { task: body.task as string }),
        ...(typeof body.tokenBudget === 'number' ? { tokenBudget: body.tokenBudget } : {}),
      }, records.map((record) => ({ memory: record.memory, body: record.body })), semantic));
      const stats = summarizePack(result.pack);
      const trace = new ContextPackBuilder().trace(result.pack);
      await new SqliteAuditLog(database).append({
        eventType: 'context.build',
        actor: 'user',
        actorId: 'web',
        subjectType: 'context',
        subjectId: result.pack.id,
        occurredAt: now().toISOString(),
        reason: 'context pack preview via web workbench',
        payload: { source: result.source, included: stats.included, truncated: stats.truncated, excluded: stats.excluded },
      });
      return { pack: result.pack, stats, trace, source: result.source, stale: result.stale };
    } finally {
      database.close();
    }
  }

  async function contextInject(ctx: RouteContext): Promise<unknown> {
    const body = requireRecord(ctx.body);
    if (body.confirm !== true) {
      throw new HttpError(409, 'CONFIRM_REQUIRED', 'context inject requires explicit confirmation');
    }
    const targetPath = optionalString(body.targetPath);
    if (targetPath === undefined) {
      throw new HttpError(400, 'INVALID_INPUT', 'targetPath is required');
    }
    const database = openDatabase();
    try {
      const records = await new MarkdownMemoryRepository(brainPath).records();
      const service = new SessionContextService(brainPath, database, now);
      const result = await runWithSemantic(database, (semantic) => service.start({
        sessionId: `web-inject-${randomUUID().slice(0, 8)}`,
        agentId: optionalString(body.agentId) ?? 'web',
        channel: 'static',
        refresh: true,
        ...(optionalString(body.projectId) === undefined ? {} : { projectId: body.projectId as string }),
        ...(optionalString(body.task) === undefined ? {} : { task: body.task as string }),
      }, records.map((record) => ({ memory: record.memory, body: record.body })), semantic));
      mkdirSync(dirname(targetPath), { recursive: true });
      await upsertManagedBlock(targetPath, result.pack.content, { begin: instructionBlockBegin, end: instructionBlockEnd });
      await new SqliteAuditLog(database).append({
        eventType: 'context.inject',
        actor: 'user',
        actorId: 'web',
        subjectType: 'context',
        subjectId: result.pack.id,
        occurredAt: now().toISOString(),
        reason: 'context injected into agent instructions via web workbench',
        payload: { injectedPath: targetPath, agentId: optionalString(body.agentId) ?? 'web' },
      });
      return { packId: result.pack.id, injectedPath: targetPath };
    } finally {
      database.close();
    }
  }

  async function knowledgeIngest(ctx: RouteContext): Promise<unknown> {
    const body = requireRecord(ctx.body);
    const text = optionalString(body.text);
    if (text === undefined) throw new HttpError(400, 'INVALID_INPUT', 'text is required');
    if (SENSITIVE_RE.test(text)) {
      throw new HttpError(400, 'SENSITIVE_BLOCKED', '摄取内容命中敏感值规则，已阻止且未落盘');
    }
    const segments = text
      .split(/\n-{3,}\n/)
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0)
      .slice(0, 20);
    if (segments.length === 0) throw new HttpError(400, 'INVALID_INPUT', 'no content to ingest');
    const packId = optionalString(body.packId);
    const type = memoryType(body.type) ?? 'lessons';
    const database = openDatabase();
    try {
      const repository = new MarkdownMemoryRepository(brainPath);
      const governance = new GovernanceService(repository, new SqliteAuditLog(database), now);
      const fts = new FtsRetrievalProvider(database);
      const created: { id: string; title: string }[] = [];
      for (const segment of segments) {
        const lines = segment.split('\n');
        const firstIndex = lines.findIndex((line) => line.trim().length > 0);
        const title = (lines[firstIndex] ?? '未命名知识').replace(/^#+\s*/, '').trim().slice(0, 120) || '未命名知识';
        const summaryLine = lines.slice(firstIndex + 1).find((line) => line.trim().length > 0) ?? title;
        const timestamp = now().toISOString();
        const id = `mem_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
        const memory = parseMemory({
          schemaVersion: 1,
          id,
          type,
          scope: { kind: 'global' },
          projectId: null,
          status: 'draft',
          title,
          summary: summaryLine.trim().slice(0, 200),
          confidence: 0.5,
          sourceTrust: 'observed',
          visibility: 'private',
          created: timestamp,
          updated: timestamp,
          contentHash: contentHash(segment),
          sources: [{
            kind: 'tool_call',
            locator: packId === undefined ? 'knowledge-ingest:web' : `knowledge-ingest:${packId}`,
            label: 'knowledge ingest via web workbench',
          }],
          anchors: [],
          tags: packId === undefined ? [] : [packId],
        });
        repository.setBody(id, segment);
        const saved = await governance.create(memory, WEB_ACTOR, 'knowledge ingest via web workbench');
        fts.upsert(saved, segment);
        created.push({ id: saved.id, title: saved.title });
      }
      enqueueConsolidationScan(database);
      return { created, count: created.length, skippedSensitive: false };
    } finally {
      database.close();
    }
  }

  function sessions(): unknown {
    const database = openDatabase();
    try {
      const service = new SessionContextService(brainPath, database, now);
      const observations = service.timeline({ limit: 50 });
      const sessionIds = [...new Set(observations.map((observation) => observation.sessionId))];
      return { observations, sessionIds, cursors: database.listMetadata('cursor:') };
    } finally {
      database.close();
    }
  }

  function packs(): unknown {
    const database = openDatabase();
    try {
      return { items: new DomainPackService(database, undefined, now).list() };
    } finally {
      database.close();
    }
  }

  async function togglePack(ctx: RouteContext): Promise<unknown> {
    const body = requireRecord(ctx.body);
    if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'INVALID_INPUT', 'enabled must be boolean');
    const database = openDatabase();
    try {
      const service = new DomainPackService(database, undefined, now);
      service.setEnabled(ctx.params.id! as Parameters<DomainPackService['setEnabled']>[0], body.enabled);
      await new SqliteAuditLog(database).append({
        eventType: 'pack.toggle',
        actor: 'user',
        actorId: 'web',
        subjectType: 'domain-pack',
        subjectId: ctx.params.id!,
        occurredAt: now().toISOString(),
        reason: body.enabled ? 'domain pack enabled via web workbench' : 'domain pack disabled via web workbench',
        payload: { enabled: body.enabled },
      });
      return { items: service.list() };
    } finally {
      database.close();
    }
  }

  async function retryJob(ctx: RouteContext): Promise<unknown> {
    const database = openDatabase();
    try {
      const job = database.getJob(ctx.params.id!);
      if (job === null) throw new HttpError(404, 'NOT_FOUND', `unknown job: ${ctx.params.id}`);
      if (job.status !== 'failed' && job.status !== 'dead' && job.status !== 'cancelled') {
        throw new HttpError(409, 'JOB_NOT_RETRYABLE', `job status ${job.status} is not retryable`);
      }
      const nextId = `job_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      database.enqueueJob({ id: nextId, kind: job.kind, payload: job.payload });
      await new SqliteAuditLog(database).append({
        eventType: 'job.retry',
        actor: 'user',
        actorId: 'web',
        subjectType: 'job',
        subjectId: job.id,
        occurredAt: now().toISOString(),
        reason: 'job retried via web workbench',
        payload: { nextId, kind: job.kind },
      });
      return { nextId, kind: job.kind };
    } finally {
      database.close();
    }
  }

  async function vectorRebuild(ctx: RouteContext): Promise<unknown> {
    const body = requireRecord(ctx.body);
    if (body.confirm !== true) {
      throw new HttpError(409, 'CONFIRM_REQUIRED', 'vector rebuild requires explicit confirmation');
    }
    const database = openDatabase();
    try {
      enqueueSemanticRebuild(database);
      await new SqliteAuditLog(database).append({
        eventType: 'maintenance.vector_rebuild',
        actor: 'user',
        actorId: 'web',
        subjectType: 'index',
        subjectId: 'semantic',
        occurredAt: now().toISOString(),
        reason: 'semantic rebuild enqueued via web workbench',
      });
      return { queued: true };
    } finally {
      database.close();
    }
  }

  function listCandidates(ctx: RouteContext): unknown {
    const database = openDatabase();
    try {
      const decision = optionalString(ctx.url.searchParams.get('decision'));
      const all = database.listCandidates();
      const counts: Record<string, number> = { pending: 0, accepted: 0, rejected: 0 };
      for (const item of all) counts[item.decision] = (counts[item.decision] ?? 0) + 1;
      const items = (decision === undefined ? all : all.filter((item) => item.decision === decision)).slice().reverse();
      return { items, counts, total: all.length };
    } finally {
      database.close();
    }
  }

  async function createCandidate(ctx: RouteContext): Promise<unknown> {
    const body = requireRecord(ctx.body);
    const timestamp = now().toISOString();
    const candidate = parseCandidate({
      id: optionalString(body.id) ?? `candidate-web-${randomUUID().replace(/-/g, '').slice(0, 10)}`,
      observationId: optionalString(body.observationId) ?? `observation-web-${randomUUID().replace(/-/g, '').slice(0, 10)}`,
      createdAt: optionalString(body.createdAt) ?? timestamp,
      ...body,
      decision: 'pending',
    });
    const database = openDatabase();
    try {
      database.saveCandidate(candidate);
      await new SqliteAuditLog(database).append({
        eventType: 'candidate.created',
        actor: 'user',
        actorId: 'web',
        subjectType: 'candidate',
        subjectId: candidate.id,
        occurredAt: timestamp,
        reason: optionalString(body.reason) ?? 'knowledge candidate created via web workbench',
        payload: { memoryType: candidate.memoryType, origin: candidate.id.includes('reflect') ? 'reflect' : 'distill' },
      });
      return { candidate };
    } finally {
      database.close();
    }
  }

  async function acceptCandidate(ctx: RouteContext): Promise<unknown> {
    const body = requireRecord(ctx.body);
    const database = openDatabase();
    try {
      const candidate = database.getCandidate(ctx.params.id!);
      if (candidate === null) throw new HttpError(404, 'NOT_FOUND', `unknown candidate: ${ctx.params.id}`);
      if (candidate.decision !== 'pending') throw new HttpError(409, 'ALREADY_DECIDED', `candidate already ${candidate.decision}`);
      const repository = new MarkdownMemoryRepository(brainPath);
      const timestamp = now().toISOString();
      const memoryId = `mem_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const markdown = candidate.body.length > 0 ? candidate.body : candidate.summary;
      const sources = candidate.anchors.length > 0
        ? candidate.anchors
        : [{ kind: 'tool_call' as const, locator: `candidate:${candidate.id}`, label: 'accepted from knowledge candidate' }];
      const memory = parseMemory({
        schemaVersion: 1,
        id: memoryId,
        type: candidate.memoryType,
        scope: candidate.scopeSuggestion,
        projectId: candidate.scopeSuggestion.kind === 'project' ? candidate.scopeSuggestion.id : candidate.projectId ?? null,
        status: 'draft',
        title: candidate.title,
        summary: candidate.summary,
        confidence: candidate.confidence,
        sourceTrust: 'observed',
        visibility: 'private',
        created: timestamp,
        updated: timestamp,
        contentHash: contentHash(markdown),
        sources,
        anchors: [],
        tags: [`candidate:${candidate.id}`],
      });
      repository.setBody(memoryId, markdown);
      const governance = new GovernanceService(repository, new SqliteAuditLog(database), now);
      const created = await governance.create(memory, WEB_ACTOR, optionalString(body.reason) ?? `accepted knowledge candidate ${candidate.id}`);
      new FtsRetrievalProvider(database).upsert(created, markdown);
      enqueueSemanticUpsert(database, created.id, created.contentHash);
      enqueueConsolidationScan(database);
      const decided: Candidate = {
        ...candidate,
        decision: 'accepted',
        decidedAt: timestamp,
        decisionReason: optionalString(body.reason) ?? 'accepted via web workbench',
      };
      database.saveCandidate(decided);
      await new SqliteAuditLog(database).append({
        eventType: 'candidate.accepted',
        actor: 'user',
        actorId: 'web',
        subjectType: 'candidate',
        subjectId: candidate.id,
        occurredAt: timestamp,
        reason: optionalString(body.reason) ?? 'accepted via web workbench',
        payload: { memoryId: created.id },
      });
      return { candidate: decided, memory: created };
    } finally {
      database.close();
    }
  }

  async function rejectCandidate(ctx: RouteContext): Promise<unknown> {
    const body = requireRecord(ctx.body);
    const database = openDatabase();
    try {
      const candidate = database.getCandidate(ctx.params.id!);
      if (candidate === null) throw new HttpError(404, 'NOT_FOUND', `unknown candidate: ${ctx.params.id}`);
      if (candidate.decision !== 'pending') throw new HttpError(409, 'ALREADY_DECIDED', `candidate already ${candidate.decision}`);
      const timestamp = now().toISOString();
      const decided: Candidate = {
        ...candidate,
        decision: 'rejected',
        decidedAt: timestamp,
        decisionReason: optionalString(body.reason) ?? 'rejected via web workbench',
      };
      database.saveCandidate(decided);
      await new SqliteAuditLog(database).append({
        eventType: 'candidate.rejected',
        actor: 'user',
        actorId: 'web',
        subjectType: 'candidate',
        subjectId: candidate.id,
        occurredAt: timestamp,
        reason: optionalString(body.reason) ?? 'rejected via web workbench',
      });
      return { candidate: decided };
    } finally {
      database.close();
    }
  }

  async function auditLog(ctx: RouteContext): Promise<unknown> {
    const database = openDatabase();
    try {
      const query = ctx.url.searchParams;
      const actor = optionalString(query.get('actor'));
      const eventType = optionalString(query.get('eventType'));
      const subject = optionalString(query.get('subject'));
      const offset = Math.max(0, Number(query.get('offset') ?? '0') || 0);
      const limit = Math.min(500, Math.max(1, Number(query.get('limit') ?? '30') || 30));
      let records = (await new SqliteAuditLog(database).list()).map(compactAudit).reverse();
      if (actor !== undefined) records = records.filter((record) => record.actor === actor);
      if (eventType !== undefined) records = records.filter((record) => record.eventType.includes(eventType));
      if (subject !== undefined) records = records.filter((record) => record.subjectId === subject);
      return { items: records.slice(offset, offset + limit), total: records.length, offset, limit };
    } finally {
      database.close();
    }
  }

  async function gardenList(ctx: RouteContext): Promise<unknown> {
    const database = openDatabase();
    try {
      const { GardenService } = await import('../../../packages/garden/src/index.js');
      const service = new GardenService(database, { clock: now });
      const statusValue = optionalString(ctx.url.searchParams.get('status'));
      const status = statusValue === 'pending' || statusValue === 'accepted' || statusValue === 'rejected' || statusValue === 'ignored'
        ? statusValue
        : undefined;
      const proposals = status === undefined ? service.list() : service.list(status);
      const records = await new MarkdownMemoryRepository(brainPath).records();
      const byId = new Map(records.map((record) => [record.memory.id, record]));
      const items = proposals.map((proposal) => ({
        ...proposal,
        memories: proposal.affectedIds.map((id) => {
          const record = byId.get(id);
          if (record === undefined) return { id, missing: true };
          return {
            id,
            role: record.memory.status === 'draft' || record.memory.status === 'candidate' ? 'candidate' : 'primary',
            title: record.memory.title,
            summary: record.memory.summary,
            excerpt: record.body.slice(0, 600),
            status: record.memory.status,
            type: record.memory.type,
            updated: record.memory.updated,
            usefulCount: record.memory.usefulCount,
            notUsefulCount: record.memory.notUsefulCount,
            contentHash: record.memory.contentHash,
          };
        }),
        llm: (() => {
          for (const id of proposal.affectedIds) {
            const record = byId.get(id);
            if (record === undefined) continue;
            const raw = database.getMetadata(`consolidation:dedup:${id}:${record.memory.contentHash}`);
            if (raw === null) continue;
            try {
              const parsed = JSON.parse(raw) as Record<string, unknown>;
              if (parsed.verdict !== undefined) return parsed;
            } catch {
              continue;
            }
          }
          return null;
        })(),
      }));
      return { proposals: items };
    } finally {
      database.close();
    }
  }

  async function gardenScan(): Promise<unknown> {
    const database = openDatabase();
    try {
      const { GardenService } = await import('../../../packages/garden/src/index.js');
      const service = new GardenService(database, { clock: now });
      const memories = await new MarkdownMemoryRepository(brainPath).list();
      const report = service.scanSafe(memories);
      return { proposals: service.list('pending'), generated: report.proposals.length, unchanged: report.unchanged };
    } finally {
      database.close();
    }
  }

  async function gardenReview(ctx: RouteContext): Promise<unknown> {
    const body = requireRecord(ctx.body);
    const decisionValue = optionalString(body.decision);
    if (decisionValue !== 'accepted' && decisionValue !== 'rejected' && decisionValue !== 'ignored') {
      throw new HttpError(400, 'INVALID_INPUT', 'decision must be accepted, rejected or ignored');
    }
    const database = openDatabase();
    try {
      const { GardenService } = await import('../../../packages/garden/src/index.js');
      const service = new GardenService(database, { clock: now });
      const proposal = await service.review(ctx.params.id!, decisionValue, {
        repository: new MarkdownMemoryRepository(brainPath),
        audit: new SqliteAuditLog(database),
        actor: WEB_ACTOR,
        ...(optionalString(body.action) === undefined ? {} : { action: optionalString(body.action)! as 'mark_stale' | 'review_duplicate' | 'review_conflict' | 'supersede' }),
        ...(optionalString(body.targetId) === undefined ? {} : { targetId: body.targetId as string }),
      });
      return { proposal };
    } finally {
      database.close();
    }
  }

  function projects(): unknown {
    const database = openDatabase();
    try {
      return { items: database.listProjectContexts() };
    } finally {
      database.close();
    }
  }

  function jobs(): unknown {
    const database = openDatabase();
    try {
      return { items: database.listJobs() };
    } finally {
      database.close();
    }
  }

  async function system(): Promise<unknown> {
    const database = openDatabase();
    try {
      const records = await new MarkdownMemoryRepository(brainPath).records();
      let semanticIndexStatus = 'unavailable';
      try {
        const index = new ZvecMemoryIndex(join(brainPath, '.taga', 'semantic'));
        const integrity = await index.integrity();
        semanticIndexStatus = integrity.activeGeneration === null ? 'not-built' : integrity.ok ? 'ready' : 'degraded';
        index.close();
      } catch {
        semanticIndexStatus = 'unavailable';
      }
      return {
        brainPath,
        databasePath,
        integrity: database.integrityCheck(),
        memories: records.length,
        indexed: database.listMemoryIndex().length,
        jobs: database.listJobs().length,
        cursors: database.listMetadata('cursor:').length,
        defaultTheme: DEFAULT_THEME_ID,
        semantic: {
          mode: options.semanticMode ?? 'off',
          modelPath: options.modelPath ?? null,
          modelAvailable: options.modelPath !== undefined && existsSync(options.modelPath),
          indexStatus: semanticIndexStatus,
        },
        llm: {
          mode: options.llm?.mode ?? 'off',
          provider: options.llm?.provider ?? 'openai-compatible',
          endpoint: options.llm?.endpoint ?? '',
          model: options.llm?.model ?? '',
          timeoutMs: options.llm?.timeoutMs ?? 30000,
          ...(options.llm?.dailyCap === undefined ? {} : { dailyCap: options.llm.dailyCap }),
          apiKeySet: options.llm?.apiKeySet === true,
        },
        notes: [
          '服务仅绑定 127.0.0.1，不提供远程访问',
          'API Key 等敏感值仅从环境变量读取，界面与 API 只显示占位',
          'Fast Path 不依赖 daemon / LLM / 语义索引',
        ],
      };
    } finally {
      database.close();
    }
  }

  async function reindex(ctx: RouteContext): Promise<unknown> {
    const body = requireRecord(ctx.body);
    if (body.confirm !== true) {
      throw new HttpError(409, 'CONFIRM_REQUIRED', 'reindex requires explicit confirmation');
    }
    const database = openDatabase();
    try {
      const report = await new RecoveryService(brainPath, database).reindex();
      return { report };
    } finally {
      database.close();
    }
  }

  function buildCommand(type: unknown, body: Record<string, unknown>): MemoryCommand {
    switch (type) {
      case 'activate':
        return { type: 'activate' };
      case 'mark_stale':
        return { type: 'mark_stale' };
      case 'refresh':
        return { type: 'refresh' };
      case 'supersede': {
        const replacementId = optionalString(body.replacementId);
        if (replacementId === undefined) throw new HttpError(400, 'INVALID_INPUT', 'supersede requires replacementId');
        return { type: 'supersede', replacementId };
      }
      default:
        throw new HttpError(400, 'INVALID_INPUT', `unsupported transition type: ${String(type)}`);
    }
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const target = resolve(join(staticRoot, relative));
    if (!target.startsWith(resolve(staticRoot))) {
      res.writeHead(403).end('forbidden');
      return;
    }
    try {
      await stat(target);
      const data = await readFile(target);
      res.writeHead(200, { 'content-type': CONTENT_TYPES[extname(target)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(data);
    } catch {
      const fallback = await readFile(join(staticRoot, 'index.html'));
      res.writeHead(200, { 'content-type': CONTENT_TYPES['.html']!, 'cache-control': 'no-cache' });
      res.end(fallback);
    }
  }

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    res.setHeader('x-content-type-options', 'nosniff');
    try {
      if (!url.pathname.startsWith('/api/')) {
        await serveStatic(req, res, url.pathname);
        return;
      }
      const matched = matchRoute(req.method ?? 'GET', url.pathname);
      if (matched === null) throw new HttpError(404, 'NOT_FOUND', `no route for ${req.method ?? 'GET'} ${url.pathname}`);
      const body = req.method === 'GET' || req.method === 'HEAD' ? {} : await readJsonBody(req);
      const result = await matched.route.handler({ req, res, url, params: matched.params, body });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, data: result }));
    } catch (error) {
      const isContractError = error instanceof Error && 'code' in error && typeof (error as { code: unknown }).code === 'string';
      const status = error instanceof HttpError ? error.status : isContractError ? 400 : 500;
      const code = error instanceof HttpError ? error.code : isContractError ? String((error as { code: unknown }).code) : 'INTERNAL_ERROR';
      const message = error instanceof Error ? error.message : 'unknown error';
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, code, message }));
    }
  }

  return { server, databasePath };
}

interface CompactAudit {
  readonly eventType: string;
  readonly actor: string;
  readonly actorId?: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly occurredAt: string;
  readonly reason: string;
  readonly eventHash: string;
  readonly payload: Record<string, unknown>;
}

function compactAudit(record: {
  eventType: string;
  actor: string;
  actorId?: string;
  subjectType: string;
  subjectId: string;
  occurredAt: string;
  reason: string;
  eventHash: string;
  prevHash?: string;
  payload?: Record<string, unknown>;
}): CompactAudit {
  return {
    eventType: record.eventType,
    actor: record.actor,
    ...(record.actorId === undefined ? {} : { actorId: record.actorId }),
    subjectType: record.subjectType,
    subjectId: record.subjectId,
    occurredAt: record.occurredAt,
    reason: record.reason,
    eventHash: record.eventHash.slice(0, 12),
    payload: record.payload ?? {},
  };
}

export async function startWebServer(options: WebServerOptions & { readonly host?: string; readonly port?: number }): Promise<{
  readonly server: Server;
  readonly url: string;
}> {
  const { server } = createWebServer(options);
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;
  return { server, url: `http://${host}:${boundPort}` };
}
