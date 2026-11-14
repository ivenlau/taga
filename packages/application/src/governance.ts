import { createHash } from 'node:crypto';
import {
  errorCodes,
  parseMemory,
  transitionMemory,
  type Memory,
  type MemoryCommand,
  type Scope,
  TagaError,
} from '../../domain/src/index.js';

export interface MemoryRepository {
  get(id: string): Promise<Memory | null>;
  list(): Promise<Memory[]>;
  save(memory: Memory): Promise<void>;
}

export interface AuditInput {
  readonly eventType: string;
  readonly actor: 'user' | 'agent' | 'system' | 'daemon';
  readonly actorId?: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly occurredAt: string;
  readonly reason: string;
  readonly payload?: Record<string, unknown>;
}

export interface AuditRecord extends AuditInput {
  readonly eventHash: string;
  readonly prevHash?: string;
}

export interface AuditLog {
  append(input: AuditInput): Promise<AuditRecord>;
  list(): Promise<AuditRecord[]>;
}

export interface LifecycleActor {
  readonly actor: AuditInput['actor'];
  readonly actorId?: string;
}

export type MemoryFeedbackKind = 'useful' | 'not_useful' | 'verified' | 'conflict' | 'cite' | 'outcome';

export interface FeedbackPolicy {
  readonly confidenceDelta: Readonly<Record<MemoryFeedbackKind, number>>;
  readonly staleAfterInvalidCount: number;
}

export const DEFAULT_FEEDBACK_POLICY: FeedbackPolicy = {
  confidenceDelta: { useful: 0.04, cite: 0.02, verified: 0.08, outcome: 0.06, not_useful: -0.08, conflict: -0.12 },
  staleAfterInvalidCount: 3,
};

export type MemoryCreateInput = Memory;

export type MemoryEdit = Partial<Pick<
  Memory,
  'type' | 'scope' | 'projectId' | 'title' | 'summary' | 'confidence' | 'sourceTrust' |
  'visibility' | 'sources' | 'anchors' | 'tags' | 'contentHash'
>>;

export class GovernanceService {
  constructor(
    private readonly repository: MemoryRepository,
    private readonly audit: AuditLog,
    private readonly clock: () => Date = () => new Date(),
    private readonly feedbackPolicy: FeedbackPolicy = DEFAULT_FEEDBACK_POLICY,
  ) {}

  async create(input: MemoryCreateInput, actor: LifecycleActor, reason: string): Promise<Memory> {
    const memory = parseMemory({
      ...input,
      status: actor.actor === 'agent' && input.status === 'active' ? 'draft' : input.status,
    });
    await this.repository.save(memory);
    await this.record('memory.created', memory, actor, reason);
    return memory;
  }

  async edit(
    id: string,
    newId: string,
    changes: MemoryEdit,
    actor: LifecycleActor,
    reason: string,
  ): Promise<Memory> {
    const current = await this.requireMemory(id);
    const now = this.clock().toISOString();
    const next = parseMemory({
      ...current,
      ...changes,
      id: newId,
      status: 'draft',
      created: now,
      updated: now,
      supersedes: current.id,
    });
    const superseded = transitionMemory(current, { type: 'supersede', replacementId: newId });
    await this.repository.save(superseded);
    await this.repository.save(next);
    await this.record('memory.superseded', superseded, actor, reason, { replacementId: newId });
    await this.record('memory.version_created', next, actor, reason, { supersedes: current.id });
    return next;
  }

  async transition(
    id: string,
    command: MemoryCommand,
    actor: LifecycleActor,
    reason: string,
  ): Promise<Memory> {
    const current = await this.requireMemory(id);
    const next = transitionMemory(current, command);
    await this.repository.save(next);
    await this.record(`memory.${command.type}`, next, actor, reason);
    return next;
  }

  async forget(id: string, actor: LifecycleActor, reason: string, confirmed: boolean): Promise<Memory> {
    if (!confirmed) {
      throw new TagaError(errorCodes.validationFailed, 'forget requires explicit confirmation');
    }
    return this.transition(id, { type: 'forget', confirmed: true }, actor, reason);
  }

