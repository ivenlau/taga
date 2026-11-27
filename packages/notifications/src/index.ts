import { createHash } from 'node:crypto';
import {
  DEFAULT_PROACTIVE_POLICY,
  ProactivePolicyService,
  proactivePolicyFrom,
  type AuditLog,
  type ProactivePolicy,
} from '../../application/src/index.js';
import type { Scope } from '../../domain/src/index.js';
import type { DatabaseStore } from '../../storage/src/index.js';

export type NotificationLevel = 'L1' | 'L2';
export type NotificationKind = 'candidate' | 'stale' | 'conflict' | 'precheck' | 'budget';
export type NotificationStatus = 'queued' | 'deferred' | 'suppressed' | 'delivered' | 'opened' | 'dismissed';
export type NotificationFeedback = 'opened' | 'cited' | 'useful' | 'not_useful' | 'dismissed';

export interface NotificationRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly fingerprint: string;
  readonly level: NotificationLevel;
  readonly kind: NotificationKind;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly title: string;
  readonly message: string;
  readonly source: string;
  readonly scope?: Scope;
  readonly projectId?: string;
  readonly agentId?: string;
  readonly taskId?: string;
  readonly status: NotificationStatus;
  readonly reason: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deliverAfter?: string;
}

export interface NotificationInput {
  readonly level: NotificationLevel;
  readonly kind: NotificationKind;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly title: string;
  readonly message: string;
  readonly source: string;
  readonly scope?: Scope;
  readonly projectId?: string;
  readonly agentId?: string;
  readonly taskId?: string;
  readonly dedupeKey?: string;
}

export interface NotificationEnqueueResult {
  readonly created: boolean;
  readonly record: NotificationRecord;
}

export interface NotificationOptions {
  readonly policy?: ProactivePolicy;
  readonly clock?: () => Date;
  readonly suppressionMs?: number;
  readonly ignoreThreshold?: number;
}

export class NotificationService {
  private readonly clock: () => Date;
  private readonly policy: ProactivePolicyService;
  private readonly suppressionMs: number;
  private readonly ignoreThreshold: number;
  private readonly configuredPolicy: ProactivePolicy;

  constructor(
    private readonly database: DatabaseStore,
    private readonly audit: AuditLog,
    options: NotificationOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.configuredPolicy = proactivePolicyFrom(options.policy ?? DEFAULT_PROACTIVE_POLICY);
    this.policy = new ProactivePolicyService(audit, this.configuredPolicy, this.clock);
    this.suppressionMs = options.suppressionMs ?? 24 * 60 * 60 * 1000;
    this.ignoreThreshold = options.ignoreThreshold ?? 2;
  }

  async enqueue(input: NotificationInput): Promise<NotificationEnqueueResult> {
    const now = this.clock();
    const fingerprint = fingerprintFor(input);
    const prior = this.latestByFingerprint(fingerprint);
    if (prior !== null && now.getTime() - Date.parse(prior.createdAt) < this.suppressionMs) {
      await this.recordAudit('notification.suppressed', prior, 'unchanged-finding-suppressed');
      return { created: false, record: prior };
    }
    const ignored = Number(this.database.getMetadata(`notification-ignore:${fingerprint}`) ?? '0');
    const todayCount = this.list().filter((record) => record.createdAt.slice(0, 10) === now.toISOString().slice(0, 10) && record.status !== 'suppressed').length;
    const decision = await this.policy.decide({
      action: input.level === 'L1' ? 'notify' : 'remind',
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      currentNotificationCount: todayCount,
      now: localPolicyTimestamp(now),
    });
    const backoff = ignored >= this.ignoreThreshold;
    const status: NotificationStatus = backoff
      ? 'suppressed'
      : decision.allowed
        ? 'queued'
        : decision.reason === 'quiet-hours'
          ? 'deferred'
          : 'suppressed';
    const reason = backoff ? 'ignore-backoff' : decision.reason;
    const id = `notification-${createHash('sha256').update(`${fingerprint}:${now.toISOString()}`).digest('hex')}`;
    const record: NotificationRecord = {
      schemaVersion: 1,
      id,
      fingerprint,
      level: input.level,
      kind: input.kind,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      title: input.title,
      message: input.message,
      source: input.source,
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      status,
      reason,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      ...(status === 'deferred' ? { deliverAfter: nextQuietEnd(now, this.configuredPolicy.quietHours) } : {}),
    };
    this.save(record);
    await this.recordAudit('notification.created', record, reason);
    return { created: true, record };
  }

