import { createHash } from 'node:crypto';
import {
  parseCandidate,
  parseObservation,
  type Candidate,
  type EvidenceEvent,
  type MemoryType,
  type Scope,
  type SourceRef,
} from '../../domain/src/index.js';
import { normalizeEvidence } from '../../redaction/src/index.js';
import type { DatabaseStore } from '../../storage/src/index.js';

export type DomainPackId = 'writing' | 'research' | 'office';

export interface DomainPackDefinition {
  readonly id: DomainPackId;
  readonly title: string;
  readonly defaultMemoryType: MemoryType;
  readonly sourceKinds: readonly SourceRef['kind'][];
  readonly contextSection: string;
  readonly privacyDefault: 'private';
}

export interface DomainPackRecordInput {
  readonly packId: DomainPackId;
  readonly raw: string;
  readonly sourceRef: SourceRef;
  readonly projectId?: string;
  readonly taskId?: string;
  readonly applicability?: { readonly status: 'applicable' | 'unavailable'; readonly reason: string };
  readonly safetyConditions?: readonly { readonly id: string; readonly passed: boolean }[];
  readonly occurredAt?: string;
}

export interface DomainPackSuggestion {
  readonly packId: DomainPackId;
  readonly title: string;
  readonly status: 'available' | 'unavailable';
  readonly reason: string;
}

export interface DomainPackRecordResult {
  readonly packId: DomainPackId;
  readonly status: 'disabled' | 'blocked' | 'unavailable' | 'candidate_created';
  readonly evidence?: EvidenceEvent;
  readonly candidate?: Candidate;
  readonly suggestion?: DomainPackSuggestion;
  readonly diagnostics: readonly string[];
}

const DOMAIN_ADVISORY_LIMIT = 5;

const definitions: readonly DomainPackDefinition[] = [
  {
    id: 'writing',
    title: 'Writing',
    defaultMemoryType: 'procedures',
    sourceKinds: ['file', 'line', 'symbol', 'url'],
    contextSection: 'Writing procedures and style lessons',
    privacyDefault: 'private',
  },
  {
    id: 'research',
    title: 'Research',
    defaultMemoryType: 'lessons',
    sourceKinds: ['url', 'file', 'line'],
    contextSection: 'Research sources, findings, and verification notes',
    privacyDefault: 'private',
  },
  {
    id: 'office',
    title: 'Office',
    defaultMemoryType: 'procedures',
    sourceKinds: ['file', 'line', 'url'],
    contextSection: 'Office workflow procedures and document constraints',
    privacyDefault: 'private',
  },
];

export class DomainPackRegistry {
  constructor(private readonly items: readonly DomainPackDefinition[] = definitions) {}

  all(): readonly DomainPackDefinition[] {
    return this.items;
  }

  get(id: string): DomainPackDefinition | null {
    return this.items.find((item) => item.id === id) ?? null;
  }
}

