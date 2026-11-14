import { relative } from 'node:path';
import type { Memory, MemoryStatus, MemoryType, Scope } from '../../domain/src/index.js';
import type { DatabaseStore } from '../../storage/src/index.js';
import { MarkdownMemoryRepository, type StoredMemory } from '../../storage/src/index.js';
import { FtsRetrievalProvider } from '../../retrieval/src/index.js';

export interface BrowseFilter {
  readonly type?: MemoryType;
  readonly status?: MemoryStatus;
  readonly projectId?: string;
  readonly scope?: Scope['kind'];
  readonly includeExcluded?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

export interface BrowsePage<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly nextOffset?: number;
}

export interface BrainSummary {
  readonly total: number;
  readonly byType: Readonly<Record<MemoryType, number>>;
  readonly byStatus: Readonly<Record<MemoryStatus, number>>;
  readonly projects: readonly string[];
}

export interface BrainDetail {
  readonly memory: Memory;
  readonly path: string;
  readonly body?: string;
  readonly related: readonly { id: string; type: MemoryType; title: string; relationship: string }[];
  readonly evidence: readonly { id: string; source: string; occurredAt: string; sensitivity: string }[];
  readonly audit: readonly { eventType: string; actor: string; occurredAt: string; reason?: string }[];
}

export class BrainBrowser {
  constructor(
    private readonly brainPath: string,
    private readonly database: DatabaseStore,
  ) {}

  async tree(): Promise<readonly string[]> {
    const records = await this.records();
    return records.filter(({ memory }) => browseable(memory)).map((record) => relative(this.brainPath, record.path));
  }

  async list(filter: BrowseFilter = {}): Promise<BrowsePage<Memory>> {
    const records = await this.records();
    const filtered = records
      .map(({ memory }) => memory)
      .filter((memory) => filter.status !== undefined || memory.status !== 'forgotten')
      .filter((memory) => filter.includeExcluded === true || memory.visibility !== 'excluded')
      .filter((memory) => filter.type === undefined || memory.type === filter.type)
      .filter((memory) => filter.status === undefined || memory.status === filter.status)
      .filter((memory) => filter.projectId === undefined || memory.projectId === filter.projectId)
      .filter((memory) => filter.scope === undefined || memory.scope.kind === filter.scope)
      .sort((left, right) => left.id.localeCompare(right.id));
    return page(filtered, filter.offset, filter.limit);
  }

  async summary(): Promise<BrainSummary> {
    const memories = (await this.records()).map(({ memory }) => memory).filter((memory) => browseable(memory));
    const byType = emptyCounts<MemoryType>(['preferences', 'environment', 'procedures', 'lessons', 'projects']);
    const byStatus = emptyCounts<MemoryStatus>(['candidate', 'draft', 'active', 'stale', 'superseded', 'forgotten']);
    const projects = new Set<string>();
    for (const memory of memories) {
      byType[memory.type] += 1;
      byStatus[memory.status] += 1;
      if (memory.projectId !== undefined && memory.projectId !== null) projects.add(memory.projectId);
    }
    return { total: memories.length, byType, byStatus, projects: [...projects].sort() };
  }

  async detail(id: string, options: { readonly includeBody?: boolean; readonly includeEvidence?: boolean } = {}): Promise<BrainDetail | null> {
    const record = (await this.records()).find((candidate) => candidate.memory.id === id);
    if (record === undefined) return null;
    if (record.memory.status === 'forgotten' || record.memory.visibility === 'excluded') return null;
    const related = (await this.records())
      .filter(({ memory }) => browseable(memory) && memory.id !== id && relatedTo(record.memory, memory))
      .concat((await this.records()).filter(({ memory }) => memory.supersedes === id || record.memory.supersedes === memory.id))
      .filter(({ memory }) => browseable(memory))
      .filter(({ memory }, index, all) => all.findIndex((candidate) => candidate.memory.id === memory.id) === index)
      .map(({ memory }) => ({ id: memory.id, type: memory.type, title: memory.title, relationship: relation(record.memory, memory) }));
    const audit = this.database.listAuditEvents()
      .filter((event) => event.subjectId === id)
      .map((event) => {
        const reason = readReason(event.payload);
        return {
          eventType: event.eventType,
          actor: event.actor,
          occurredAt: event.occurredAt,
          ...(reason === undefined ? {} : { reason }),
        };
      });
    const evidence = options.includeEvidence === true
      ? this.database.listEvidence()
        .filter((event) => event.projectId === record.memory.projectId || event.refs.some((ref) => record.memory.sources.some((source) => ref.locator === source.locator || ref.hash === source.hash)))
        .map((event) => ({ id: event.id, source: event.source, occurredAt: event.occurredAt, sensitivity: event.sensitivity }))
      : [];
    return {
      memory: record.memory,
      path: record.path,
      ...(options.includeBody === true ? { body: record.body } : {}),
      related,
      evidence,
      audit,
    };
  }

  async rebuildRelations(): Promise<{ readonly memories: number; readonly index: number }> {
    const records = await this.records();
    new FtsRetrievalProvider(this.database).rebuild(records);
    return { memories: records.length, index: this.database.listMemoryIndex().length };
  }

  private async records(): Promise<readonly StoredMemory[]> {
    return new MarkdownMemoryRepository(this.brainPath).records();
  }
}

function page<T>(items: readonly T[], offset = 0, limit = 50): BrowsePage<T> {
  const normalizedOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0;
  const normalizedLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50;
  const result = items.slice(normalizedOffset, normalizedOffset + normalizedLimit);
  return {
    items: result,
    total: items.length,
    offset: normalizedOffset,
    limit: normalizedLimit,
    ...(normalizedOffset + result.length < items.length ? { nextOffset: normalizedOffset + result.length } : {}),
  };
}

function emptyCounts<T extends string>(keys: readonly T[]): Record<T, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
}

function relatedTo(left: Memory, right: Memory): boolean {
  return left.projectId !== undefined && left.projectId !== null && left.projectId === right.projectId
    || left.scope.kind === 'project' && right.scope.kind === 'project' && left.scope.id === right.scope.id
    || left.type === 'projects' && right.projectId === left.id
    || right.type === 'projects' && left.projectId === right.id;
}

function browseable(memory: Memory): boolean {
  return memory.status !== 'forgotten' && memory.visibility !== 'excluded';
}

function relation(left: Memory, right: Memory): string {
  if (left.type === 'projects' || right.type === 'projects') return 'project';
  if (left.type === 'procedures' || right.type === 'procedures') return 'procedure';
  if (left.type === 'lessons' || right.type === 'lessons') return 'lesson';
  return 'same-project';
}

function readReason(payload: string): string | undefined {
  try {
    const value: unknown = JSON.parse(payload);
    return typeof value === 'object' && value !== null && 'reason' in value && typeof value.reason === 'string'
      ? value.reason
      : undefined;
  } catch {
    return undefined;
  }
}
