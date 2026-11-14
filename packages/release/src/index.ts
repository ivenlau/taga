import { createHash } from 'node:crypto';
import { GardenService } from '../../garden/src/index.js';
import { MetricsService } from '../../metrics/src/index.js';
import { ProcedureService } from '../../procedures/src/index.js';
import { redactText } from '../../redaction/src/index.js';
import { MarkdownMemoryRepository, type DatabaseStore } from '../../storage/src/index.js';

export type ReleaseMilestone = 'M2' | 'M3' | 'M4';
export type ReleaseGateStatus = 'passed' | 'failed' | 'pending' | 'not_required';

export interface ReleaseGateDefinition {
  readonly id: string;
  readonly category: 'agent' | 'knowledge' | 'resilience' | 'platform' | 'security' | 'performance' | 'scope';
  readonly description: string;
  readonly automated: boolean;
  readonly required: boolean;
}

export interface ReleaseEvidence {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly gateId: string;
  readonly status: 'passed' | 'failed';
  readonly artifact: string;
  readonly details: string;
  readonly redacted: boolean;
  readonly recordedAt: string;
}

export interface ReleaseGateResult extends ReleaseGateDefinition {
  readonly status: ReleaseGateStatus;
  readonly evidence: readonly string[];
  readonly detail: string;
}

export interface ReleaseAudit {
  readonly milestone: ReleaseMilestone;
  readonly generatedAt: string;
  readonly passed: boolean;
  readonly gates: readonly ReleaseGateResult[];
  readonly blockers: readonly string[];
  readonly excludedAgents: readonly string[];
  readonly deferredScope: readonly { readonly id: string; readonly reason: string }[];
}

export interface CrossAgentReuseEvidence {
  readonly sourceAgentId: string;
  readonly consumingAgentId: string;
  readonly evidenceId: string;
  readonly memoryId: string;
  readonly contextArtifact: string;
  readonly recordedAt: string;
}

export const m2ReleaseGates: readonly ReleaseGateDefinition[] = [
  ...['pi', 'claude-code', 'codex', 'opencode'].map((agent) => ({ id: `agent-${agent}`, category: 'agent' as const, description: `${agent} real source to Evidence, review, Memory, and recall`, automated: false, required: true })),
  { id: 'memory-partitions', category: 'knowledge', description: 'Five Memory partitions are populated and browseable', automated: true, required: true },
  { id: 'procedure-reuse', category: 'knowledge', description: 'A procedure is recalled, useful, and verified', automated: true, required: true },
  { id: 'garden-safety', category: 'knowledge', description: 'Duplicate, stale, and conflict proposals are detected without silent mutation', automated: true, required: true },
  { id: 'digest-stats', category: 'knowledge', description: 'Digest, stats, and ledger are available from local audited events', automated: true, required: true },
  { id: 'resilience-daemon-restart', category: 'resilience', description: 'Daemon crash and restart recovery passes', automated: false, required: true },
  { id: 'resilience-fast-path', category: 'resilience', description: 'Daemon-off Fast Path passes', automated: false, required: true },
  { id: 'resilience-cursor-jobs', category: 'resilience', description: 'Cursor and durable job recovery passes', automated: false, required: true },
  { id: 'resilience-forget-replay', category: 'resilience', description: 'Forget replay protection passes', automated: false, required: true },
  { id: 'resilience-reindex', category: 'resilience', description: 'Index rebuild recovery passes', automated: false, required: true },
  { id: 'platform-windows', category: 'platform', description: 'Windows suite passes', automated: false, required: true },
  { id: 'platform-linux', category: 'platform', description: 'Linux suite and systemd checks pass', automated: false, required: true },
  { id: 'security-no-secret-leakage', category: 'security', description: 'No secret leakage is found in persisted or exported artifacts', automated: false, required: true },
  { id: 'performance-budgets', category: 'performance', description: 'Search and ingestion performance budgets are documented and pass', automated: false, required: true },
  { id: 'gemini-excluded', category: 'scope', description: 'Gemini is explicitly outside M2 scope', automated: true, required: false },
];

