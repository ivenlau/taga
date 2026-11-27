import { createHash } from 'node:crypto';
import {
  AgentAdapterRegistry,
  type AdapterError,
  type SourceCursor,
} from '../../../packages/adapters/src/index.js';
import { normalizeEvidence } from '../../../packages/redaction/src/index.js';
import { classifyEvidenceSignal, type EvidenceSignal } from '../../../packages/distillation/src/index.js';
import { DEFAULT_PROACTIVE_POLICY, ProactivePolicyService, type AuditLog, type ProactivePolicy } from '../../../packages/application/src/index.js';
import type { DatabaseStore, JobRecord } from '../../../packages/storage/src/index.js';
import type { EvidenceEvent } from '../../../packages/domain/src/index.js';

export interface AgentIngestionOptions {
  readonly clock?: () => Date;
  readonly maxRecordsPerSource?: number;
  /** Records older than this many days are skipped (cursor still advances). */
  readonly lookbackDays?: number;
}

export interface AgentIngestionReport {
  readonly agents: number;
  readonly sources: number;
  readonly captured: number;
  readonly duplicates: number;
  readonly blocked: number;
  /** Records skipped because they predate the collection lookback window. */
  readonly aged: number;
  readonly errors: readonly AdapterError[];
  readonly health: readonly SourceRuntimeHealth[];
}

export interface SourceRuntimeHealth {
  readonly sourceId: string;
  readonly agentId: string;
  readonly available: boolean;
  readonly lag: number;
  readonly failures: readonly string[];
  readonly updatedAt: string;
}

export interface SourceTrigger {
  readonly agentId: string;
  readonly event: 'hook' | 'session-end' | 'idle';
  readonly sourceId?: string;
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly raw?: string;
  readonly path?: string;
  readonly occurredAt?: string;
}

export interface SourceTriggerReport {
  readonly queued: boolean;
  readonly jobId: string;
  readonly reason: string;
}

export class AgentIngestionService {
  private readonly clock: () => Date;
  private readonly maxRecordsPerSource: number;
  private readonly lookbackDays: number;

  constructor(
    private readonly database: DatabaseStore,
    private readonly registry: AgentAdapterRegistry = new AgentAdapterRegistry(),
    options: AgentIngestionOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.maxRecordsPerSource = options.maxRecordsPerSource ?? 100;
    this.lookbackDays = options.lookbackDays ?? 7;
  }

  async runOnce(agentIds?: readonly string[]): Promise<AgentIngestionReport> {
    const selected = agentIds === undefined
      ? this.registry.all()
      : agentIds.map((id) => this.registry.get(id)).filter((adapter) => adapter !== null);
    let sources = 0;
    let captured = 0;
    let duplicates = 0;
    let blocked = 0;
    let aged = 0;
    const cutoff = this.clock().getTime() - this.lookbackDays * 86_400_000;
    const errors: AdapterError[] = [];
    const health: SourceRuntimeHealth[] = [];

    for (const adapter of selected) {
      const detection = await adapter.detect({ includeVersion: false, includeSourceScan: false });
      if (!detection.available) continue;
      for (const source of await adapter.sessionSources()) {
        const sourceDetection = await source.detect();
        if (!sourceDetection.available) {
          const sourceHealth = { sourceId: source.id, agentId: adapter.id, available: false, lag: 0, failures: [sourceDetection.reason ?? 'source-unavailable'], updatedAt: this.clock().toISOString() };
          health.push(sourceHealth);
          this.database.upsertMetadata(`source-health:agent:${adapter.id}:${source.id}`, JSON.stringify(sourceHealth));
          continue;
        }
        sources += 1;
        const cursorId = `agent:${adapter.id}:${source.id}`;
        const stored = this.database.getCursor(cursorId);
        const cursor: SourceCursor = stored !== null && stored.sourceVersion === source.parserVersion
          ? { offset: stored.offset, sourceVersion: stored.sourceVersion }
          : { offset: 0, sourceVersion: source.parserVersion };
        let processed = 0;
        let latestOffset = cursor.offset;
        for await (const record of source.readSince(cursor)) {
          if (Date.parse(record.occurredAt) < cutoff) {
            aged += 1;
            this.database.saveCursor(cursorId, record.cursor.offset, source.parserVersion);
            latestOffset = record.cursor.offset;
            continue;
          }
          const signal = classifyEvidenceSignal(record.raw);
          const normalized = normalizeEvidence({
            id: `evidence-${createHash('sha256').update(`${adapter.id}:${record.id}`).digest('hex')}`,
            source: record.source,
            raw: record.raw,
            path: record.path,
            agentId: adapter.id,
            occurredAt: record.occurredAt,
            capturedAt: this.clock().toISOString(),
            parserVersion: source.parserVersion,
            refs: [{ kind: 'file', locator: record.path }],
            structured: { signal },
          });
          if (this.database.saveEvidence(normalized.event)) {
            captured += 1;
            if (isDistillable(signal)) enqueueDistillationJob(this.database, normalized.event, this.clock);
          }
          else duplicates += 1;
          saveSessionObservation(this.database, normalized.event, record.cursor.offset);
          if (normalized.event.sensitivity === 'blocked') blocked += 1;
          this.database.saveCursor(cursorId, record.cursor.offset, source.parserVersion);
          latestOffset = record.cursor.offset;
          processed += 1;
          if (processed >= this.maxRecordsPerSource) break;
        }
        const latest = source.latestCursor();
        if (latest !== null) this.database.saveCursor(cursorId, latest.offset, latest.sourceVersion);
        const sourceErrors = source.errors();
        errors.push(...sourceErrors);
        const sourceHealth = { sourceId: source.id, agentId: adapter.id, available: true, lag: Math.max(0, (latest?.offset ?? latestOffset) - latestOffset), failures: sourceErrors.map((error) => error.reason), updatedAt: this.clock().toISOString() };
        health.push(sourceHealth);
        this.database.upsertMetadata(`source-health:${cursorId}`, JSON.stringify(sourceHealth));
      }
    }

    return { agents: selected.length, sources, captured, duplicates, blocked, aged, errors, health };
  }
}

