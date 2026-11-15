import { createHash } from 'node:crypto';
import {
  GovernanceService,
  type AuditLog,
  type LifecycleActor,
  type MemoryRepository,
} from '../../application/src/index.js';
import type { Memory } from '../../domain/src/index.js';
import type { DatabaseStore } from '../../storage/src/index.js';

export type GardenCategory = 'duplicate' | 'stale' | 'conflict';
export type GardenProposalStatus = 'pending' | 'accepted' | 'rejected' | 'ignored';
export type GardenAction = 'mark_stale' | 'review_duplicate' | 'review_conflict' | 'supersede';

export interface GardenEvidence {
  readonly memoryIds: readonly string[];
  readonly contentHashes: readonly string[];
  readonly sourceCount: number;
}

export interface GardenProposal {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly category: GardenCategory;
  readonly affectedIds: readonly string[];
  readonly evidence: GardenEvidence;
  readonly score: number;
  readonly threshold: number;
  readonly reason: string;
  readonly suggestedAction: GardenAction;
  readonly fingerprint: string;
  readonly status: GardenProposalStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly reviewedAt?: string;
  readonly reviewAction?: GardenAction;
}

export interface GardenRunReport {
  readonly proposals: readonly GardenProposal[];
  readonly unchanged: number;
  readonly degraded: boolean;
  readonly warnings: readonly string[];
}

export interface GardenOptions {
  readonly clock?: () => Date;
  readonly staleAfterMs?: number;
  readonly thresholds?: Partial<Record<GardenCategory, number>>;
}

export interface GardenReviewOptions {
  readonly repository: MemoryRepository;
  readonly audit: AuditLog;
  readonly actor: LifecycleActor;
  readonly action?: GardenAction;
  readonly targetId?: string;
  readonly replacementId?: string;
}

export class GardenService {
  private readonly clock: () => Date;
  private readonly staleAfterMs: number;
  private readonly thresholds: Record<GardenCategory, number>;

  constructor(
    private readonly database: DatabaseStore,
    options: GardenOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.staleAfterMs = options.staleAfterMs ?? 90 * 24 * 60 * 60 * 1000;
    this.thresholds = {
      duplicate: options.thresholds?.duplicate ?? 0.95,
      stale: options.thresholds?.stale ?? 0.8,
      conflict: options.thresholds?.conflict ?? 0.75,
    };
  }

  scan(memories: readonly Memory[]): GardenRunReport {
    const visible = memories.filter((memory) => memory.status !== 'forgotten' && memory.visibility !== 'excluded');
    const candidates = [
      ...duplicateProposals(visible, this.thresholds.duplicate, this.clock()),
      ...staleProposals(visible, this.thresholds.stale, this.clock(), this.staleAfterMs),
      ...conflictProposals(visible, this.thresholds.conflict, this.clock()),
    ];
    const proposals: GardenProposal[] = [];
    let unchanged = 0;
    for (const candidate of candidates) {
      const current = this.get(candidate.id);
      if (current !== null) {
        unchanged += 1;
        continue;
      }
      this.database.upsertMetadata(`garden:proposal:${candidate.id}`, JSON.stringify(candidate));
      proposals.push(candidate);
    }
    return { proposals, unchanged, degraded: false, warnings: [] };
  }

  scanSafe(memories: readonly Memory[]): GardenRunReport {
    try {
      return this.scan(memories);
    } catch (error) {
      return { proposals: [], unchanged: 0, degraded: true, warnings: [errorMessage(error)] };
    }
  }

  recordSemanticDuplicate(input: {
    readonly draft: Memory;
    readonly existing: Memory;
    readonly score: number;
    readonly threshold: number;
    readonly verdict: 'duplicate' | 'merge';
  }): GardenProposal {
    const reason = input.verdict === 'duplicate'
      ? `draft is a semantic near-duplicate of an active memory (cosine ${input.score.toFixed(4)})`
      : `draft overlaps an active memory; merge review suggested (cosine ${input.score.toFixed(4)})`;
    return this.recordProposal({
      category: 'duplicate',
      affectedIds: [input.draft.id, input.existing.id],
      evidence: evidenceFor([input.draft, input.existing]),
      score: input.score,
      threshold: input.threshold,
      reason,
      suggestedAction: 'review_duplicate',
    });
  }

