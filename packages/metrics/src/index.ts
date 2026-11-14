import { createHash } from 'node:crypto';
import { SqliteAuditLog } from '../../application/src/index.js';
import { ProcedureService, type ProcedureReuseKind } from '../../procedures/src/index.js';
import type { DatabaseStore } from '../../storage/src/index.js';

export type OutcomeKind = ProcedureReuseKind | 'conflict' | 'candidate_accepted' | 'reminder_delivered' | 'reminder_dismissed';
export type OutcomeSource = 'audit' | 'procedure' | 'manual' | 'notification' | 'token_baseline';

export interface OutcomeEvent {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly kind: OutcomeKind;
  readonly source: OutcomeSource;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly projectId?: string;
  readonly agentId?: string;
  readonly sourceAgentId?: string;
  readonly taskId?: string;
  readonly occurredAt: string;
}

export interface MetricWindow {
  readonly from: string;
  readonly to: string;
}

export interface MetricScope {
  readonly projectId?: string;
  readonly agentId?: string;
}

export interface MetricValue {
  readonly id: string;
  readonly numerator: number;
  readonly denominator: number;
  readonly rate: number;
  readonly formula: string;
  readonly source: readonly OutcomeSource[];
  readonly window: MetricWindow;
  readonly scope: MetricScope;
  readonly inputs?: Readonly<Record<string, number | string>>;
}

export interface StatsReport {
  readonly generatedAt: string;
  readonly window: MetricWindow;
  readonly scope: MetricScope;
  readonly counts: Readonly<Record<OutcomeKind, number>>;
  readonly metrics: readonly MetricValue[];
  readonly eventCount: number;
  readonly degraded: false;
  readonly warnings: readonly string[];
}

export interface TokenComparison {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly baselineTokens: number;
  readonly contextTokens: number;
  readonly source: string;
  readonly projectId?: string;
  readonly agentId?: string;
  readonly taskId?: string;
  readonly occurredAt: string;
}

export interface EfficiencyLedger {
  readonly generatedAt: string;
  readonly window: MetricWindow;
  readonly scope: MetricScope;
  readonly entries: readonly OutcomeEvent[];
  readonly tokenComparisons: readonly TokenComparison[];
  readonly counts: Readonly<Record<OutcomeKind, number>>;
  readonly attribution: 'raw_audited_counts_only';
  readonly unsupportedClaims: readonly ['saved_time'];
}

export interface DigestFinding {
  readonly id: string;
  readonly severity: 'info' | 'attention';
  readonly message: string;
  readonly numerator: number;
  readonly denominator: number;
}

export interface DigestReport {
  readonly generatedAt: string;
  readonly window: MetricWindow;
  readonly scope: MetricScope;
  readonly findings: readonly DigestFinding[];
  readonly stats: StatsReport;
  readonly throttled: boolean;
  readonly degraded: boolean;
  readonly warnings: readonly string[];
}

export interface MetricsQuery {
  readonly from?: string;
  readonly to?: string;
  readonly windowDays?: number;
  readonly projectId?: string;
  readonly agentId?: string;
}

export interface DigestQuery extends MetricsQuery {
  readonly throttleMs?: number;
  readonly refreshRequested?: boolean;
  readonly daemonAvailable?: boolean;
}