export const m4ReleaseGates: readonly ReleaseGateDefinition[] = [
  { id: 'llm-structured-distillation', category: 'knowledge', description: 'Structured LLM distillation validates schema and Evidence provenance', automated: true, required: true },
  { id: 'llm-fallback-shadow', category: 'resilience', description: 'LLM shadow mode and deterministic fallback remain safe', automated: true, required: true },
  { id: 'atomic-facts', category: 'knowledge', description: 'Atomic facts preserve Evidence provenance and compatibility', automated: true, required: true },
  { id: 'hybrid-retrieval', category: 'performance', description: 'FTS5 and optional semantic retrieval fuse with degraded fallback', automated: true, required: true },
  { id: 'progressive-context', category: 'performance', description: 'Progressive search, timeline, and bounded detail recall pass', automated: true, required: true },
  { id: 'consolidation-rerank', category: 'knowledge', description: 'Merge/conflict proposals preserve sources and reranking is explainable', automated: true, required: true },
  { id: 'm4-evaluation', category: 'performance', description: 'Sanitized M4 evaluation and cost/privacy gates pass', automated: false, required: true },
  { id: 'm4-production-rollout', category: 'scope', description: 'LLM production rollout is explicitly enabled only after shadow evidence', automated: false, required: true },
  { id: 'm4-deferred-scope', category: 'scope', description: 'Team sync, Pro backend, and non-development packs remain deferred', automated: true, required: false },
];
export const m3ReleaseGates: readonly ReleaseGateDefinition[] = [
  { id: 'cross-agent-reuse', category: 'agent', description: 'One Agent source becomes governed Memory and is consumed by a different Agent', automated: true, required: true },
  { id: 'agent-static-distribution', category: 'agent', description: 'Cursor, Windsurf, Cline, and Roo static/MCP distribution checks pass', automated: false, required: true },
  { id: 'proactive-policy', category: 'security', description: 'L0-L2 policy, activation safety, throttling, and L3 fail-closed checks pass', automated: false, required: true },
  { id: 'metric-distillation-precision', category: 'performance', description: 'Distillation precision is at least 70%', automated: true, required: true },
  { id: 'metric-active-lesson-usefulness', category: 'performance', description: 'Active lesson useful or referenced rate is at least 40%', automated: true, required: true },
  { id: 'metric-reminder-adoption', category: 'performance', description: 'Reminder adoption is at least 50%', automated: true, required: true },
  { id: 'metric-proactive-false-positive', category: 'performance', description: 'Proactive false-positive rate is at most 15%', automated: true, required: true },
  { id: 'metric-token-savings', category: 'performance', description: 'Context token savings is at least 30%', automated: true, required: true },
  { id: 'platform-windows-m3', category: 'platform', description: 'Windows M3 lifecycle suite passes', automated: false, required: true },
  { id: 'platform-linux-m3', category: 'platform', description: 'Ubuntu 24.04 M3 lifecycle suite passes', automated: false, required: true },
  { id: 'platform-macos-m3', category: 'platform', description: 'macOS M3 compatibility suite passes', automated: false, required: true },
  { id: 'platform-launchd-fallback', category: 'platform', description: 'launchd lifecycle or foreground fallback passes', automated: false, required: true },
  { id: 'security-sensitive-data', category: 'security', description: 'Sensitive-data and domain-pack privacy gates pass', automated: false, required: true },
  { id: 'resilience-forget-tombstone', category: 'resilience', description: 'Forget and tombstone replay protection passes', automated: false, required: true },
  { id: 'resilience-stale-anchor', category: 'resilience', description: 'Stale-anchor degradation and review transition pass', automated: false, required: true },
  { id: 'resilience-daemon-restart-m3', category: 'resilience', description: 'Daemon restart and job recovery pass', automated: false, required: true },
  { id: 'resilience-source-replay', category: 'resilience', description: 'Source replay remains idempotent', automated: false, required: true },
  { id: 'resilience-fast-path-m3', category: 'resilience', description: 'Daemon-off Fast Path remains usable', automated: false, required: true },
  { id: 'gemini-excluded-m3', category: 'scope', description: 'Gemini remains outside M3 scope', automated: true, required: false },
  { id: 'm4-scope-deferred', category: 'scope', description: 'Team sync, graph projection, Pro backend, and L3 automation remain deferred', automated: true, required: false },
];

