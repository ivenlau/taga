import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ContextPackBuilder, type ContextCandidate, type DomainContextContribution } from '../../context/src/index.js';
import { contextPackSchema, type ContextPack, type Memory } from '../../domain/src/index.js';
import { FtsRetrievalProvider, type HybridRecallCandidate, type SemanticRetriever } from '../../retrieval/src/index.js';
import type { DatabaseStore, SessionObservation, SessionObservationInput } from '../../storage/src/index.js';

export interface SessionStartInput {
  readonly agentId: string;
  readonly sessionId: string;
  readonly projectId?: string;
  readonly cwd?: string;
  readonly task?: string;
  readonly tokenBudget?: number;
  readonly refresh?: boolean;
  readonly channel?: 'mcp' | 'static';
  readonly domainContributions?: readonly DomainContextContribution[];
}

export interface SessionStartResult {
  readonly sessionId: string;
  readonly projectId?: string;
  readonly pack: ContextPack;
  readonly source: 'cache' | 'fts5' | 'hybrid' | 'all';
  readonly stale: boolean;
  readonly cacheKey: string;
  /** True when semantic retrieval was expected but unavailable, leaving a lexical-only selection. */
  readonly degraded: boolean;
}

export interface SessionTimelineOptions {
  readonly memoryId?: string;
  readonly sessionId?: string;
  readonly taskId?: string;
  readonly projectId?: string;
  readonly limit?: number;
  readonly includeBody?: boolean;
}

const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export class SessionContextService {
  constructor(
    private readonly brainPath: string,
    private readonly database: DatabaseStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async start(input: SessionStartInput, records: readonly SessionMemoryRecord[], semantic?: SemanticRetriever): Promise<SessionStartResult> {
    const memoryRevision = createHash('sha256')
      .update(records.map(({ memory }) => `${memory.id}:${memory.contentHash}:${memory.updated}`).sort().join('\n'))
      .digest('hex');
    const cacheKey = sessionCacheKey({ ...input, memoryRevision });
    const cachePath = this.cachePath(cacheKey);
    if (input.refresh !== true) {
      const cached = contextPackSchema.safeParse(await readJson<unknown>(cachePath));
      if (cached.success) {
        return {
          sessionId: input.sessionId,
          ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
          pack: cached.data,
          source: 'cache',
          stale: this.now().getTime() - Date.parse(cached.data.generatedAt) > 6 * 60 * 60 * 1000,
          cacheKey,
          degraded: false,
        };
      }
    }

    const selection = await selectContextCandidates(this.database, input, records, semantic);
    const pack = new ContextPackBuilder().build({
      agentId: input.agentId,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.task === undefined ? {} : { task: input.task }),
      channel: input.channel ?? 'mcp',
      ...(input.tokenBudget === undefined ? {} : { tokenBudget: input.tokenBudget }),
      candidates: selection.candidates,
      ...(input.domainContributions === undefined ? {} : { domainContributions: input.domainContributions }),
    }, this.now());
    const cacheDir = join(this.brainPath, '.taga', 'context');
    await mkdir(cacheDir, { recursive: true });
    await writeFile(cachePath, `${JSON.stringify(pack)}\n`, 'utf8');
    await evictStaleCaches(cacheDir, this.now().getTime());
    return {
      sessionId: input.sessionId,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      pack,
      source: selection.source,
      stale: false,
      cacheKey,
      degraded: selection.degraded,
    };
  }

  recordObservation(input: SessionObservationInput): boolean {
    return this.database.saveSessionObservation(input);
  }

  timeline(options: SessionTimelineOptions = {}): readonly SessionObservation[] {
    const records = this.database.listSessionObservations(options);
    return records.map((record) => {
      if (options.includeBody === true || record.visibility !== 'normal') return record;
      return {
        id: record.id,
        sessionId: record.sessionId,
        ...(record.taskId === undefined ? {} : { taskId: record.taskId }),
        ...(record.projectId === undefined ? {} : { projectId: record.projectId }),
        occurredAt: record.occurredAt,
        sequence: record.sequence,
        kind: record.kind,
        summary: record.summary,
        memoryIds: record.memoryIds,
        sourceRefs: record.sourceRefs,
        contentHash: record.contentHash,
        visibility: record.visibility,
        createdAt: record.createdAt,
      };
    });
  }

  private cachePath(cacheKey: string): string {
    return join(this.brainPath, '.taga', 'context', `${cacheKey}.json`);
  }
}