export class DomainPackService {
  constructor(
    private readonly database: DatabaseStore,
    private readonly registry = new DomainPackRegistry(),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  list(): readonly (DomainPackDefinition & { readonly enabled: boolean })[] {
    return this.registry.all().map((pack) => ({ ...pack, enabled: this.isEnabled(pack.id) }));
  }

  setEnabled(packId: DomainPackId, enabled: boolean): void {
    this.require(packId);
    this.database.upsertMetadata(`domain-pack:enabled:${packId}`, String(enabled));
  }

  isEnabled(packId: DomainPackId): boolean {
    return this.database.getMetadata(`domain-pack:enabled:${packId}`) === 'true';
  }

  record(input: DomainPackRecordInput): DomainPackRecordResult {
    const pack = this.require(input.packId);
    if (!this.isEnabled(pack.id)) return { packId: pack.id, status: 'disabled', diagnostics: ['pack-disabled'] };
    if (!pack.sourceKinds.includes(input.sourceRef.kind)) {
      return {
        packId: pack.id,
        status: 'unavailable',
        suggestion: { packId: pack.id, title: pack.contextSection, status: 'unavailable', reason: `unsupported-source:${input.sourceRef.kind}` },
        diagnostics: [`unsupported-source:${input.sourceRef.kind}`],
      };
    }
    const occurredAt = input.occurredAt ?? this.clock().toISOString();
    const stableInput = [pack.id, input.raw, input.sourceRef.kind, input.sourceRef.locator, input.projectId ?? '', input.taskId ?? ''].join('\n');
    const digest = createHash('sha256').update(stableInput).digest('hex');
    const normalized = normalizeEvidence({
      id: `evidence-pack-${digest}`,
      source: 'mcp',
      raw: input.raw,
      ...(input.sourceRef.kind === 'file' || input.sourceRef.kind === 'line' ? { path: input.sourceRef.locator } : {}),
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      occurredAt,
      capturedAt: this.clock().toISOString(),
      refs: [input.sourceRef],
      parserVersion: `domain-pack-${pack.id}-v1`,
    });
    this.database.saveEvidence(normalized.event);
    if (normalized.event.sensitivity === 'blocked') {
      return { packId: pack.id, status: 'blocked', evidence: normalized.event, diagnostics: ['sensitive-input-blocked'] };
    }
    const failedSafety = input.safetyConditions?.filter((condition) => !condition.passed).map((condition) => condition.id) ?? [];
    const applicability = input.applicability ?? { status: 'applicable' as const, reason: 'pack-input-accepted' };
    if (applicability.status === 'unavailable' || failedSafety.length > 0) {
      const reason = failedSafety.length > 0 ? `safety-condition-failed:${failedSafety.join(',')}` : applicability.reason;
      return {
        packId: pack.id,
        status: 'unavailable',
        evidence: normalized.event,
        suggestion: { packId: pack.id, title: pack.contextSection, status: 'unavailable', reason },
        diagnostics: [reason],
      };
    }
    const scope: Scope = input.projectId === undefined ? { kind: 'domain', id: pack.id } : { kind: 'project', id: input.projectId };
    const observation = parseObservation({
      id: `observation-pack-${digest}`,
      evidenceIds: [normalized.event.id],
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      kind: pack.defaultMemoryType === 'procedures' ? 'procedure' : 'exploration',
      summary: normalized.event.payload.summary,
      novelty: 0.7,
      reuse: 0.65,
      evidenceQuality: normalized.event.sensitivity === 'redacted' ? 0.7 : 0.85,
      sensitivityRisk: normalized.event.sensitivity === 'redacted' ? 0.1 : 0,
      createdAt: occurredAt,
    });
    this.database.saveObservation(observation);
    const candidate = parseCandidate({
      id: `candidate-pack-${digest}`,
      observationId: observation.id,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      memoryType: pack.defaultMemoryType,
      title: normalized.event.payload.summary.slice(0, 120),
      summary: normalized.event.payload.summary,
      body: normalized.event.payload.text ?? normalized.event.payload.summary,
      scopeSuggestion: scope,
      worthLearning: true,
      evidenceIds: [normalized.event.id],
      anchors: [input.sourceRef],
      confidence: 0.75,
      packId: pack.id,
      applicability,
      sensitivity: normalized.event.sensitivity,
      createdAt: occurredAt,
      decision: 'pending',
      decisionReason: 'domain-pack-candidate-created',
    });
    this.database.saveCandidate(candidate);
    return { packId: pack.id, status: 'candidate_created', evidence: normalized.event, candidate, diagnostics: [] };
  }

  suggest(packId: DomainPackId, title: string, applicable: boolean, reason: string): DomainPackSuggestion {
    const pack = this.require(packId);
    if (!this.isEnabled(pack.id) || !applicable) return { packId: pack.id, title, status: 'unavailable', reason: !this.isEnabled(pack.id) ? 'pack-disabled' : reason };
    return { packId: pack.id, title, status: 'available', reason };
  }

  contextContribution(packId: DomainPackId): { readonly title: string; readonly content: string; readonly candidateIds: readonly string[] } | null {
    const pack = this.require(packId);
    if (!this.isEnabled(pack.id)) return null;
    const candidates = this.database.listCandidates()
      .filter((candidate) => candidate.packId === pack.id && candidate.decision === 'pending' && candidate.applicability?.status !== 'unavailable')
      .slice(0, DOMAIN_ADVISORY_LIMIT);
    return { title: pack.contextSection, content: candidates.map((candidate) => `- ${candidate.summary}`).join('\n'), candidateIds: candidates.map((candidate) => candidate.id) };
  }

  contextContributions(): { readonly title: string; readonly content: string; readonly candidateIds: readonly string[] }[] {
    return this.registry.all()
      .map((pack) => this.contextContribution(pack.id))
      .filter((contribution) => contribution !== null);
  }

  private require(packId: string): DomainPackDefinition {
    const pack = this.registry.get(packId);
    if (pack === null) throw new Error(`unknown domain pack: ${packId}`);
    return pack;
  }
}

export function isDomainPackId(value: string | undefined): value is DomainPackId {
  return value !== undefined && ['writing', 'research', 'office'].includes(value);
}
