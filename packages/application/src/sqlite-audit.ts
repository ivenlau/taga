import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseStore } from '../../storage/src/index.js';
import type { AuditInput, AuditLog, AuditRecord } from './governance.js';

export class SqliteAuditLog implements AuditLog {
  constructor(private readonly database: DatabaseStore) {}

  append(input: AuditInput): Promise<AuditRecord> {
    const previous = this.database.lastAuditHash();
    const id = randomUUID();
    const record: AuditRecord = {
      eventType: input.eventType,
      actor: input.actor,
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      occurredAt: input.occurredAt,
      reason: input.reason,
      payload: input.payload ?? {},
      ...(previous === undefined ? {} : { prevHash: previous }),
      eventHash: '',
    };
    const eventHash = createHash('sha256').update(JSON.stringify({ id, ...record }), 'utf8').digest('hex');
    const hashedRecord: AuditRecord = { ...record, eventHash };
    this.database.appendAuditEvent({
      id,
      eventType: hashedRecord.eventType,
      actor: hashedRecord.actor,
      ...(hashedRecord.actorId === undefined ? {} : { actorId: hashedRecord.actorId }),
      subjectType: hashedRecord.subjectType,
      subjectId: hashedRecord.subjectId,
      eventHash: hashedRecord.eventHash,
      ...(hashedRecord.prevHash === undefined ? {} : { prevHash: hashedRecord.prevHash }),
      payload: JSON.stringify({ reason: hashedRecord.reason, ...hashedRecord.payload }),
      occurredAt: hashedRecord.occurredAt,
    });
    return Promise.resolve(hashedRecord);
  }

  list(): Promise<AuditRecord[]> {
    const records = this.database.listAuditEvents().map((event) => {
      const parsed: unknown = JSON.parse(event.payload);
      const payload = isRecord(parsed) ? { ...parsed } : {};
      const reasonValue = payload.reason;
      delete payload.reason;
      return {
        id: event.id,
        eventType: event.eventType,
        actor: event.actor as AuditRecord['actor'],
        ...(event.actorId === undefined ? {} : { actorId: event.actorId }),
        subjectType: event.subjectType,
        subjectId: event.subjectId,
        occurredAt: event.occurredAt,
        reason: typeof reasonValue === 'string' ? reasonValue : 'unknown',
        payload,
        eventHash: event.eventHash,
        ...(event.prevHash === undefined ? {} : { prevHash: event.prevHash }),
      };
    });
    return Promise.resolve(records);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
