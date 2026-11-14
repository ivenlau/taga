import { createHash } from 'node:crypto';
import {
  errorCodes,
  type Memory,
  TagaError,
} from '../../domain/src/index.js';
import type { DatabaseStore } from '../../storage/src/index.js';

export interface ProcedureMetadata {
  readonly schemaVersion: 1;
  readonly procedureId: string;
  readonly version: number;
  readonly prerequisites: readonly string[];
  readonly steps: readonly string[];
  readonly verification: readonly string[];
  readonly applicability: readonly string[];
  readonly safety: readonly string[];
  readonly risk: 'low' | 'medium' | 'high';
  readonly updatedAt: string;
}

export type ProcedureReuseKind = 'recall' | 'open' | 'cite' | 'useful' | 'verified' | 'not_useful';

export interface ProcedureReuseEvent {
  readonly id: string;
  readonly procedureId: string;
  readonly kind: ProcedureReuseKind;
  readonly projectId?: string;
  readonly taskId?: string;
  readonly occurredAt: string;
}

export interface ProcedureStats {
  readonly procedureId: string;
  readonly counts: Readonly<Record<ProcedureReuseKind, number>>;
  readonly verifiedRate: number;
}

export interface ProcedureSkillView {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly metadata: ProcedureMetadata;
  readonly sources: Memory['sources'];
  readonly scope: Memory['scope'];
}

export class ProcedureService {
  constructor(
    private readonly database: DatabaseStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  define(memory: Memory, input: Omit<ProcedureMetadata, 'schemaVersion' | 'procedureId' | 'version' | 'updatedAt'> & { readonly version?: number }): ProcedureMetadata {
    assertProcedure(memory);
    const current = this.get(memory.id);
    const metadata: ProcedureMetadata = {
      schemaVersion: 1,
      procedureId: memory.id,
      version: input.version ?? (current?.version ?? 0) + 1,
      prerequisites: [...input.prerequisites],
      steps: [...input.steps],
      verification: [...input.verification],
      applicability: [...input.applicability],
      safety: [...input.safety],
      risk: input.risk,
      updatedAt: this.clock().toISOString(),
    };
    this.database.upsertMetadata(`procedure:${memory.id}`, JSON.stringify(metadata));
    return metadata;
  }

  get(procedureId: string): ProcedureMetadata | null {
    const value = this.database.getMetadata(`procedure:${procedureId}`);
    if (value === null) return null;
    return parseMetadata(JSON.parse(value) as unknown);
  }

  list(): readonly ProcedureMetadata[] {
    return this.database.listMetadata('procedure:')
      .map(({ value }) => parseMetadata(JSON.parse(value) as unknown));
  }

  recall(memory: Memory, projectId?: string): ProcedureSkillView | null {
    assertProcedure(memory);
    if (memory.status !== 'active' || memory.visibility === 'excluded') return null;
    const metadata = this.get(memory.id);
    if (metadata === null || (projectId !== undefined && !appliesTo(metadata, projectId))) return null;
    return {
      id: memory.id,
      title: memory.title,
      summary: memory.summary,
      metadata,
      sources: memory.sources,
      scope: memory.scope,
    };
  }

  exportSkill(memory: Memory, projectId?: string): string | null {
    const view = this.recall(memory, projectId);
    return view === null ? null : JSON.stringify(view);
  }

  recordReuse(input: Omit<ProcedureReuseEvent, 'id' | 'occurredAt'> & { readonly id?: string; readonly occurredAt?: string }): ProcedureReuseEvent {
    const event: ProcedureReuseEvent = {
      id: input.id ?? stableEventId(input.procedureId, input.kind, input.projectId, input.taskId),
      procedureId: input.procedureId,
      kind: input.kind,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      occurredAt: input.occurredAt ?? this.clock().toISOString(),
    };
    this.database.upsertMetadata(`procedure-event:${event.id}`, JSON.stringify(event));
    return event;
  }

  stats(procedureId: string): ProcedureStats {
    const counts = emptyCounts();
    for (const event of this.events().filter((candidate) => candidate.procedureId === procedureId)) counts[event.kind] += 1;
    return {
      procedureId,
      counts,
      verifiedRate: counts.useful === 0 ? 0 : counts.verified / counts.useful,
    };
  }

  events(): readonly ProcedureReuseEvent[] {
    return this.database.listMetadata('procedure-event:')
      .map(({ value }) => parseEvent(JSON.parse(value) as unknown));
  }
}

function assertProcedure(memory: Memory): void {
  if (memory.type !== 'procedures') {
    throw new TagaError(errorCodes.validationFailed, 'memory is not a procedure', { id: memory.id });
  }
}

function appliesTo(metadata: ProcedureMetadata, projectId: string): boolean {
  return metadata.applicability.length === 0 || metadata.applicability.includes(projectId) || metadata.applicability.includes('*');
}

function emptyCounts(): Record<ProcedureReuseKind, number> {
  return { recall: 0, open: 0, cite: 0, useful: 0, verified: 0, not_useful: 0 };
}

function stableEventId(procedureId: string, kind: ProcedureReuseKind, projectId: string | undefined, taskId: string | undefined): string {
  return `procedure-event-${createHash('sha256').update([procedureId, kind, projectId ?? '', taskId ?? ''].join('\n')).digest('hex')}`;
}

function parseMetadata(value: unknown): ProcedureMetadata {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.procedureId !== 'string' || typeof value.version !== 'number' || !Array.isArray(value.steps) || !Array.isArray(value.prerequisites) || !Array.isArray(value.verification) || !Array.isArray(value.applicability) || !Array.isArray(value.safety) || !['low', 'medium', 'high'].includes(String(value.risk)) || typeof value.updatedAt !== 'string') {
    throw new TagaError(errorCodes.validationFailed, 'procedure metadata is invalid');
  }
  return {
    schemaVersion: 1,
    procedureId: value.procedureId,
    version: value.version,
    prerequisites: strings(value.prerequisites),
    steps: strings(value.steps),
    verification: strings(value.verification),
    applicability: strings(value.applicability),
    safety: strings(value.safety),
    risk: value.risk as ProcedureMetadata['risk'],
    updatedAt: value.updatedAt,
  };
}

function parseEvent(value: unknown): ProcedureReuseEvent {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.procedureId !== 'string' || typeof value.kind !== 'string' || !['recall', 'open', 'cite', 'useful', 'verified', 'not_useful'].includes(value.kind) || typeof value.occurredAt !== 'string') {
    throw new TagaError(errorCodes.validationFailed, 'procedure reuse event is invalid');
  }
  return {
    id: value.id,
    procedureId: value.procedureId,
    kind: value.kind as ProcedureReuseKind,
    ...(typeof value.projectId === 'string' ? { projectId: value.projectId } : {}),
    ...(typeof value.taskId === 'string' ? { taskId: value.taskId } : {}),
    occurredAt: value.occurredAt,
  };
}

function strings(value: unknown[]): string[] {
  return value.filter((item): item is string => typeof item === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

