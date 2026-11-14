import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteAuditLog } from '../packages/application/src/index.js';
import { MetricsService } from '../packages/metrics/src/index.js';
import { ProcedureService } from '../packages/procedures/src/index.js';
import { DatabaseStore } from '../packages/storage/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';

const now = '2026-11-11T12:00:00.000Z';

describe('M2-07 digest, statistics, and efficiency ledger', () => {
  it('separates outcomes and exposes auditable formulas and scopes', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(join(fixture.path, 'taga.db'), { now: () => new Date(now) });
    const procedures = new ProcedureService(database, () => new Date(now));
    procedures.recordReuse({ procedureId: 'procedure-1', kind: 'recall', projectId: 'project-1', taskId: 'task-1', occurredAt: now });
    procedures.recordReuse({ procedureId: 'procedure-1', kind: 'useful', projectId: 'project-1', taskId: 'task-1', occurredAt: now });
    const metrics = new MetricsService(database, () => new Date(now));
    metrics.record({ kind: 'open', subjectType: 'procedure', subjectId: 'procedure-1', projectId: 'project-1', agentId: 'codex', occurredAt: now });
    metrics.record({ kind: 'cite', subjectType: 'procedure', subjectId: 'procedure-1', projectId: 'project-1', agentId: 'codex', occurredAt: now });
    metrics.record({ kind: 'verified', subjectType: 'procedure', subjectId: 'procedure-1', projectId: 'project-1', occurredAt: now });
    await new SqliteAuditLog(database).append({ eventType: 'memory.activate', actor: 'user', subjectType: 'memory', subjectId: 'memory-1', occurredAt: now, reason: 'accepted', payload: { projectId: 'project-1' } });

    const stats = await metrics.stats({ projectId: 'project-1', windowDays: 1 });
    expect(stats.counts).toMatchObject({ recall: 1, open: 1, cite: 1, useful: 1, verified: 1, candidate_accepted: 1 });
    expect(stats.metrics.find((item) => item.id === 'verified_outcome_rate')).toMatchObject({ numerator: 1, denominator: 1, rate: 1 });
    expect(stats.metrics.every((item) => item.window.from.length > 0 && item.source.length > 0)).toBe(true);
    const ledger = await metrics.ledger({ projectId: 'project-1', windowDays: 1 });
    expect(ledger.attribution).toBe('raw_audited_counts_only');
    expect(JSON.stringify(ledger)).not.toContain('secret');
    database.close();
    await fixture.cleanup();
  });

  it('throttles unchanged findings and reports daemon refresh degradation', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(join(fixture.path, 'taga.db'), { now: () => new Date(now) });
    const metrics = new MetricsService(database, () => new Date(now));
    metrics.record({ kind: 'recall', subjectType: 'memory', subjectId: 'memory-1', occurredAt: now });
    const first = await metrics.digest({ windowDays: 1 });
    const second = await metrics.digest({ windowDays: 1 });
    expect(first.findings).toHaveLength(1);
    expect(second).toMatchObject({ throttled: true, findings: [] });
    const degraded = await metrics.digest({ windowDays: 1, refreshRequested: true, daemonAvailable: false });
    expect(degraded.degraded).toBe(true);
    expect(degraded.warnings[0]).toContain('durable local events');
    database.close();
    await fixture.cleanup();
  });
});