export class AutomaticSourceRuntime {
  private readonly clock: () => Date;
  private readonly policy: ProactivePolicyService;
  private readonly debounceMs: number;
  private readonly lookbackDays: number;

  constructor(
    private readonly database: DatabaseStore,
    private readonly ingestion: AgentIngestionService,
    options: {
      readonly audit?: AuditLog;
      readonly policy?: ProactivePolicy;
      readonly clock?: () => Date;
      readonly debounceMs?: number;
      readonly lookbackDays?: number;
    } = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.debounceMs = options.debounceMs ?? 1_000;
    this.lookbackDays = options.lookbackDays ?? 7;
    this.policy = new ProactivePolicyService(options.audit ?? new NoopAuditLog(), options.policy ?? DEFAULT_PROACTIVE_POLICY, this.clock);
  }

  async trigger(input: SourceTrigger): Promise<SourceTriggerReport> {
    const subjectId = `${input.agentId}:${input.sourceId ?? 'all'}:${input.sessionId ?? input.event}`;
    const decision = await this.policy.decide({
      action: 'collect',
      subjectType: 'source_trigger',
      subjectId,
      ...(input.projectId === undefined ? {} : { scope: { kind: 'project' as const, id: input.projectId } }),
    });
    const jobId = `source-ingest-${createHash('sha256').update(JSON.stringify({ ...input, bucket: Math.floor(this.clock().getTime() / this.debounceMs) })).digest('hex')}`;
    if (!decision.allowed) return { queued: false, jobId, reason: decision.reason };
    const previous = this.database.getMetadata(`source-trigger:${subjectId}`);
    if (previous !== null && this.clock().getTime() - Number(previous) < this.debounceMs) return { queued: false, jobId, reason: 'debounced' };
    this.database.upsertMetadata(`source-trigger:${subjectId}`, String(this.clock().getTime()));
    const queued = this.database.enqueueJobIfAbsent({ id: jobId, kind: 'source.ingest', payload: JSON.stringify(input) });
    return { queued, jobId, reason: queued ? 'queued' : 'duplicate' };
  }