export class MetricsService {
  constructor(
    private readonly database: DatabaseStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  record(input: Omit<OutcomeEvent, 'schemaVersion' | 'id' | 'source' | 'occurredAt'> & {
    readonly id?: string;
    readonly occurredAt?: string;
  }): OutcomeEvent {
    const occurredAt = input.occurredAt ?? this.clock().toISOString();
    const event: OutcomeEvent = {
      schemaVersion: 1,
      id: input.id ?? stableId('manual', input.kind, input.subjectType, input.subjectId, occurredAt, input.projectId, input.agentId, input.taskId),
      kind: input.kind,
      source: 'manual',
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      ...(input.sourceAgentId === undefined ? {} : { sourceAgentId: input.sourceAgentId }),
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      occurredAt,
    };
    this.database.upsertMetadata(`outcome-event:${event.id}`, JSON.stringify(event));
    return event;
  }

  recordTokenComparison(input: Omit<TokenComparison, 'schemaVersion' | 'id' | 'occurredAt'> & { readonly id?: string; readonly occurredAt?: string }): TokenComparison {
    if (!Number.isInteger(input.baselineTokens) || input.baselineTokens <= 0 || !Number.isInteger(input.contextTokens) || input.contextTokens < 0) throw new Error('token comparison values are invalid');
    const occurredAt = input.occurredAt ?? this.clock().toISOString();
    const event: TokenComparison = {
      schemaVersion: 1,
      id: input.id ?? `token-comparison-${createHash('sha256').update(JSON.stringify({ ...input, occurredAt })).digest('hex')}`,
      baselineTokens: input.baselineTokens,
      contextTokens: input.contextTokens,
      source: input.source,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      occurredAt,
    };
    this.database.upsertMetadata(`token-comparison:${event.id}`, JSON.stringify(event));
    return event;
  }

  async events(query: MetricsQuery = {}): Promise<readonly OutcomeEvent[]> {
    const window = this.window(query);
    const events = [...this.manualEvents(), ...this.procedureEvents(), ...this.notificationEvents(), ...await this.auditEvents()];
    return deduplicate(events)
      .filter((event) => inWindow(event.occurredAt, window))
      .filter((event) => query.projectId === undefined || event.projectId === query.projectId)
      .filter((event) => query.agentId === undefined || event.agentId === query.agentId)
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
  }

  async stats(query: MetricsQuery = {}): Promise<StatsReport> {
    const window = this.window(query);
    const scope = scopeFor(query);
    const events = await this.events(query);
    const counts = countEvents(events);
    const sources = [...new Set(events.map((event) => event.source))];
    const feedback = counts.useful + counts.not_useful;
    const reminders = counts.reminder_delivered;
    const tokenComparisons = this.tokenComparisons(query, window);
    const baselineTokens = tokenComparisons.reduce((sum, item) => sum + item.baselineTokens, 0);
    const contextTokens = tokenComparisons.reduce((sum, item) => sum + item.contextTokens, 0);
    const savedTokens = Math.max(0, baselineTokens - contextTokens);
    const reminderAdoption = new Set(events.filter((event) => event.subjectType === 'notification' && ['open', 'cite', 'useful', 'verified'].includes(event.kind)).map((event) => event.subjectId)).size;
    const reminderNegative = new Set(events.filter((event) => event.subjectType === 'notification' && ['not_useful', 'reminder_dismissed'].includes(event.kind)).map((event) => event.subjectId)).size;
    const crossSourceEligible = events.filter((event) => event.sourceAgentId !== undefined && event.agentId !== undefined && ['open', 'cite', 'useful', 'verified'].includes(event.kind));
    const crossSourceReuse = crossSourceEligible.filter((event) => event.sourceAgentId !== event.agentId).length;
    const activeLessons = this.database.listMemoryIndex().filter((memory) => memory.type === 'lessons' && memory.status === 'active');
    const activeLessonIds = new Set(activeLessons.map((memory) => memory.id));
    const effectiveLessons = new Set(events.filter((event) => activeLessonIds.has(event.subjectId) && ['cite', 'useful', 'verified'].includes(event.kind)).map((event) => event.subjectId)).size;
    const distillationCandidates = this.database.listCandidates()
      .filter((candidate) => candidate.decidedAt !== undefined && inWindow(candidate.decidedAt, window))
      .filter((candidate) => query.projectId === undefined || candidate.projectId === query.projectId || candidate.scopeSuggestion.kind === 'project' && candidate.scopeSuggestion.id === query.projectId)
      .filter((candidate) => query.agentId === undefined || candidate.agentId === query.agentId);
    const decidedCandidates = distillationCandidates.filter((candidate) => candidate.decision === 'accepted' || candidate.decision === 'rejected');
    const acceptedCandidates = decidedCandidates.filter((candidate) => candidate.decision === 'accepted').length;
    const metricSources = [...new Set<OutcomeSource>([...sources, ...(tokenComparisons.length === 0 ? [] : ['token_baseline' as const])])];
    return {
      generatedAt: this.clock().toISOString(),
      window,
      scope,
      counts,
      metrics: [
        metric('recall_share', counts.recall, events.length, 'recall / all tracked outcome events', sources, window, scope),
        metric('open_rate', counts.open, counts.recall, 'open / recall', sources, window, scope),
        metric('cite_rate', counts.cite, counts.recall, 'cite / recall', sources, window, scope),
        metric('useful_rate', counts.useful, feedback, 'useful / (useful + not_useful)', sources, window, scope),
        metric('verified_outcome_rate', counts.verified, counts.useful, 'verified / useful', sources, window, scope),
        metric('candidate_acceptance_share', counts.candidate_accepted, events.length, 'candidate_accepted / all tracked outcome events', sources, window, scope),
        metric('reminder_adoption_rate', reminderAdoption, reminders, 'notification open/cite/useful/verified / delivered reminders', metricSources, window, scope),
        metric('reminder_false_positive_rate', reminderNegative, reminders, 'notification not_useful/dismissed / delivered reminders', metricSources, window, scope),
        metric('token_savings_rate', savedTokens, baselineTokens, '(baseline tokens - context tokens) / baseline tokens', metricSources, window, scope, { baselineTokens, contextTokens }),
        metric('cross_source_reuse_rate', crossSourceReuse, crossSourceEligible.length, 'reuse events where source agent differs from consuming agent / reuse events with both agents', metricSources, window, scope),
        metric('distillation_precision', acceptedCandidates, decidedCandidates.length, 'accepted distilled candidates / (accepted + rejected distilled candidates)', metricSources, window, scope),
        metric('active_lesson_effective_rate', effectiveLessons, activeLessons.length, 'active lessons with cite/useful/verified feedback / active lessons', metricSources, window, scope),
      ],
      eventCount: events.length,
      degraded: false,
      warnings: [],
    };
  }

  async ledger(query: MetricsQuery = {}): Promise<EfficiencyLedger> {
    const events = await this.events(query);
    const window = this.window(query);
    return {
      generatedAt: this.clock().toISOString(),
      window,
      scope: scopeFor(query),
      entries: events,
      tokenComparisons: this.tokenComparisons(query, window),
      counts: countEvents(events),
      attribution: 'raw_audited_counts_only',
      unsupportedClaims: ['saved_time'],
    };
  }

  async digest(query: DigestQuery = {}): Promise<DigestReport> {
    const stats = await this.stats(query);
    const findings = findingsFor(stats.counts);
    const fingerprint = createHash('sha256').update(JSON.stringify({ window: stats.window, scope: stats.scope, findings })).digest('hex');
    const throttleKey = `digest:state:${scopeKey(stats.scope)}`;
    const prior = parseDigestState(this.database.getMetadata(throttleKey));
    const now = this.clock();
    const throttleMs = query.throttleMs ?? 24 * 60 * 60 * 1000;
    const throttled = prior !== null && prior.fingerprint === fingerprint && now.getTime() - Date.parse(prior.emittedAt) < throttleMs;
    if (!throttled) this.database.upsertMetadata(throttleKey, JSON.stringify({ fingerprint, emittedAt: now.toISOString() }));
    const degraded = query.refreshRequested === true && query.daemonAvailable !== true;
    const warnings = degraded ? ['daemon refresh unavailable; digest was computed from durable local events'] : [];
    return { generatedAt: now.toISOString(), window: stats.window, scope: stats.scope, findings: throttled ? [] : findings, stats, throttled, degraded, warnings };
  }

  private manualEvents(): OutcomeEvent[] {
    return this.database.listMetadata('outcome-event:').map(({ value }) => parseOutcomeEvent(JSON.parse(value) as unknown));
  }

  private procedureEvents(): OutcomeEvent[] {
    return new ProcedureService(this.database).events().map((event) => ({
      schemaVersion: 1,
      id: `metric-${event.id}`,
      kind: event.kind,
      source: 'procedure',
      subjectType: 'procedure',
      subjectId: event.procedureId,
      ...(event.projectId === undefined ? {} : { projectId: event.projectId }),
      ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
      occurredAt: event.occurredAt,
    }));
  }

  private notificationEvents(): OutcomeEvent[] {
    return this.database.listMetadata('notification-event:').map(({ value }) => parseNotificationEvent(JSON.parse(value) as unknown));
  }

  private tokenComparisons(query: MetricsQuery, window: MetricWindow): TokenComparison[] {
    return this.database.listMetadata('token-comparison:')
      .map(({ value }) => parseTokenComparison(JSON.parse(value) as unknown))
      .filter((event) => inWindow(event.occurredAt, window))
      .filter((event) => query.projectId === undefined || event.projectId === query.projectId)
      .filter((event) => query.agentId === undefined || event.agentId === query.agentId);
  }

  private async auditEvents(): Promise<OutcomeEvent[]> {
    const audit = await new SqliteAuditLog(this.database).list();
    return audit.flatMap((event) => {
      const payload = event.payload ?? {};
      const kind = auditKind(event.eventType, payload.kind);
      if (kind === null) return [];
      return [{
        schemaVersion: 1 as const,
        id: `metric-audit-${event.eventHash}`,
        kind,
        source: 'audit' as const,
        subjectType: event.subjectType,
        subjectId: event.subjectId,
        ...(typeof payload.projectId === 'string' ? { projectId: payload.projectId } : {}),
        ...(typeof payload.agentId === 'string' ? { agentId: payload.agentId } : {}),
        ...(typeof payload.sourceAgentId === 'string' ? { sourceAgentId: payload.sourceAgentId } : {}),
        ...(typeof payload.taskId === 'string' ? { taskId: payload.taskId } : {}),
        occurredAt: event.occurredAt,
      }];
    });
  }

  private window(query: MetricsQuery): MetricWindow {
    const to = query.to ?? this.clock().toISOString();
    const toTime = Date.parse(to);
    const days = query.windowDays ?? 30;
    const from = query.from ?? new Date(toTime - days * 24 * 60 * 60 * 1000).toISOString();
    if (!Number.isFinite(Date.parse(from)) || !Number.isFinite(toTime) || Date.parse(from) > toTime) throw new Error('metrics window is invalid');
    return { from, to };
  }
}

function auditKind(eventType: string, feedbackKind: unknown): OutcomeKind | null {
  if (eventType === 'memory.recalled') return 'recall';
  if (eventType === 'memory.opened') return 'open';
  if (eventType === 'memory.cited') return 'cite';
  if (eventType === 'memory.activate' || eventType === 'memory.accepted') return 'candidate_accepted';
  if (eventType === 'memory.feedback' && feedbackKind === 'useful') return 'useful';
  if (eventType === 'memory.feedback' && feedbackKind === 'not_useful') return 'not_useful';
  if (eventType === 'memory.feedback' && feedbackKind === 'verified') return 'verified';
  if (eventType === 'memory.feedback' && feedbackKind === 'conflict') return 'conflict';
  if (eventType === 'memory.feedback' && feedbackKind === 'cite') return 'cite';
  if (eventType === 'memory.feedback' && feedbackKind === 'outcome') return 'verified';
  return null;
}

function metric(id: string, numerator: number, denominator: number, formula: string, source: readonly OutcomeSource[], window: MetricWindow, scope: MetricScope, inputs?: Readonly<Record<string, number | string>>): MetricValue {
  return { id, numerator, denominator, rate: denominator === 0 ? 0 : numerator / denominator, formula, source, window, scope, ...(inputs === undefined ? {} : { inputs }) };
}

function countEvents(events: readonly OutcomeEvent[]): Record<OutcomeKind, number> {
  const counts: Record<OutcomeKind, number> = { recall: 0, open: 0, cite: 0, useful: 0, verified: 0, not_useful: 0, conflict: 0, candidate_accepted: 0, reminder_delivered: 0, reminder_dismissed: 0 };
  for (const event of events) counts[event.kind] += 1;
  return counts;
}

function findingsFor(counts: Readonly<Record<OutcomeKind, number>>): DigestFinding[] {
  const findings: DigestFinding[] = [];
  if (counts.recall > 0 && counts.open === 0) findings.push({ id: 'recalled-not-opened', severity: 'attention', message: 'Recalled knowledge has no recorded open events.', numerator: 0, denominator: counts.recall });
  if (counts.useful > 0 && counts.verified === 0) findings.push({ id: 'useful-not-verified', severity: 'attention', message: 'Useful outcomes have not been verified.', numerator: 0, denominator: counts.useful });
  if (counts.not_useful > counts.useful) findings.push({ id: 'negative-feedback', severity: 'attention', message: 'Not-useful feedback exceeds useful feedback.', numerator: counts.not_useful, denominator: counts.useful + counts.not_useful });
  if (counts.candidate_accepted > 0) findings.push({ id: 'accepted-candidates', severity: 'info', message: 'Reviewed candidates were accepted during this window.', numerator: counts.candidate_accepted, denominator: counts.candidate_accepted });
  return findings;
}

function scopeFor(query: MetricsQuery): MetricScope {
  return { ...(query.projectId === undefined ? {} : { projectId: query.projectId }), ...(query.agentId === undefined ? {} : { agentId: query.agentId }) };
}

function scopeKey(scope: MetricScope): string {
  return createHash('sha256').update(JSON.stringify(scope)).digest('hex');
}

function stableId(source: OutcomeSource, kind: OutcomeKind, subjectType: string, subjectId: string, occurredAt: string, projectId?: string, agentId?: string, taskId?: string): string {
  return `outcome-${createHash('sha256').update([source, kind, subjectType, subjectId, occurredAt, projectId ?? '', agentId ?? '', taskId ?? ''].join('\n')).digest('hex')}`;
}

function inWindow(occurredAt: string, window: MetricWindow): boolean {
  const time = Date.parse(occurredAt);
  return Number.isFinite(time) && time >= Date.parse(window.from) && time <= Date.parse(window.to);
}

function deduplicate(events: readonly OutcomeEvent[]): OutcomeEvent[] {
  return [...new Map(events.map((event) => [event.id, event])).values()];
}

function parseOutcomeEvent(value: unknown): OutcomeEvent {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.id !== 'string' || !isOutcomeKind(value.kind) || value.source !== 'manual' || typeof value.subjectType !== 'string' || typeof value.subjectId !== 'string' || typeof value.occurredAt !== 'string') throw new Error('outcome event is invalid');
  return {
    schemaVersion: 1,
    id: value.id,
    kind: value.kind,
    source: 'manual',
    subjectType: value.subjectType,
    subjectId: value.subjectId,
    ...(typeof value.projectId === 'string' ? { projectId: value.projectId } : {}),
    ...(typeof value.agentId === 'string' ? { agentId: value.agentId } : {}),
    ...(typeof value.sourceAgentId === 'string' ? { sourceAgentId: value.sourceAgentId } : {}),
    ...(typeof value.taskId === 'string' ? { taskId: value.taskId } : {}),
    occurredAt: value.occurredAt,
  };
}