  async feedback(
    id: string,
    kind: MemoryFeedbackKind,
    actor: LifecycleActor,
    reason: string,
    context: Record<string, unknown> = {},
  ): Promise<Memory> {
    const current = await this.requireMemory(id);
    const now = this.clock().toISOString();
    const confidenceDelta = this.feedbackPolicy.confidenceDelta[kind];
    const invalidCount = current.notUsefulCount + (kind === 'not_useful' || kind === 'conflict' ? 1 : 0);
    const markStale = current.status === 'active' && invalidCount >= this.feedbackPolicy.staleAfterInvalidCount;
    const next = parseMemory({
      ...current,
      status: markStale ? 'stale' : current.status,
      updated: now,
      confidence: Math.round(Math.min(1, Math.max(0, current.confidence + confidenceDelta)) * 10_000) / 10_000,
      usefulCount: current.usefulCount + (kind === 'useful' ? 1 : 0),
      notUsefulCount: invalidCount,
      reviewCount: current.reviewCount + 1,
      lastVerified: kind === 'verified' || kind === 'outcome' ? now : current.lastVerified,
      lastRecalled: kind === 'cite' ? now : current.lastRecalled,
    });
    await this.repository.save(next);
    await this.record('memory.feedback', next, actor, reason, {
      kind,
      confidenceBefore: current.confidence,
      confidenceAfter: next.confidence,
      confidenceDelta,
      freshnessBefore: current.lastVerified ?? current.updated,
      freshnessAfter: next.lastVerified ?? next.updated,
      stale: markStale,
      ...context,
    });
    if (markStale) await this.record('memory.mark_stale', next, actor, 'feedback stale threshold reached', { invalidCount });
    return next;
  }

  private async requireMemory(id: string): Promise<Memory> {
    const memory = await this.repository.get(id);
    if (memory === null) {
      throw new TagaError(errorCodes.notFound, 'memory not found', { id });
    }
    return memory;
  }

  private async record(
    eventType: string,
    memory: Memory,
    actor: LifecycleActor,
    reason: string,
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    const input: AuditInput = {
      eventType,
      actor: actor.actor,
      subjectType: 'memory',
      subjectId: memory.id,
      occurredAt: this.clock().toISOString(),
      reason,
      payload,
      ...(actor.actorId === undefined ? {} : { actorId: actor.actorId }),
    };
    await this.audit.append(input);
  }
}

export function isDefaultRecallEligible(memory: Memory): boolean {
  return memory.status === 'active' && memory.visibility !== 'excluded';
}

export function scopeWeight(scope: Scope): number {
  switch (scope.kind) {
    case 'project':
      return 1;
    case 'domain':
      return 0.8;
    case 'global':
      return 0.6;
  }
}

export function compareScope(left: Scope, right: Scope): number {
  return scopeWeight(right) - scopeWeight(left);
}

export class InMemoryMemoryRepository implements MemoryRepository {
  private readonly memories = new Map<string, Memory>();

  get(id: string): Promise<Memory | null> {
    return Promise.resolve(this.memories.get(id) ?? null);
  }

  list(): Promise<Memory[]> {
    return Promise.resolve([...this.memories.values()]);
  }

  save(memory: Memory): Promise<void> {
    this.memories.set(memory.id, memory);
    return Promise.resolve();
  }
}

export class InMemoryAuditLog implements AuditLog {
  private readonly records: AuditRecord[] = [];

  append(input: AuditInput): Promise<AuditRecord> {
    const previous = this.records.at(-1);
    const recordWithoutHash = {
      ...input,
      ...(previous === undefined ? {} : { prevHash: previous.eventHash }),
    };
    const eventHash = createHash('sha256')
      .update(JSON.stringify(recordWithoutHash), 'utf8')
      .digest('hex');
    const record: AuditRecord = { ...recordWithoutHash, eventHash };
    this.records.push(record);
    return Promise.resolve(record);
  }

  list(): Promise<AuditRecord[]> {
    return Promise.resolve([...this.records]);
  }
}