  list(options: { readonly level?: NotificationLevel; readonly includeSuppressed?: boolean } = {}): readonly NotificationRecord[] {
    return this.database.listMetadata('notification:record:')
      .map(({ value }) => parseRecord(JSON.parse(value) as unknown))
      .filter((record) => options.level === undefined || record.level === options.level)
      .filter((record) => options.includeSuppressed === true || record.status !== 'suppressed')
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async deliverPending(level: NotificationLevel = 'L1'): Promise<readonly NotificationRecord[]> {
    const delivered: NotificationRecord[] = [];
    const now = this.clock().toISOString();
    for (const record of this.list({ level }).filter((item) => item.status === 'queued' || item.status === 'deferred' && item.deliverAfter !== undefined && item.deliverAfter <= now)) {
      const updated = { ...record, status: 'delivered' as const, reason: 'delivered-locally', updatedAt: this.clock().toISOString() };
      this.save(updated);
      await this.recordAudit('notification.delivered', updated, updated.reason);
      this.recordEvent(updated, 'reminder_delivered');
      delivered.push(updated);
    }
    return delivered;
  }

  async feedback(id: string, kind: NotificationFeedback): Promise<NotificationRecord> {
    const current = this.get(id);
    if (current === null) throw new Error('notification not found');
    const status: NotificationStatus = kind === 'opened' ? 'opened' : kind === 'dismissed' ? 'dismissed' : current.status;
    const updated = { ...current, status, reason: `feedback:${kind}`, updatedAt: this.clock().toISOString() };
    this.save(updated);
    if (kind === 'dismissed' || kind === 'not_useful') {
      const key = `notification-ignore:${current.fingerprint}`;
      this.database.upsertMetadata(key, String(Number(this.database.getMetadata(key) ?? '0') + 1));
    }
    const eventKind = kind === 'opened' ? 'open' : kind === 'cited' ? 'cite' : kind === 'dismissed' ? 'reminder_dismissed' : kind;
    this.recordEvent(updated, eventKind);
    await this.recordAudit('notification.feedback', updated, kind);
    return updated;
  }

  get(id: string): NotificationRecord | null {
    const value = this.database.getMetadata(`notification:record:${id}`);
    return value === null ? null : parseRecord(JSON.parse(value) as unknown);
  }

  private latestByFingerprint(fingerprint: string): NotificationRecord | null {
    return [...this.list({ includeSuppressed: true })].reverse().find((record) => record.fingerprint === fingerprint) ?? null;
  }

  private save(record: NotificationRecord): void {
    this.database.upsertMetadata(`notification:record:${record.id}`, JSON.stringify(record));
  }

  private recordEvent(record: NotificationRecord, kind: string): void {
    const id = `notification-event-${createHash('sha256').update(`${record.id}:${kind}`).digest('hex')}`;
    this.database.upsertMetadata(`notification-event:${id}`, JSON.stringify({
      schemaVersion: 1,
      id,
      kind,
      source: 'notification',
      subjectType: 'notification',
      subjectId: record.id,
      ...(record.projectId === undefined ? {} : { projectId: record.projectId }),
      ...(record.agentId === undefined ? {} : { agentId: record.agentId }),
      ...(record.taskId === undefined ? {} : { taskId: record.taskId }),
      occurredAt: this.clock().toISOString(),
    }));
  }

  private async recordAudit(eventType: string, record: NotificationRecord, reason: string): Promise<void> {
    await this.audit.append({
      eventType,
      actor: 'daemon',
      subjectType: 'notification',
      subjectId: record.id,
      occurredAt: this.clock().toISOString(),
      reason,
      payload: { level: record.level, kind: record.kind, source: record.source, status: record.status, fingerprint: record.fingerprint, ...(record.scope === undefined ? {} : { scope: record.scope }) },
    });
  }
}

function fingerprintFor(input: NotificationInput): string {
  return createHash('sha256').update(JSON.stringify({ level: input.level, kind: input.kind, subjectType: input.subjectType, subjectId: input.subjectId, scope: input.scope, dedupeKey: input.dedupeKey ?? input.message })).digest('hex');
}

function nextQuietEnd(now: Date, quietHours: ProactivePolicy['quietHours']): string {
  if (quietHours === undefined) return new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  const [hours, minutes] = quietHours.end.split(':').map(Number);
  const end = new Date(now);
  end.setHours(hours ?? 0, minutes ?? 0, 0, 0);
  if (end.getTime() <= now.getTime()) end.setDate(end.getDate() + 1);
  return end.toISOString();
}

function localPolicyTimestamp(value: Date): string {
  const pad = (input: number): string => String(input).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}:00`;
}

function parseRecord(value: unknown): NotificationRecord {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.id !== 'string' || typeof value.fingerprint !== 'string' || !['L1', 'L2'].includes(String(value.level)) || !['candidate', 'stale', 'conflict', 'precheck', 'budget'].includes(String(value.kind)) || typeof value.subjectType !== 'string' || typeof value.subjectId !== 'string' || typeof value.title !== 'string' || typeof value.message !== 'string' || typeof value.source !== 'string' || !['queued', 'deferred', 'suppressed', 'delivered', 'opened', 'dismissed'].includes(String(value.status)) || typeof value.reason !== 'string' || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') throw new Error('notification record is invalid');
  return value as unknown as NotificationRecord;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