export interface SessionMemoryRecord {
  readonly memory: Memory;
  readonly body: string;
}

export interface SelectCandidatesResult {
  readonly candidates: readonly ContextCandidate[];
  readonly source: 'fts5' | 'hybrid' | 'all';
  /** True when semantic retrieval failed and only lexical hits were selected. */
  readonly degraded: boolean;
}

export async function selectContextCandidates(
  database: DatabaseStore,
  input: { readonly task?: string; readonly projectId?: string },
  records: readonly SessionMemoryRecord[],
  semantic?: SemanticRetriever,
): Promise<SelectCandidatesResult> {
  const fallback = (): SelectCandidatesResult => ({
    candidates: records.map(({ memory, body }): ContextCandidate => ({ memory, body })),
    source: 'all',
    degraded: false,
  });
  if (input.task === undefined) return fallback();
  const byId = new Map(records.map((record) => [record.memory.id, record]));
  const retrieval = await new FtsRetrievalProvider(database).searchHybrid({
    query: input.task,
    ...(input.projectId === undefined ? {} : { scope: { kind: 'project' as const, id: input.projectId } }),
    limit: 30,
  }, semantic);
  const maxScore = Math.max(1, ...retrieval.items.map((item) => item.score));
  const lexicalScores = retrieval.items.flatMap((item) => {
    const score = lexicalWeightOf(item);
    return score === undefined ? [] : [score];
  });
  const maxLexical = Math.max(0, ...lexicalScores);
  const selected = retrieval.items.flatMap((item): ContextCandidate[] => {
    const record = byId.get(item.memory.id);
    if (record === undefined) return [];
    const lexicalScore = lexicalWeightOf(item);
    return [{
      memory: record.memory,
      body: record.body,
      score: item.score / maxScore,
      relevance: {
        ...(lexicalScore === undefined || maxLexical <= 0 ? {} : { lexical: lexicalScore / maxLexical }),
        ...(item.semanticScore === undefined ? {} : { semanticDistance: Math.max(0, 1 / item.semanticScore - 1) }),
      },
    }];
  });
  // Even an empty selection must report that semantic retrieval failed, or callers cannot tell why the pack fell back.
  if (selected.length === 0) return { ...fallback(), degraded: retrieval.degraded };
  return { candidates: selected, source: retrieval.semanticAvailable ? 'hybrid' : 'fts5', degraded: retrieval.degraded };
}

/** The weighted FTS score behind a hit; hybrid fusion keeps it beside the fused rank, lexical-only hits only have `score`. */
function lexicalWeightOf(item: HybridRecallCandidate): number | undefined {
  return item.lexicalScore ?? (item.semanticScore === undefined && item.source === 'fts5' ? item.score : undefined);
}

export function sessionCacheKey(input: Pick<SessionStartInput, 'agentId' | 'projectId' | 'task' | 'channel' | 'domainContributions'> & { readonly memoryRevision?: string }): string {
  return createHash('sha256')
    .update(JSON.stringify({
      agentId: input.agentId,
      projectId: input.projectId ?? null,
      task: input.task ?? null,
      channel: input.channel ?? 'mcp',
      contributions: input.domainContributions ?? null,
      memoryRevision: input.memoryRevision ?? null,
    }))
    .digest('hex');
}

export function observationContentHash(input: Pick<SessionObservationInput, 'sessionId' | 'sequence' | 'kind' | 'summary'>): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(input)).digest('hex')}`;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function evictStaleCaches(dir: string, nowMs: number): Promise<void> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const path = join(dir, entry);
    const info = await stat(path).catch(() => null);
    if (info !== null && nowMs - info.mtimeMs > CACHE_MAX_AGE_MS) {
      await unlink(path).catch(() => undefined);
    }
  }
}

export function timelineEventForMemory(record: SessionObservation, memory: Memory): SessionObservation {
  if (record.memoryIds.includes(memory.id)) return record;
  return { ...record, memoryIds: [...record.memoryIds, memory.id] };
}