function isOutcomeKind(value: unknown): value is OutcomeKind {
  return typeof value === 'string' && ['recall', 'open', 'cite', 'useful', 'verified', 'not_useful', 'conflict', 'candidate_accepted', 'reminder_delivered', 'reminder_dismissed'].includes(value);
}

function parseNotificationEvent(value: unknown): OutcomeEvent {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.id !== 'string' || !isOutcomeKind(value.kind) || value.source !== 'notification' || typeof value.subjectType !== 'string' || typeof value.subjectId !== 'string' || typeof value.occurredAt !== 'string') throw new Error('notification event is invalid');
  return {
    schemaVersion: 1,
    id: value.id,
    kind: value.kind,
    source: 'notification',
    subjectType: value.subjectType,
    subjectId: value.subjectId,
    ...(typeof value.projectId === 'string' ? { projectId: value.projectId } : {}),
    ...(typeof value.agentId === 'string' ? { agentId: value.agentId } : {}),
    ...(typeof value.sourceAgentId === 'string' ? { sourceAgentId: value.sourceAgentId } : {}),
    ...(typeof value.taskId === 'string' ? { taskId: value.taskId } : {}),
    occurredAt: value.occurredAt,
  };
}

function parseTokenComparison(value: unknown): TokenComparison {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.id !== 'string' || typeof value.baselineTokens !== 'number' || typeof value.contextTokens !== 'number' || typeof value.source !== 'string' || typeof value.occurredAt !== 'string') throw new Error('token comparison is invalid');
  return {
    schemaVersion: 1,
    id: value.id,
    baselineTokens: value.baselineTokens,
    contextTokens: value.contextTokens,
    source: value.source,
    ...(typeof value.projectId === 'string' ? { projectId: value.projectId } : {}),
    ...(typeof value.agentId === 'string' ? { agentId: value.agentId } : {}),
    ...(typeof value.taskId === 'string' ? { taskId: value.taskId } : {}),
    occurredAt: value.occurredAt,
  };
}

function parseDigestState(value: string | null): { fingerprint: string; emittedAt: string } | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) && typeof parsed.fingerprint === 'string' && typeof parsed.emittedAt === 'string' ? { fingerprint: parsed.fingerprint, emittedAt: parsed.emittedAt } : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