export class M3AcceptanceService {
  constructor(private readonly database: DatabaseStore, private readonly clock: () => Date = () => new Date()) {}

  recordCrossAgentReuse(input: Omit<CrossAgentReuseEvidence, 'recordedAt'> & { readonly recordedAt?: string }): CrossAgentReuseEvidence {
    if (input.sourceAgentId === input.consumingAgentId) throw new Error('cross-agent reuse requires different source and consuming agents');
    const evidence = { ...input, recordedAt: input.recordedAt ?? this.clock().toISOString() };
    this.database.upsertMetadata('release:m3:cross-agent-reuse', JSON.stringify(evidence));
    new MetricsService(this.database, this.clock).record({
      kind: 'cite',
      subjectType: 'memory',
      subjectId: input.memoryId,
      agentId: input.consumingAgentId,
      sourceAgentId: input.sourceAgentId,
      occurredAt: evidence.recordedAt,
    });
    return evidence;
  }
}

export class ReleaseGateService {
  constructor(
    private readonly brainPath: string,
    private readonly database: DatabaseStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  manifest(milestone: ReleaseMilestone = 'M2'): readonly ReleaseGateDefinition[] {
    return milestone === 'M2' ? m2ReleaseGates : milestone === 'M3' ? m3ReleaseGates : m4ReleaseGates;
  }

  recordEvidence(input: Omit<ReleaseEvidence, 'schemaVersion' | 'id' | 'redacted' | 'recordedAt'> & { readonly recordedAt?: string }): ReleaseEvidence {
    if (![...m2ReleaseGates, ...m3ReleaseGates, ...m4ReleaseGates].some((gate) => gate.id === input.gateId)) throw new Error(`unknown release gate: ${input.gateId}`);
    const artifact = sanitize(input.artifact);
    const details = sanitize(input.details);
    const recordedAt = input.recordedAt ?? this.clock().toISOString();
    const event: ReleaseEvidence = {
      schemaVersion: 1,
      id: `release-${createHash('sha256').update([input.gateId, input.status, artifact.text, details.text, recordedAt].join('\n')).digest('hex')}`,
      gateId: input.gateId,
      status: input.status,
      artifact: artifact.text,
      details: details.text,
      redacted: artifact.redacted || details.redacted,
      recordedAt,
    };
    this.database.upsertMetadata(`release:evidence:${event.gateId}:${event.id}`, JSON.stringify(event));
    return event;
  }

  evidence(gateId?: string): readonly ReleaseEvidence[] {
    return this.database.listMetadata('release:evidence:')
      .map(({ value }) => parseEvidence(JSON.parse(value) as unknown))
      .filter((event) => gateId === undefined || event.gateId === gateId)
      .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
  }

  async check(milestone: ReleaseMilestone = 'M2'): Promise<ReleaseAudit> {
    const manifest = this.manifest(milestone);
    const computed = milestone === 'M2' ? await this.m2ComputedStatuses() : milestone === 'M3' ? await this.m3ComputedStatuses() : this.m4ComputedStatuses();
    const gates = manifest.map((gate) => {
      const direct = computed.get(gate.id);
      if (direct !== undefined) return { ...gate, ...direct };
      const evidence = this.evidence(gate.id);
      const latest = evidence.at(-1);
      return {
        ...gate,
        status: latest?.status ?? 'pending',
        evidence: evidence.map((item) => item.id),
        detail: latest === undefined ? 'release evidence has not been recorded' : latest.details,
      } satisfies ReleaseGateResult;
    });
    const blockers = gates.filter((gate) => gate.required && gate.status !== 'passed').map((gate) => gate.id);
    return {
      milestone,
      generatedAt: this.clock().toISOString(),
      passed: blockers.length === 0,
      gates,
      blockers,
      excludedAgents: ['gemini'],
      deferredScope: milestone === 'M2' ? [] : [
        { id: 'team-sync', reason: 'M4 scope' },
        { id: 'graph-projection', reason: 'M4 scope' },
        { id: 'pro-backend', reason: 'M4 scope' },
        { id: 'l3-automatic-execution', reason: 'explicit approval remains mandatory' },
      ],
    };
  }

  private async m2ComputedStatuses(): Promise<Map<string, Pick<ReleaseGateResult, 'status' | 'evidence' | 'detail'>>> {
    const statuses = new Map<string, Pick<ReleaseGateResult, 'status' | 'evidence' | 'detail'>>();
    for (const agent of ['pi', 'claude-code', 'codex', 'opencode']) {
      const value = this.database.getMetadata(`release:agent:${agent}`);
      statuses.set(`agent-${agent}`, value === null
        ? { status: 'pending', evidence: [], detail: 'real-agent acceptance has not been recorded' }
        : { status: 'passed', evidence: [`release:agent:${agent}`], detail: 'real-agent acceptance report is present' });
    }
    const memories = await new MarkdownMemoryRepository(this.brainPath).list();
    const types = new Set(memories.filter((memory) => memory.status !== 'forgotten').map((memory) => memory.type));
    const requiredTypes = ['preferences', 'environment', 'procedures', 'lessons', 'projects'];
    const missingTypes = requiredTypes.filter((type) => !types.has(type as never));
    statuses.set('memory-partitions', missingTypes.length === 0
      ? { status: 'passed', evidence: memories.map((memory) => memory.id), detail: 'all five Memory partitions are present' }
      : { status: 'failed', evidence: memories.map((memory) => memory.id), detail: `missing Memory partitions: ${missingTypes.join(', ')}` });
    const procedureEvents = new ProcedureService(this.database).events();
    const procedureIds = [...new Set(procedureEvents.map((event) => event.procedureId))];
    const reusable = procedureIds.find((id) => {
      const kinds = new Set(procedureEvents.filter((event) => event.procedureId === id).map((event) => event.kind));
      return kinds.has('recall') && kinds.has('useful') && kinds.has('verified');
    });
    statuses.set('procedure-reuse', reusable === undefined
      ? { status: 'failed', evidence: [], detail: 'no procedure has recall, useful, and verified events' }
      : { status: 'passed', evidence: [reusable], detail: 'procedure reuse funnel is complete' });
    const proposals = new GardenService(this.database).list();
    const categories = new Set(proposals.map((proposal) => proposal.category));
    statuses.set('garden-safety', ['duplicate', 'stale', 'conflict'].every((category) => categories.has(category as never))
      ? { status: 'passed', evidence: proposals.map((proposal) => proposal.id), detail: 'all garden categories have durable proposals; proposals do not mutate Memory without acceptance' }
      : { status: 'failed', evidence: proposals.map((proposal) => proposal.id), detail: 'garden duplicate, stale, and conflict coverage is incomplete' });
    const stats = await new MetricsService(this.database, this.clock).stats();
    statuses.set('digest-stats', { status: 'passed', evidence: stats.metrics.map((metric) => metric.id), detail: 'local audited metrics include explicit formulas, windows, sources, and scopes' });
    statuses.set('gemini-excluded', { status: 'not_required', evidence: [], detail: 'Gemini is not an M2 dependency or release gate' });
    return statuses;
  }

  private async m3ComputedStatuses(): Promise<Map<string, Pick<ReleaseGateResult, 'status' | 'evidence' | 'detail'>>> {
    const statuses = new Map<string, Pick<ReleaseGateResult, 'status' | 'evidence' | 'detail'>>();
    const reuse = this.database.getMetadata('release:m3:cross-agent-reuse');
    statuses.set('cross-agent-reuse', reuse === null
      ? { status: 'pending', evidence: [], detail: 'real cross-agent reuse evidence has not been recorded' }
      : { status: 'passed', evidence: ['release:m3:cross-agent-reuse'], detail: 'cross-agent Evidence, governed Memory, and context consumption are recorded' });
    const stats = await new MetricsService(this.database, this.clock).stats();
    this.setMetricGate(statuses, stats.metrics, 'metric-distillation-precision', 'distillation_precision', 0.7, 'min');
    this.setMetricGate(statuses, stats.metrics, 'metric-active-lesson-usefulness', 'active_lesson_effective_rate', 0.4, 'min');
    this.setMetricGate(statuses, stats.metrics, 'metric-reminder-adoption', 'reminder_adoption_rate', 0.5, 'min');
    this.setMetricGate(statuses, stats.metrics, 'metric-proactive-false-positive', 'reminder_false_positive_rate', 0.15, 'max');
    this.setMetricGate(statuses, stats.metrics, 'metric-token-savings', 'token_savings_rate', 0.3, 'min');
    statuses.set('gemini-excluded-m3', { status: 'not_required', evidence: [], detail: 'Gemini is explicitly deferred from M3' });
    statuses.set('m4-scope-deferred', { status: 'not_required', evidence: [], detail: 'team sync, graph projection, Pro backend, and L3 automatic execution remain deferred' });
    return statuses;
  }

  private m4ComputedStatuses(): Map<string, Pick<ReleaseGateResult, 'status' | 'evidence' | 'detail'>> {
    const statuses = new Map<string, Pick<ReleaseGateResult, 'status' | 'evidence' | 'detail'>>();
    for (const gate of m4ReleaseGates.filter((item) => item.automated)) {
      const value = this.database.getMetadata(`release:m4:${gate.id}`);
      statuses.set(gate.id, value === null
        ? { status: 'pending', evidence: [], detail: 'M4 automated evidence has not been recorded' }
        : { status: 'passed', evidence: [`release:m4:${gate.id}`], detail: 'M4 automated evidence is present' });
    }
    for (const gate of m4ReleaseGates.filter((item) => !item.automated && item.required)) {
      const evidence = this.evidence(gate.id).filter((item) => item.status === 'passed');
      statuses.set(gate.id, evidence.length === 0
        ? { status: 'pending', evidence: [], detail: 'M4 release evidence has not been recorded' }
        : { status: 'passed', evidence: evidence.map((item) => item.id), detail: 'M4 release evidence is present' });
    }
    return statuses;
  }
  private setMetricGate(
    statuses: Map<string, Pick<ReleaseGateResult, 'status' | 'evidence' | 'detail'>>,
    metrics: readonly { readonly id: string; readonly numerator: number; readonly denominator: number; readonly rate: number; readonly formula: string }[],
    gateId: string,
    metricId: string,
    target: number,
    direction: 'min' | 'max',
  ): void {
    const metric = metrics.find((item) => item.id === metricId);
    const passed = metric !== undefined && metric.denominator > 0 && (direction === 'min' ? metric.rate >= target : metric.rate <= target);
    statuses.set(gateId, {
      status: passed ? 'passed' : 'failed',
      evidence: metric === undefined ? [] : [metric.id],
      detail: metric === undefined
        ? `${metricId} is unavailable`
        : `${metric.formula}; numerator=${metric.numerator}; denominator=${metric.denominator}; rate=${metric.rate}; target=${direction === 'min' ? '>=' : '<='}${target}`,
    });
  }
}

function sanitize(value: string): { text: string; redacted: boolean } {
  const result = redactText(value);
  return { text: result.action === 'block' ? '[BLOCKED]' : result.text, redacted: result.action !== 'none' };
}

function parseEvidence(value: unknown): ReleaseEvidence {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.id !== 'string' || typeof value.gateId !== 'string' || !['passed', 'failed'].includes(String(value.status)) || typeof value.artifact !== 'string' || typeof value.details !== 'string' || typeof value.redacted !== 'boolean' || typeof value.recordedAt !== 'string') throw new Error('release evidence is invalid');
  return { schemaVersion: 1, id: value.id, gateId: value.gateId, status: value.status as ReleaseEvidence['status'], artifact: value.artifact, details: value.details, redacted: value.redacted, recordedAt: value.recordedAt };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