  recordProposal(input: {
    readonly category: GardenCategory;
    readonly affectedIds: readonly string[];
    readonly evidence: GardenEvidence;
    readonly score: number;
    readonly threshold: number;
    readonly reason: string;
    readonly suggestedAction: GardenAction;
  }): GardenProposal {
    const candidate = proposal({ ...input, now: this.clock() });
    const current = this.get(candidate.id);
    if (current !== null) return current;
    this.database.upsertMetadata(`garden:proposal:${candidate.id}`, JSON.stringify(candidate));
    return candidate;
  }

  get(id: string): GardenProposal | null {
    const value = this.database.getMetadata(`garden:proposal:${id}`);
    return value === null ? null : parseProposal(JSON.parse(value) as unknown);
  }

  list(status?: GardenProposalStatus): readonly GardenProposal[] {
    return this.database.listMetadata('garden:proposal:')
      .map(({ value }) => parseProposal(JSON.parse(value) as unknown))
      .filter((proposal) => status === undefined || proposal.status === status)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async review(id: string, decision: Exclude<GardenProposalStatus, 'pending'>, options: GardenReviewOptions): Promise<GardenProposal> {
    const current = this.get(id);
    if (current === null) throw new Error(`garden proposal not found: ${id}`);
    if (current.status !== 'pending') throw new Error(`garden proposal is already ${current.status}`);
    const action = options.action ?? current.suggestedAction;
    if (decision === 'accepted') {
      await applyAcceptedAction(current, action, options);
    }
    const now = this.clock().toISOString();
    const next: GardenProposal = {
      ...current,
      status: decision,
      updatedAt: now,
      reviewedAt: now,
      ...(decision === 'accepted' ? { reviewAction: action } : {}),
    };
    this.database.upsertMetadata(`garden:proposal:${id}`, JSON.stringify(next));
    await options.audit.append({
      eventType: `garden.proposal.${decision}`,
      actor: options.actor.actor,
      ...(options.actor.actorId === undefined ? {} : { actorId: options.actor.actorId }),
      subjectType: 'garden_proposal',
      subjectId: id,
      occurredAt: now,
      reason: `garden proposal ${decision}`,
      payload: {
        category: current.category,
        affectedIds: current.affectedIds,
        action,
      },
    });
    return next;
  }
}

async function applyAcceptedAction(
  proposal: GardenProposal,
  action: GardenAction,
  options: GardenReviewOptions,
): Promise<void> {
  if (action === 'mark_stale') {
    const targetId = options.targetId ?? proposal.affectedIds[0];
    if (targetId === undefined || !proposal.affectedIds.includes(targetId)) throw new Error('garden stale action requires an affected target');
    await new GovernanceService(options.repository, options.audit).transition(
      targetId,
      { type: 'mark_stale' },
      options.actor,
      'accepted garden stale proposal',
    );
    return;
  }
  if (action === 'supersede') {
    const targetId = options.targetId ?? proposal.affectedIds[0];
    const replacementId = options.replacementId;
    if (targetId === undefined || replacementId === undefined || !proposal.affectedIds.includes(targetId)) throw new Error('garden supersede action requires target and replacement');
    await new GovernanceService(options.repository, options.audit).transition(
      targetId,
      { type: 'supersede', replacementId },
      options.actor,
      'accepted garden supersede proposal',
    );
  }
}

function duplicateProposals(memories: readonly Memory[], threshold: number, now: Date): GardenProposal[] {
  const groups = groupBy(memories.filter((memory) => memory.status === 'active'), (memory) => memory.contentHash);
  return groups.flatMap((group) => {
    if (group.length < 2) return [];
    return pairwise(group).map(([left, right]) => proposal({
      category: 'duplicate',
      affectedIds: [left.id, right.id],
      evidence: evidenceFor([left, right]),
      score: 1,
      threshold,
      reason: 'active memories have the same content hash',
      suggestedAction: 'review_duplicate',
      now,
    }));
  });
}

function staleProposals(memories: readonly Memory[], threshold: number, now: Date, staleAfterMs: number): GardenProposal[] {
  return memories
    .filter((memory) => memory.status === 'active')
    .filter((memory) => memory.expiresAt !== undefined && memory.expiresAt !== null && Date.parse(memory.expiresAt) <= now.getTime() || now.getTime() - Date.parse(memory.updated) >= staleAfterMs)
    .map((memory) => proposal({
      category: 'stale',
      affectedIds: [memory.id],
      evidence: evidenceFor([memory]),
      score: 1,
      threshold,
      reason: memory.expiresAt !== undefined && memory.expiresAt !== null && Date.parse(memory.expiresAt) <= now.getTime() ? 'memory has expired' : 'memory has not been updated within the configured freshness window',
      suggestedAction: 'mark_stale',
      now,
    }));
}

function conflictProposals(memories: readonly Memory[], threshold: number, now: Date): GardenProposal[] {
  const groups = groupBy(memories.filter((memory) => memory.status === 'active'), (memory) => `${memory.type}:${memory.scope.kind}:${memory.scope.kind === 'global' ? '' : memory.scope.id}:${normalize(memory.title)}`);
  return groups.flatMap((group) => {
    const distinct = group.filter((memory, index, all) => all.findIndex((candidate) => candidate.contentHash === memory.contentHash) === index);
    if (distinct.length < 2) return [];
    return pairwise(distinct).map(([left, right]) => proposal({
      category: 'conflict',
      affectedIds: [left.id, right.id],
      evidence: evidenceFor([left, right]),
      score: 0.8,
      threshold,
      reason: 'active memories share a scope and title but have different content hashes',
      suggestedAction: 'review_conflict',
      now,
    }));
  });
}

function proposal(input: {
  readonly category: GardenCategory;
  readonly affectedIds: readonly string[];
  readonly evidence: GardenEvidence;
  readonly score: number;
  readonly threshold: number;
  readonly reason: string;
  readonly suggestedAction: GardenAction;
  readonly now: Date;
}): GardenProposal {
  const fingerprint = createHash('sha256').update(JSON.stringify({
    category: input.category,
    affectedIds: [...input.affectedIds].sort(),
    contentHashes: [...input.evidence.contentHashes].sort(),
    reason: input.reason,
  })).digest('hex');
  const id = `garden-${fingerprint}`;
  const timestamp = input.now.toISOString();
  return {
    schemaVersion: 1,
    id,
    category: input.category,
    affectedIds: input.affectedIds,
    evidence: input.evidence,
    score: input.score,
    threshold: input.threshold,
    reason: input.reason,
    suggestedAction: input.suggestedAction,
    fingerprint,
    status: 'pending',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function evidenceFor(memories: readonly Memory[]): GardenEvidence {
  return {
    memoryIds: memories.map((memory) => memory.id),
    contentHashes: memories.map((memory) => memory.contentHash),
    sourceCount: memories.reduce((count, memory) => count + memory.sources.length, 0),
  };
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(key(item)) ?? [];
    group.push(item);
    groups.set(key(item), group);
  }
  return [...groups.values()];
}

function pairwise<T>(items: readonly T[]): [T, T][] {
  const result: [T, T][] = [];
  for (let left = 0; left < items.length; left += 1) {
    for (let right = left + 1; right < items.length; right += 1) {
      const first = items[left];
      const second = items[right];
      if (first !== undefined && second !== undefined) result.push([first, second]);
    }
  }
  return result;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/gu, ' ');
}

function parseProposal(value: unknown): GardenProposal {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.id !== 'string' || !['duplicate', 'stale', 'conflict'].includes(String(value.category)) || !Array.isArray(value.affectedIds) || !isRecord(value.evidence) || typeof value.score !== 'number' || typeof value.threshold !== 'number' || typeof value.reason !== 'string' || !['mark_stale', 'review_duplicate', 'review_conflict', 'supersede'].includes(String(value.suggestedAction)) || typeof value.fingerprint !== 'string' || !['pending', 'accepted', 'rejected', 'ignored'].includes(String(value.status)) || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') {
    throw new Error('garden proposal is invalid');
  }
  const evidence: GardenEvidence = {
    memoryIds: strings(value.evidence.memoryIds),
    contentHashes: strings(value.evidence.contentHashes),
    sourceCount: typeof value.evidence.sourceCount === 'number' ? value.evidence.sourceCount : 0,
  };
  return {
    schemaVersion: 1,
    id: value.id,
    category: value.category as GardenCategory,
    affectedIds: strings(value.affectedIds),
    evidence,
    score: value.score,
    threshold: value.threshold,
    reason: value.reason,
    suggestedAction: value.suggestedAction as GardenAction,
    fingerprint: value.fingerprint,
    status: value.status as GardenProposalStatus,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(typeof value.reviewedAt === 'string' ? { reviewedAt: value.reviewedAt } : {}),
    ...(typeof value.reviewAction === 'string' ? { reviewAction: value.reviewAction as GardenAction } : {}),
  };
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
