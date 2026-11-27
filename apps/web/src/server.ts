import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { copyFile, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify as yamlStringify } from 'yaml';
import { daemonStatus, startDaemonProcess, stopDaemon } from '../../../apps/daemon/src/lifecycle.js';
import { GovernanceService, SqliteAuditLog, enqueueConsolidationScan, type LifecycleActor, type MemoryFeedbackKind } from '../../../packages/application/src/index.js';
import { PolishService, createLlmProvider, metadataLlmBudgetState, withLlmBudget, type CandidatePolisher } from '../../../packages/distillation/src/index.js';
import { BrainBrowser } from '../../../packages/browsing/src/index.js';
import { configFileV4Schema, loadConfig, parseConfigText } from '../../../packages/config/src/index.js';
import { ContextPackBuilder, summarizePack } from '../../../packages/context/src/index.js';
import { parseCandidate, parseMemory, type Candidate, type Memory, type MemoryCommand, type MemoryStatus, type MemoryType, type Scope } from '../../../packages/domain/src/index.js';
import { DomainPackService } from '../../../packages/domain-packs/src/index.js';
import { createRpcEmbedder, type Embedder } from '../../../packages/embedding/src/index.js';
import { LaunchdUserServiceManager, SystemdUserServiceManager, platformHealth } from '../../../packages/platform/src/index.js';
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
    readonly dailyTokens?: number;
    readonly perConsumerShare?: number;
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
    { method: 'POST', segments: ['api', 'projects', 'collect'], handler: () => collectNow() },
    { method: 'GET', segments: ['api', 'jobs'], handler: () => jobs() },
    { method: 'POST', segments: ['api', 'jobs', ':id', 'retry'], handler: (ctx) => retryJob(ctx) },
    { method: 'POST', segments: ['api', 'jobs', 'clear'], handler: (ctx) => clearJobs(ctx) },
    { method: 'POST', segments: ['api', 'jobs', 'rerun'], handler: (ctx) => rerunJobs(ctx) },
    { method: 'GET', segments: ['api', 'system'], handler: () => system() },
    { method: 'GET', segments: ['api', 'llm', 'usage'], handler: () => llmUsage() },
    { method: 'GET', segments: ['api', 'system', 'doctor'], handler: () => systemDoctor() },
    { method: 'POST', segments: ['api', 'system', 'daemon-restart'], handler: (ctx) => daemonRestart(ctx) },
    { method: 'GET', segments: ['api', 'candidates'], handler: (ctx) => listCandidates(ctx) },
    { method: 'POST', segments: ['api', 'candidates'], handler: (ctx) => createCandidate(ctx) },
    { method: 'POST', segments: ['api', 'candidates', ':id', 'accept'], handler: (ctx) => acceptCandidate(ctx) },
    { method: 'POST', segments: ['api', 'candidates', ':id', 'reject'], handler: (ctx) => rejectCandidate(ctx) },
    { method: 'POST', segments: ['api', 'system', 'reindex'], handler: (ctx) => reindex(ctx) },
    { method: 'POST', segments: ['api', 'system', 'vector-rebuild'], handler: (ctx) => vectorRebuild(ctx) },
    { method: 'GET', segments: ['api', 'config'], handler: () => configSnapshot() },
    { method: 'PUT', segments: ['api', 'config'], handler: (ctx) => updateConfig(ctx) },
    { method: 'PUT', segments: ['api', 'config', 'raw'], handler: (ctx) => updateConfigRaw(ctx) },
    { method: 'POST', segments: ['api', 'config', 'validate'], handler: (ctx) => Promise.resolve(validateConfigText(ctx)) },
  ];

  function openDatabase(): DatabaseStore {
    return new DatabaseStore(databasePath);
  }

  function buildPolisher(database: DatabaseStore): CandidatePolisher | undefined {
    const llm = options.llm;
    if (llm?.mode !== 'on' || llm.endpoint === undefined || llm.model === undefined) return undefined;
    const provider = createLlmProvider({ mode: 'on', endpoint: llm.endpoint, ...(llm.apiKey === undefined ? {} : { apiKey: llm.apiKey }) });
    if (provider === undefined) return undefined;
    return new PolishService(withLlmBudget(provider, {
      ...(llm.dailyCap === undefined ? {} : { dailyCalls: llm.dailyCap }),
      ...(llm.dailyTokens === undefined ? {} : { dailyTokens: llm.dailyTokens }),
      ...(llm.perConsumerShare === undefined ? {} : { perConsumerShare: llm.perConsumerShare }),
    }, 'polish', metadataLlmBudgetState(database)), llm.model, llm.timeoutMs ?? 30_000);
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
      const updatedAfter = optionalString(query.get('updatedAfter'));
      const sort = optionalString(query.get('sort')) ?? 'updated-desc';
      let filtered = needle === undefined
        ? page.items
        : page.items.filter((memory) =>
          memory.title.toLowerCase().includes(needle) || memory.summary.toLowerCase().includes(needle) || memory.id.toLowerCase().includes(needle));
      if (updatedAfter !== undefined) {
        filtered = filtered.filter((memory) => String(memory.updated ?? '') >= updatedAfter);
      }
      filtered = filtered.slice().sort((left, right) => {
        if (sort === 'updated-asc') return String(left.updated ?? '').localeCompare(String(right.updated ?? ''));
        if (sort === 'title') return String(left.title ?? '').localeCompare(String(right.title ?? ''));
        return String(right.updated ?? '').localeCompare(String(left.updated ?? ''));
      });
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
      const related = async (id: string, title: string, summary: string) => {
        const byId = new Map<string, { id: string; score: number; reason: string[]; source: string }>();
        for (const candidate of fts.search({ query: title, limit: 6 })) {
          if (candidate.memory.id === id) continue;
          byId.set(candidate.memory.id, { id: candidate.memory.id, score: candidate.score, reason: [...candidate.matchReason], source: 'lexical' });
        }
        await runWithSemantic(database, async (retriever) => {
          if (retriever === undefined) return;
          try {
            const hits = await retriever.search({ query: `${title}\n${summary}`, limit: 8 });
            for (const hit of hits) {
              if (hit.memory.id === id) continue;
              const existing = byId.get(hit.memory.id);
              if (existing !== undefined) {
                if (!existing.reason.includes('semantic')) existing.reason.push('semantic');
                existing.source = 'hybrid';
              } else {
                byId.set(hit.memory.id, { id: hit.memory.id, score: Number(hit.score), reason: ['semantic'], source: 'semantic' });
              }
            }
          } catch {
            /* semantic unavailable → lexical-only related */
          }
        });
        return [...byId.values()].slice(0, 6)
          .map((entry) => ({ id: entry.id, score: entry.score, reason: entry.reason, source: entry.source }));
      };
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
      if (detail !== null) return { ...detail, audit, related: await related(detail.memory.id, detail.memory.title, detail.memory.summary), dedup: dedupOf(detail.memory) };
      const repository = new MarkdownMemoryRepository(brainPath);
      const archived = await repository.get(ctx.params.id!);
      if (archived === null) throw new HttpError(404, 'NOT_FOUND', `unknown memory: ${ctx.params.id}`);
      const body = (await repository.records()).find((record) => record.memory.id === ctx.params.id)?.body ?? archived.summary;
      return { memory: archived, body, audit, related: await related(archived.id, archived.title, archived.summary), dedup: dedupOf(archived) };
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
      // The workbench is the operator console: without an explicit scope it searches every
      // project (scopeAll), unlike the agent-facing recall path where no project context
      // means global and domain memories only.
      const scopeValue = optionalString(query.get('scope'));
      const scopeId = optionalString(query.get('scopeId'));
      const scope = scopeValue === 'global'
        ? { kind: 'global' as const }
        : scopeValue === 'project' && scopeId !== undefined
          ? { kind: 'project' as const, id: scopeId }
          : undefined;
      const semanticParam = optionalString(query.get('semantic'));
      const mode = semanticParam === 'shadow' || semanticParam === 'on' || semanticParam === 'off'
        ? semanticParam
        : options.semanticMode ?? 'off';
      const input = {
        query: q,
        limit: Number(query.get('limit') ?? '10') || 10,
        includeDraft: query.get('includeDraft') === 'true',
        ...(scope === undefined ? { scopeAll: true } : { scope }),
      };
      const result = mode === 'off'
        ? await new FtsRetrievalProvider(database).searchHybrid(input, undefined)
        : await runWithSemantic(database, (retriever) => new FtsRetrievalProvider(database).searchHybrid(input, retriever));
      return {
        query: q,
        scope: scope === undefined ? 'all' : scope.kind === 'global' ? 'global' : `project:${scope.id}`,
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

  function jobIdsFrom(body: Record<string, unknown>): string[] {
    const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string') : [];
    if (ids.length === 0) throw new HttpError(400, 'INVALID_INPUT', 'ids must be a non-empty string array');
    return ids;
  }

  async function clearJobs(ctx: RouteContext): Promise<unknown> {
    const ids = jobIdsFrom(requireRecord(ctx.body));
    const database = openDatabase();
    try {
      const historical = ids.filter((id) => {
        const job = database.getJob(id);
        return job !== null && job.status !== 'running' && job.status !== 'queued';
      });
      const removed = database.deleteJobs(historical);
      await new SqliteAuditLog(database).append({
        eventType: 'job.cleared',
        actor: WEB_ACTOR.actor,
        ...(WEB_ACTOR.actorId === undefined ? {} : { actorId: WEB_ACTOR.actorId }),
        subjectType: 'job',
        subjectId: `batch-${removed}`,
        occurredAt: now().toISOString(),
        reason: 'historical jobs cleared via web workbench',
        payload: { removed, requested: ids.length },
      });
      return { removed, requested: ids.length };
    } finally {
      database.close();
    }
  }

  async function rerunJobs(ctx: RouteContext): Promise<unknown> {
    const ids = jobIdsFrom(requireRecord(ctx.body));
    const database = openDatabase();
    try {
      const queued: { readonly from: string; readonly nextId: string }[] = [];
      for (const id of ids) {
        const job = database.getJob(id);
        if (job === null) continue;
        if (job.status !== 'failed' && job.status !== 'dead' && job.status !== 'cancelled') continue;
        const nextId = `job_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
        database.enqueueJob({ id: nextId, kind: job.kind, payload: job.payload });
        queued.push({ from: id, nextId });
      }
      if (queued.length > 0) {
        await new SqliteAuditLog(database).append({
          eventType: 'job.rerun',
          actor: WEB_ACTOR.actor,
          ...(WEB_ACTOR.actorId === undefined ? {} : { actorId: WEB_ACTOR.actorId }),
          subjectType: 'job',
          subjectId: `batch-${queued.length}`,
          occurredAt: now().toISOString(),
          reason: 'failed jobs re-enqueued via web workbench',
          payload: { queued: queued.length, requested: ids.length },
        });
      }
      return { queued: queued.length, requested: ids.length, jobs: queued };
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

  /* ---------- config center ---------- */

  type ConfigPatchKind = 'boolean' | 'string' | 'positiveInt' | 'optionalInt' | 'unitInterval' | 'featureMode' | 'stringArray';

  const CONFIG_PATCH_SPEC: Readonly<Record<string, ConfigPatchKind>> = {
    'projectResolution.preferGitRoot': 'boolean',
    'projectResolution.preferGitRemote': 'boolean',
    'projectResolution.markerFile': 'string',
    'retrieval.semantic.mode': 'featureMode',
    'retrieval.semantic.modelPath': 'string',
    'llm.mode': 'featureMode',
    'llm.provider': 'string',
    'llm.endpoint': 'string',
    'llm.model': 'string',
    'llm.timeoutMs': 'positiveInt',
    'llm.dailyCap': 'optionalInt',
    'llm.dailyTokens': 'optionalInt',
    'llm.perConsumerShare': 'unitInterval',
    'consolidation.enabled': 'boolean',
    'consolidation.scanIntervalMs': 'positiveInt',
    'consolidation.promotion.minUsefulCount': 'positiveInt',
    'consolidation.promotion.maxNotUsefulCount': 'positiveInt',
    'consolidation.deduplication.rejectSimilarity': 'unitInterval',
    'consolidation.deduplication.mergeSimilarity': 'unitInterval',
    'reflection.enabled': 'boolean',
    'reflection.intervalMs': 'positiveInt',
    'reflection.windowDays': 'positiveInt',
    'reflection.minGroupSize': 'positiveInt',
    'reflection.maxGroups': 'positiveInt',
    'learning.allowNetwork': 'boolean',
    'collection.lookbackDays': 'positiveInt',
    'agents.enabled': 'stringArray',
    'agents.writeInstructions': 'boolean',
  };

  function loadWebConfig(): ReturnType<typeof loadConfig> {
    return loadConfig({ isolatedBrainPath: brainPath, overrides: { paths: { brain: brainPath } } });
  }

  async function configSnapshot(): Promise<unknown> {
    const loaded = await loadWebConfig();
    return {
      config: { ...loaded.config, llm: { ...loaded.config.llm, apiKey: undefined } },
      sources: loaded.sources,
      warnings: loaded.warnings,
      raw: await readFile(loaded.configPath, 'utf8').catch(() => ''),
      configPath: loaded.configPath,
      env: {
        llmApiKeySet: typeof process.env.TAGA_LLM_API_KEY === 'string' && process.env.TAGA_LLM_API_KEY.length > 0,
        semanticMode: process.env.TAGA_SEMANTIC_MODE ?? null,
        bgeModelPath: process.env.TAGA_BGE_M3_MODEL_PATH ?? null,
      },
    };
  }

  function validatePatchValue(kind: ConfigPatchKind, key: string, value: unknown): void {
    const reject = (expected: string): never => {
      throw new HttpError(400, 'INVALID_INPUT', `${key} expects ${expected}`);
    };
    switch (kind) {
      case 'boolean': if (typeof value !== 'boolean') reject('a boolean'); return;
      case 'string': if (typeof value !== 'string') reject('a string'); return;
      case 'positiveInt': if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) reject('a positive integer'); return;
      case 'optionalInt': if (value === null) return; if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) reject('null or a positive integer'); return;
      case 'unitInterval': if (typeof value !== 'number' || !(value >= 0 && value <= 1)) reject('a number between 0 and 1'); return;
      case 'featureMode': if (value !== 'off' && value !== 'shadow' && value !== 'on') reject('off | shadow | on'); return;
      case 'stringArray': if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) reject('an array of non-empty strings'); return;
    }
  }

  function setDotted(target: Record<string, unknown>, path: string, value: unknown): void {
    const parts = path.split('.');
    let cursor = target;
    for (const part of parts.slice(0, -1)) {
      const next = cursor[part];
      if (!isRecord(next)) cursor[part] = {};
      cursor = cursor[part] as Record<string, unknown>;
    }
    if (value === null) delete cursor[parts[parts.length - 1]!];
    else cursor[parts[parts.length - 1]!] = value;
  }

  async function writeConfigFile(configPath: string, file: Record<string, unknown>, reason: string, payload: Record<string, unknown>): Promise<void> {
    await copyFile(configPath, `${configPath}.bak`).catch(() => undefined);
    await writeFile(configPath, yamlStringify(file, { lineWidth: 120 }), 'utf8');
    const database = openDatabase();
    try {
      await new SqliteAuditLog(database).append({
        eventType: 'config.update',
        actor: WEB_ACTOR.actor,
        ...(WEB_ACTOR.actorId === undefined ? {} : { actorId: WEB_ACTOR.actorId }),
        subjectType: 'config',
        subjectId: 'config.yaml',
        occurredAt: now().toISOString(),
        reason,
        payload,
      });
    } finally {
      database.close();
    }
  }

  async function updateConfig(ctx: RouteContext): Promise<unknown> {
    const body = requireRecord(ctx.body);
    const changes = requireRecord(body.changes);
    const keys = Object.keys(changes);
    if (keys.length === 0) throw new HttpError(400, 'INVALID_INPUT', 'changes must not be empty');
    const loaded = await loadWebConfig();
    const blocked = keys.filter((key) => {
      const source = loaded.sources[key];
      return source === 'environment' || source === 'override';
    });
    if (blocked.length > 0) {
      throw new HttpError(409, 'CONFIG_LOCKED', `以下配置由环境变量 / 启动参数锁定，Web 不可修改：${blocked.join(', ')}`);
    }
    const file: Record<string, unknown> = { schemaVersion: 4, ...(loaded.file ?? {}) };
    const applied: Record<string, unknown> = {};
    for (const key of keys) {
      const kind = CONFIG_PATCH_SPEC[key];
      if (kind === undefined) throw new HttpError(400, 'INVALID_INPUT', `unsupported config key: ${key}`);
      validatePatchValue(kind, key, changes[key]);
      setDotted(file, key, changes[key]);
      applied[key] = changes[key];
    }
    const parsed = configFileV4Schema.safeParse(file);
    if (!parsed.success) {
      throw new HttpError(400, 'INVALID_INPUT', `config invalid: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`);
    }
    await writeConfigFile(loaded.configPath, parsed.data, optionalString(body.reason) ?? 'updated via web workbench', applied);
    return configSnapshot();
  }

  async function updateConfigRaw(ctx: RouteContext): Promise<unknown> {
    const body = requireRecord(ctx.body);
    const text = optionalString(body.text);
    if (text === undefined) throw new HttpError(400, 'INVALID_INPUT', 'text is required');
    if (SENSITIVE_RE.test(text)) {
      throw new HttpError(400, 'SENSITIVE_VALUE', '内容疑似包含密钥，已拒绝保存；API Key 请使用环境变量 TAGA_LLM_API_KEY');
    }
    let parsed: ReturnType<typeof parseConfigText>;
    try {
      parsed = parseConfigText(text, 'web advanced config');
    } catch (error) {
      throw new HttpError(400, 'INVALID_INPUT', error instanceof Error ? error.message : String(error));
    }
    if (parsed.legacy) throw new HttpError(400, 'INVALID_INPUT', '仅支持 schemaVersion 4 配置');
    const checked = configFileV4Schema.safeParse({ schemaVersion: 4, ...(parsed.file ?? {}) });
    if (!checked.success) {
      throw new HttpError(400, 'INVALID_INPUT', `config invalid: ${checked.error.issues.map((issue) => issue.path.join('.')).join(', ')}`);
    }
    const loaded = await loadWebConfig();
    await writeConfigFile(loaded.configPath, checked.data, optionalString(body.reason) ?? 'updated via web workbench (advanced)', { raw: true, warnings: parsed.warnings.length });
    return { ...(await configSnapshot() as Record<string, unknown>), warnings: [...parsed.warnings] };
  }

  function validateConfigText(ctx: RouteContext): unknown {
    const body = requireRecord(ctx.body);
    const text = optionalString(body.text);
    if (text === undefined) throw new HttpError(400, 'INVALID_INPUT', 'text is required');
    const warnings: string[] = [];
    if (SENSITIVE_RE.test(text)) warnings.push('疑似包含密钥 / 敏感值：请使用环境变量，不要写入 config.yaml');
    try {
      const parsed = parseConfigText(text, 'web validation');
      if (parsed.legacy) warnings.push('旧版 schemaVersion 配置，请升级到 schemaVersion 4');
      const checked = configFileV4Schema.safeParse({ schemaVersion: 4, ...(parsed.file ?? {}) });
      if (!checked.success) {
        return { ok: false, errors: checked.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`), warnings: [...parsed.warnings, ...warnings] };
      }
      return { ok: warnings.length === 0, errors: [], warnings: [...parsed.warnings, ...warnings] };
    } catch (error) {
      return { ok: false, errors: [error instanceof Error ? error.message : String(error)], warnings };
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
      // L2 polish: one quality pass on accepted deterministic drafts; any failure keeps the draft.
      const polisher = buildPolisher(database);
      const polish = polisher !== undefined && candidate.model?.mode === 'deterministic' ? await polisher.polish(candidate) : null;
      const polished = polish !== null && polish.polished;
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
        title: polished ? polish.title : candidate.title,
        summary: polished ? polish.summary : candidate.summary,
        confidence: polished && polish.confidence !== undefined ? polish.confidence : candidate.confidence,
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
        payload: { memoryId: created.id, ...(polish === null ? {} : { polished }) },
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
      const since = optionalString(query.get('since'));
      const offset = Math.max(0, Number(query.get('offset') ?? '0') || 0);
      const limit = Math.min(500, Math.max(1, Number(query.get('limit') ?? '30') || 30));
      let records = (await new SqliteAuditLog(database).list()).map(compactAudit).reverse();
      if (actor !== undefined) records = records.filter((record) => record.actor === actor);
      if (eventType !== undefined) records = records.filter((record) => record.eventType.includes(eventType));
      if (subject !== undefined) records = records.filter((record) => record.subjectId === subject);
      if (since !== undefined) records = records.filter((record) => record.occurredAt >= since);
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
        adjudication: (() => {
          const raw = database.getMetadata(`garden-adjudication:${proposal.id}`);
          if (raw === null) return null;
          try {
            return JSON.parse(raw) as Record<string, unknown>;
          } catch {
            return null;
          }
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

  async function collectNow(): Promise<unknown> {
    const loaded = await loadWebConfig();
    const agents = loaded.config.agents.enabled;
    if (agents.length === 0) throw new HttpError(409, 'NO_AGENTS', '未启用任何 Agent（agents.enabled 为空），无可采集来源');
    const database = openDatabase();
    try {
      const jobIds: string[] = [];
      for (const agentId of agents) {
        const jobId = `job_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
        database.enqueueJob({ id: jobId, kind: 'source.ingest', payload: JSON.stringify({ event: 'manual', agentId }) });
        jobIds.push(jobId);
      }
      await new SqliteAuditLog(database).append({
        eventType: 'source.collect',
        actor: WEB_ACTOR.actor,
        ...(WEB_ACTOR.actorId === undefined ? {} : { actorId: WEB_ACTOR.actorId }),
        subjectType: 'source',
        subjectId: 'manual',
        occurredAt: now().toISOString(),
        reason: 'manual collection triggered via web workbench',
        payload: { agents, jobs: jobIds.length },
      });
      return { enqueued: jobIds.length, agents, jobIds };
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

  interface LlmUsageDay {
    day: string;
    calls: number;
    tokens: number;
    warned: boolean;
    consumers: Record<string, { calls: number; tokens: number }>;
  }

  async function llmUsage(): Promise<unknown> {
    const loaded = await loadWebConfig();
    const database = openDatabase();
    try {
      const days = database.listMetadata('llm-budget:')
        .map(({ key, value }): LlmUsageDay | null => {
          try {
            const parsed = JSON.parse(value) as { calls?: number; tokens?: number; warned?: boolean; consumers?: Record<string, { calls?: number; tokens?: number }> };
            return {
              day: key.slice('llm-budget:'.length),
              calls: parsed.calls ?? 0,
              tokens: parsed.tokens ?? 0,
              warned: parsed.warned === true,
              consumers: Object.fromEntries(Object.entries(parsed.consumers ?? {}).map(([name, usage]) => [name, { calls: usage.calls ?? 0, tokens: usage.tokens ?? 0 }])),
            };
          } catch {
            return null;
          }
        })
        .filter((item): item is LlmUsageDay => item !== null)
        .sort((left, right) => right.day.localeCompare(left.day))
        .slice(0, 7);
      const todayKey = now().toISOString().slice(0, 10);
      const today = days.find((item) => item.day === todayKey) ?? { day: todayKey, calls: 0, tokens: 0, warned: false, consumers: {} };
      const limits = {
        dailyCalls: loaded.config.llm.dailyCap ?? null,
        dailyTokens: loaded.config.llm.dailyTokens ?? null,
        perConsumerShare: loaded.config.llm.perConsumerShare ?? null,
        mode: loaded.config.llm.mode,
      };
      const hot = (used: number, limit: number | null): boolean => limit !== null && limit > 0 && used >= limit * 0.8;
      return { days, today, limits, warning: hot(today.calls, limits.dailyCalls) || hot(today.tokens, limits.dailyTokens) };
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
        daemon: await daemonStatus(brainPath),
        runtime: await webRuntimeInfo(),
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
          ...(options.llm?.dailyTokens === undefined ? {} : { dailyTokens: options.llm.dailyTokens }),
          ...(options.llm?.perConsumerShare === undefined ? {} : { perConsumerShare: options.llm.perConsumerShare }),
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

  async function webRuntimeInfo(): Promise<Record<string, unknown>> {
    let version = '0.1.0';
    for (const relative of ['../../../../package.json', '../../../package.json']) {
      try {
        const parsed = JSON.parse(await readFile(new URL(relative, import.meta.url), 'utf8')) as { name?: string; version?: string };
        if (parsed.name === 'taga' && typeof parsed.version === 'string') {
          version = parsed.version;
          break;
        }
      } catch { /* candidate miss: try the next location */ }
    }
    return { version, node: process.versions.node, platform: process.platform, arch: process.arch, pid: process.pid };
  }

  interface DoctorCheck {
    readonly id: string;
    readonly name: string;
    readonly ok: boolean;
    readonly status: string;
    readonly detail?: string;
  }

  async function systemDoctor(): Promise<unknown> {
    const checks: DoctorCheck[] = [];
    const database = openDatabase();
    try {
      const records = await new MarkdownMemoryRepository(brainPath).records();
      const integrity = database.integrityCheck();
      checks.push({ id: 'sqlite', name: 'SQLite / 完整性', ok: integrity.ok, status: integrity.ok ? 'ok' : 'failed', detail: `schemaVersion ${integrity.schemaVersion}` });
      const indexIds = new Set(database.listMemoryIndex().map((entry) => entry.id));
      const recordIds = records.map(({ memory }) => memory.id);
      const missing = recordIds.filter((id) => !indexIds.has(id)).length;
      const stale = [...indexIds].filter((id) => !recordIds.includes(id)).length;
      checks.push({ id: 'fts', name: 'FTS5 索引', ok: integrity.ok && missing === 0, status: `indexed ${indexIds.size}/${recordIds.length}` });
      checks.push({ id: 'drift', name: '索引漂移', ok: missing === 0 && stale === 0, status: missing === 0 && stale === 0 ? 'clean' : 'drifted', detail: `missing ${missing} · stale ${stale}` });
      let semanticStatus = 'unavailable';
      let zvecOk = false;
      let zvecDetail = '';
      try {
        const index = new ZvecMemoryIndex(join(brainPath, '.taga', 'semantic'));
        const integrityZvec = await index.integrity();
        semanticStatus = integrityZvec.activeGeneration === null ? 'not-built' : integrityZvec.ok ? 'ready' : 'degraded';
        zvecOk = true;
        zvecDetail = integrityZvec.activeGeneration === null
          ? '未构建（重建向量后可用）'
          : `generation ${String(integrityZvec.activeGeneration.generationId).slice(0, 8)} · ${integrityZvec.activeGeneration.dimensions}d`;
        index.close();
      } catch (error) {
        zvecDetail = error instanceof Error ? error.message : String(error);
      }
      checks.push({ id: 'semantic', name: '语义索引', ok: true, status: semanticStatus, detail: `semantic_mode=${options.semanticMode ?? 'off'}` });
      checks.push({ id: 'zvec', name: 'Zvec 运行时', ok: zvecOk, status: zvecOk ? 'ok' : 'failed', detail: zvecDetail });
      const daemon = await daemonStatus(brainPath);
      checks.push({
        id: 'daemon',
        name: 'daemon',
        ok: !daemon.stale,
        status: daemon.running ? 'running' : daemon.stale ? 'stale-lock' : 'stopped',
        detail: daemon.running ? `pid ${daemon.pid} · jobs ${daemon.health?.jobs.processed ?? 0}` : 'Fast Path 可独立工作',
      });
      const jobs = database.listJobs();
      const failedJobs = jobs.filter((job) => job.status === 'dead' || job.status === 'failed');
      checks.push({
        id: 'jobs',
        name: 'Jobs',
        ok: failedJobs.length === 0,
        status: failedJobs.length === 0 ? `${jobs.length} 个` : 'failed',
        detail: failedJobs.length === 0 ? '无失败任务' : `失败 ${failedJobs.length}：${failedJobs.map((job) => job.id).join(', ')}`,
      });
      const pendingRecovery = database.listMetadata('recovery:').filter(({ value }) => value !== 'complete');
      checks.push({
        id: 'recovery',
        name: '恢复流程',
        ok: pendingRecovery.length === 0,
        status: pendingRecovery.length === 0 ? 'clean' : 'pending',
        detail: pendingRecovery.length === 0 ? '派生数据可安全重建' : `${pendingRecovery.length} 项待恢复`,
      });
    } finally {
      database.close();
    }
    const extra = Object.entries(await platformHealth(brainPath)).map(([name, result]) => ({ name, ...result }));
    return {
      generatedAt: now().toISOString(),
      checks,
      extra,
      okCount: checks.filter((check) => check.ok).length,
      total: checks.length,
    };
  }

  function webDaemonEntryPath(): string {
    return process.env.TAGA_DAEMON_ENTRY ?? fileURLToPath(new URL('../../daemon/src/main.js', import.meta.url));
  }

  async function daemonRestart(ctx: RouteContext): Promise<unknown> {
    const body = requireRecord(ctx.body);
    if (body.confirm !== true) {
      throw new HttpError(409, 'CONFIRM_REQUIRED', 'daemon restart requires explicit confirmation');
    }
    const loaded = await loadWebConfig();
    const entry = webDaemonEntryPath();
    const managerOptions = { brainPath, configPath: loaded.configPath, daemonEntryPath: entry };
    let managed = false;
    if (process.platform === 'linux') {
      const manager = new SystemdUserServiceManager(managerOptions);
      if ((await manager.status()).installed) {
        await manager.restart();
        managed = true;
      }
    } else if (process.platform === 'darwin') {
      const manager = new LaunchdUserServiceManager(managerOptions);
      if ((await manager.status()).installed) {
        await manager.restart();
        managed = true;
      }
    }
    if (!managed) {
      await stopDaemon(brainPath);
      try {
        await startDaemonProcess(brainPath, entry, { ...process.env, TAGA_BRAIN: brainPath, TAGA_CONFIG: loaded.configPath }, 15_000);
      } catch (error) {
        // slow cold starts can miss the readiness window; accept a daemon that came up late
        const late = await daemonStatus(brainPath);
        if (!late.running) throw error;
      }
    }
    const database = openDatabase();
    try {
      await new SqliteAuditLog(database).append({
        eventType: 'daemon.restart',
        actor: WEB_ACTOR.actor,
        ...(WEB_ACTOR.actorId === undefined ? {} : { actorId: WEB_ACTOR.actorId }),
        subjectType: 'service',
        subjectId: 'daemon',
        occurredAt: now().toISOString(),
        reason: 'daemon restarted via web workbench',
        payload: { managed },
      });
    } finally {
      database.close();
    }
    return { ...(await daemonStatus(brainPath)), managed };
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
