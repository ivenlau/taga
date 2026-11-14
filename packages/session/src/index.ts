import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ContextPackBuilder, type ContextCandidate } from '../../context/src/index.js';
import type { ContextPack, Memory } from '../../domain/src/index.js';
import { FtsRetrievalProvider } from '../../retrieval/src/index.js';
import type { DatabaseStore, SessionObservation, SessionObservationInput } from '../../storage/src/index.js';

export interface SessionStartInput {
  readonly agentId: string;
  readonly sessionId: string;
  readonly projectId?: string;
  readonly cwd?: string;
  readonly task?: string;
  readonly tokenBudget?: number;
  readonly refresh?: boolean;
}

export interface SessionStartResult {
  readonly sessionId: string;
  readonly projectId?: string;
  readonly pack: ContextPack;
  readonly source: 'cache' | 'fts5';
  readonly stale: boolean;
  readonly cacheKey: string;
}

export interface SessionTimelineOptions {
  readonly memoryId?: string;
  readonly sessionId?: string;
  readonly taskId?: string;
  readonly projectId?: string;
  readonly limit?: number;
  readonly includeBody?: boolean;
}

export class SessionContextService {
  constructor(
    private readonly brainPath: string,
    private readonly database: DatabaseStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async start(input: SessionStartInput, records: readonly SessionMemoryRecord[]): Promise<SessionStartResult> {
    const memoryRevision = createHash('sha256')
      .update(records.map(({ memory }) => `${memory.id}:${memory.contentHash}:${memory.updated}`).sort().join('\n'))
      .digest('hex');
    const cacheKey = sessionCacheKey({ ...input, memoryRevision });
    const cachePath = this.cachePath(cacheKey);
    if (input.refresh !== true) {
      const cached = await readJson<ContextPack>(cachePath);
      if (cached !== null) {
        return {
          sessionId: input.sessionId,
          ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
          pack: cached,
          source: 'cache',
          stale: this.now().getTime() - Date.parse(cached.generatedAt) > 6 * 60 * 60 * 1000,
          cacheKey,
        };
      }
    }

    const candidates = this.rankCandidates(input, records);
    const pack = new ContextPackBuilder().build({
      agentId: input.agentId,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.task === undefined ? {} : { task: input.task }),
      channel: 'mcp',
      ...(input.tokenBudget === undefined ? {} : { tokenBudget: input.tokenBudget }),
      candidates,
    });
    await mkdir(join(this.brainPath, '.taga', 'context'), { recursive: true });
    await writeFile(cachePath, `${JSON.stringify(pack)}\n`, 'utf8');
    return {
      sessionId: input.sessionId,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      pack,
      source: 'fts5',
      stale: false,
      cacheKey,
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

  private rankCandidates(input: SessionStartInput, records: readonly SessionMemoryRecord[]): readonly ContextCandidate[] {
    if (input.task === undefined) return records.map(({ memory, body }) => ({ memory, body }));
    const byId = new Map(records.map((record) => [record.memory.id, record]));
    const ranked = new FtsRetrievalProvider(this.database).search({
      query: input.task,
      ...(input.projectId === undefined ? {} : { scope: { kind: 'project' as const, id: input.projectId } }),
      limit: 30,
    });
    const selected = ranked.flatMap((item) => {
      const record = byId.get(item.memory.id);
      return record === undefined ? [] : [{ memory: record.memory, body: record.body }];
    });
    return selected.length > 0 ? selected : records.map(({ memory, body }) => ({ memory, body }));
  }

  private cachePath(cacheKey: string): string {
    return join(this.brainPath, '.taga', 'context', `${cacheKey}.json`);
  }
}

export interface SessionMemoryRecord {
  readonly memory: Memory;
  readonly body: string;
}

export function sessionCacheKey(input: Pick<SessionStartInput, 'agentId' | 'projectId' | 'task'> & { readonly memoryRevision?: string }): string {
  return createHash('sha256')
    .update(JSON.stringify({ agentId: input.agentId, projectId: input.projectId ?? null, task: input.task ?? null, memoryRevision: input.memoryRevision ?? null }))
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

export function timelineEventForMemory(record: SessionObservation, memory: Memory): SessionObservation {
  if (record.memoryIds.includes(memory.id)) return record;
  return { ...record, memoryIds: [...record.memoryIds, memory.id] };
}