  async handle(job: JobRecord): Promise<AgentIngestionReport> {
    const trigger = JSON.parse(job.payload) as SourceTrigger;
    const cutoff = this.clock().getTime() - this.lookbackDays * 86_400_000;
    if (trigger.event === 'hook' && trigger.raw !== undefined && Date.parse(trigger.occurredAt ?? this.clock().toISOString()) >= cutoff) {
      const signal = classifyEvidenceSignal(trigger.raw);
      const normalized = normalizeEvidence({
        id: `evidence-hook-${createHash('sha256').update(`${trigger.agentId}:${trigger.sessionId ?? ''}:${trigger.raw}`).digest('hex')}`,
        source: 'hook',
        raw: trigger.raw,
        ...(trigger.path === undefined ? {} : { path: trigger.path }),
        agentId: trigger.agentId,
        ...(trigger.projectId === undefined ? {} : { projectId: trigger.projectId }),
        ...(trigger.sessionId === undefined ? {} : { sessionId: trigger.sessionId }),
        occurredAt: trigger.occurredAt ?? this.clock().toISOString(),
        capturedAt: this.clock().toISOString(),
        refs: trigger.path === undefined ? [] : [{ kind: 'file' as const, locator: trigger.path }],
        parserVersion: 'hook-runtime-v1',
        structured: { signal },
      });
      this.database.saveEvidence(normalized.event);
      saveSessionObservation(this.database, normalized.event, 0);
      if (normalized.event.sensitivity !== 'blocked' && isDistillable(signal)) {
        this.enqueueDistillation(normalized.event);
      }
    }
    return this.ingestion.runOnce([trigger.agentId]);
  }

  private enqueueDistillation(event: { readonly id: string; readonly projectId?: string | undefined; readonly sessionId?: string | undefined }): void {
    enqueueDistillationJob(this.database, event, this.clock);
  }
}

class NoopAuditLog implements AuditLog {
  append(input: Parameters<AuditLog['append']>[0]): Promise<Awaited<ReturnType<AuditLog['append']>>> {
    return Promise.resolve({ ...input, eventHash: 'noop' });
  }

  list(): Promise<Awaited<ReturnType<AuditLog['list']>>> {
    return Promise.resolve([]);
  }
}

function isDistillable(signal: EvidenceSignal): boolean {
  return signal.kind === 'outcome' || signal.kind === 'fact';
}

const DISTILL_BUCKET_MS = 60_000;

function enqueueDistillationJob(database: DatabaseStore, event: { readonly id: string; readonly projectId?: string | undefined; readonly sessionId?: string | undefined }, clock: () => Date): void {
  const payload = JSON.stringify({ projectId: event.projectId, sessionId: event.sessionId, eventIds: [event.id] });
  // Batch per (project, session, minute): one job carries all events of the bucket.
  const bucket = Math.floor(clock().getTime() / DISTILL_BUCKET_MS);
  const bucketId = `distill-auto-${createHash('sha256').update(`${event.projectId ?? ''}:${event.sessionId ?? ''}:${bucket}`).digest('hex')}`;
  if (database.enqueueJobIfAbsent({ id: bucketId, kind: 'distill.auto', payload })) return;
  const existing = database.getJob(bucketId);
  if (existing !== null && existing.status === 'queued') {
    const parsed = JSON.parse(existing.payload) as { projectId?: string; sessionId?: string; eventIds?: string[] };
    const eventIds = [...new Set([...(parsed.eventIds ?? []), event.id])];
    if (database.updateJobPayload(bucketId, JSON.stringify({ ...parsed, eventIds }))) return;
  }
  // The bucket job is no longer mergeable (running/done) — never drop the event.
  database.enqueueJobIfAbsent({
    id: `distill-auto-event-${createHash('sha256').update(`${event.projectId ?? ''}:${event.sessionId ?? ''}:${event.id}`).digest('hex')}`,
    kind: 'distill.auto',
    payload,
  });
}

function saveSessionObservation(database: DatabaseStore, event: EvidenceEvent, sequence: number): void {
  if (event.sessionId === undefined) return;
  const visibility = event.sensitivity === 'blocked' ? 'excluded' : event.sensitivity === 'redacted' ? 'redacted' : 'normal';
  database.saveSessionObservation({
    id: `session-observation-${event.id}`,
    sessionId: event.sessionId,
    ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
    ...(event.projectId === undefined ? {} : { projectId: event.projectId }),
    occurredAt: event.occurredAt,
    sequence,
    kind: `evidence:${event.source}`,
    summary: `Captured ${event.source} evidence`,
    memoryIds: [],
    sourceRefs: event.refs.map((ref) => ref.locator),
    contentHash: event.contentHash,
    visibility,
  });
}
