import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROACTIVE_POLICY,
  GovernanceService,
  InMemoryAuditLog,
  InMemoryMemoryRepository,
  SqliteAuditLog,
} from '../packages/application/src/index.js';
import { LiteMcpServer, type McpResponse } from '../apps/mcp/src/index.js';
import { parseCandidate, parseMemory, type Memory } from '../packages/domain/src/index.js';
import { AutomaticDistillationService } from '../packages/distillation/src/index.js';
import { MetricsService } from '../packages/metrics/src/index.js';
import { NotificationService } from '../packages/notifications/src/index.js';
import { type AnchorProvider, MemoryPrecheckService } from '../packages/precheck/src/index.js';
import { normalizeEvidence } from '../packages/redaction/src/index.js';
import { DatabaseStore, writeMarkdownDocument } from '../packages/storage/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';

const timestamp = '2026-11-12T12:00:00.000Z';

async function callMcp(server: LiteMcpServer, request: unknown): Promise<McpResponse> {
  const response = await server.handle(request);
  if (response === null) throw new Error('unexpected notification response');
  return response;
}

describe('M3-03 notification policy', () => {
  it('deduplicates findings and applies ignore backoff with auditable feedback', async () => {
    const fixture = await createTemporaryDirectory();
    let now = new Date(timestamp);
    const database = new DatabaseStore(join(fixture.path, 'taga.db'), { now: () => now });
    const audit = new SqliteAuditLog(database);
    const service = new NotificationService(database, audit, { clock: () => now, suppressionMs: 24 * 60 * 60 * 1000 });
    const input = { level: 'L1' as const, kind: 'candidate' as const, subjectType: 'candidate', subjectId: 'candidate-1', title: 'Review candidate', message: 'A new lesson is ready.', source: 'test' };
    const first = await service.enqueue(input);
    const duplicate = await service.enqueue(input);
    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    await service.feedback(first.record.id, 'dismissed');
    now = new Date(now.getTime() + 25 * 60 * 60 * 1000);
    const second = await service.enqueue(input);
    await service.feedback(second.record.id, 'dismissed');
    now = new Date(now.getTime() + 25 * 60 * 60 * 1000);
    const backedOff = await service.enqueue(input);
    expect(backedOff.record).toMatchObject({ status: 'suppressed', reason: 'ignore-backoff' });
    expect((await audit.list()).some((event) => event.eventType === 'notification.feedback')).toBe(true);
    database.close();
    await fixture.cleanup();
  });

  it('persists quiet-hour deferrals and daily-limit suppression without losing findings', async () => {
    const fixture = await createTemporaryDirectory();
    const now = new Date(2026, 10, 12, 23, 0, 0);
    const database = new DatabaseStore(join(fixture.path, 'taga.db'), { now: () => now });
    const quiet = new NotificationService(database, new SqliteAuditLog(database), {
      clock: () => now,
      policy: { ...DEFAULT_PROACTIVE_POLICY, quietHours: { start: '22:00', end: '07:00' } },
    });
    const deferred = await quiet.enqueue({ level: 'L1', kind: 'stale', subjectType: 'memory', subjectId: 'memory-1', title: 'Stale memory', message: 'Review it.', source: 'garden' });
    expect(deferred.record.status).toBe('deferred');
    const limited = new NotificationService(database, new SqliteAuditLog(database), {
      clock: () => now,
      policy: { ...DEFAULT_PROACTIVE_POLICY, dailyNotificationLimit: 0 },
      suppressionMs: 0,
    });
    const suppressed = await limited.enqueue({ level: 'L1', kind: 'conflict', subjectType: 'memory', subjectId: 'memory-2', title: 'Conflict', message: 'Review it.', source: 'garden' });
    expect(suppressed.record).toMatchObject({ status: 'suppressed', reason: 'daily-notification-limit' });
    expect(quiet.list({ includeSuppressed: true })).toHaveLength(2);
    database.close();
    await fixture.cleanup();
  });

  it('creates one L1 digest item when automatic distillation creates a candidate', async () => {
    const fixture = await createTemporaryDirectory();
    const now = new Date(timestamp);
    const database = new DatabaseStore(join(fixture.path, 'taga.db'), { now: () => now });
    const audit = new SqliteAuditLog(database);
    const notifications = new NotificationService(database, audit, { clock: () => now });
    database.saveEvidence(normalizeEvidence({
      id: 'evidence-notification',
      source: 'hook',
      projectId: 'project-1',
      sessionId: 'session-1',
      raw: 'Use bounded retries; tests passed',
      occurredAt: timestamp,
      capturedAt: timestamp,
      refs: [{ kind: 'test', locator: 'pnpm test' }],
    }).event);

    const report = await new AutomaticDistillationService(database, undefined, undefined, {
      audit,
      notifications,
      clock: () => now,
    }).run({ projectId: 'project-1' });

    expect(report.candidates).toBe(1);
    expect(notifications.list()).toHaveLength(1);
    expect(notifications.list()[0]).toMatchObject({
      level: 'L1',
      kind: 'candidate',
      source: 'automatic-distillation',
      projectId: 'project-1',
      status: 'queued',
    });
    expect((await audit.list()).some((event) => event.eventType === 'notification.created')).toBe(true);
    database.close();
    await fixture.cleanup();
  });
});

describe('M3-04 memory precheck', () => {
  it('returns valid anchored procedures and emits one opt-in L2 reminder', async () => {
    const fixture = await createTemporaryDirectory();
    const sourcePath = join(fixture.path, 'src', 'worker.ts');
    await mkdir(join(fixture.path, 'src'), { recursive: true });
    await writeFile(sourcePath, 'export function retryWorker() { return true; }\n', 'utf8');
    const database = new DatabaseStore(join(fixture.path, 'taga.db'));
    const repository = new InMemoryMemoryRepository();
    await repository.save(memory('procedure-1', 'procedures', [{ kind: 'file', locator: sourcePath }], 'Retry worker procedure'));
    const notifications = new NotificationService(database, new SqliteAuditLog(database), { policy: { ...DEFAULT_PROACTIVE_POLICY, allowL2Reminders: true } });
    const service = new MemoryPrecheckService(database, repository, new SqliteAuditLog(database), { notifications });
    const input = { target: { file: sourcePath, symbol: 'retryWorker' }, task: 'update retry worker', projectId: 'project-1', agentId: 'codex' };
    const first = await service.run(input);
    const second = await service.run(input);
    expect(first.items[0]).toMatchObject({ memoryId: 'procedure-1', anchorState: 'valid' });
    expect(first.reminderId).toBeDefined();
    expect(second.reminderId).toBe(first.reminderId);
    expect(notifications.list({ level: 'L2' })).toHaveLength(1);
    database.close();
    await fixture.cleanup();
  });

  it('keeps L2 disabled by default, degrades stale anchors, marks repeated failures stale, and times out safely', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(join(fixture.path, 'taga.db'));
    const repository = new InMemoryMemoryRepository();
    await repository.save(memory('lesson-stale', 'lessons', [{ kind: 'file', locator: join(fixture.path, 'missing.ts') }], 'Missing file lesson'));
    const audit = new InMemoryAuditLog();
    const notifications = new NotificationService(database, audit);
    const service = new MemoryPrecheckService(database, repository, audit, { notifications, staleThreshold: 3 });
    const input = { target: { file: join(fixture.path, 'missing.ts') }, task: 'missing file lesson', projectId: 'project-1' };
    const first = await service.run(input);
    await service.run(input);
    await service.run(input);
    expect(first.diagnostics[0]).toContain('stale-anchor');
    expect(first.reminderId).toBeUndefined();
    expect(notifications.list()).toHaveLength(0);
    expect((await repository.get('lesson-stale'))?.status).toBe('stale');

    await repository.save(memory('slow-memory', 'lessons', [{ kind: 'file', locator: join(fixture.path, 'slow.ts') }], 'Slow anchor lesson'));
    const slowProvider: AnchorProvider = { async resolve() { await new Promise((resolveDelay) => setTimeout(resolveDelay, 20)); return { state: 'valid', reason: 'late' }; } };
    const timed = await new MemoryPrecheckService(database, repository, audit, { anchorProvider: slowProvider }).run({ ...input, timeoutMs: 1 });
    expect(timed).toMatchObject({ timedOut: true, degraded: true });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
    database.close();
    await fixture.cleanup();
  });

  it('exposes memory_precheck through MCP', async () => {
    const fixture = await createTemporaryDirectory();
    const sourcePath = join(fixture.path, 'target.ts');
    await writeFile(sourcePath, 'export const boundedRetry = true;\n', 'utf8');
    const item = memory('mcp-precheck', 'lessons', [{ kind: 'file', locator: sourcePath }], 'Bounded retry rule');
    await writeMarkdownDocument(join(fixture.path, 'lessons', 'project', 'project-1', `${item.id}.md`), item, item.summary);
    const server = new LiteMcpServer(fixture.path);
    const response = await callMcp(server, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_precheck', arguments: { file: sourcePath, task: 'bounded retry', project_id: 'project-1' } } });
    expect(response.error).toBeUndefined();
    expect(JSON.stringify(response.result)).toContain('mcp-precheck');
    await fixture.cleanup();
  });
});

describe('M3-05 feedback and metrics', () => {
  it('updates confidence and freshness deterministically and marks repeated invalid feedback stale', async () => {
    const repository = new InMemoryMemoryRepository();
    const audit = new InMemoryAuditLog();
    await repository.save(memory('memory-feedback', 'lessons', [], 'Feedback lesson'));
    const governance = new GovernanceService(repository, audit, () => new Date(timestamp));
    expect((await governance.feedback('memory-feedback', 'useful', { actor: 'user' }, 'useful')).confidence).toBeCloseTo(0.84);
    expect((await governance.feedback('memory-feedback', 'cite', { actor: 'user' }, 'cited')).confidence).toBeCloseTo(0.86);
    expect((await repository.get('memory-feedback'))?.lastRecalled).toBe(timestamp);
    const verified = await governance.feedback('memory-feedback', 'verified', { actor: 'user' }, 'verified');
    expect(verified).toMatchObject({ confidence: 0.94, lastVerified: timestamp });
    expect((await governance.feedback('memory-feedback', 'outcome', { actor: 'user' }, 'successful outcome')).confidence).toBe(1);
    await governance.feedback('memory-feedback', 'not_useful', { actor: 'user' }, 'bad');
    await governance.feedback('memory-feedback', 'conflict', { actor: 'user' }, 'conflict');
    const stale = await governance.feedback('memory-feedback', 'not_useful', { actor: 'user' }, 'bad again');
    expect(stale.status).toBe('stale');
    expect((await audit.list()).some((event) => event.eventType === 'memory.mark_stale')).toBe(true);
  });

  it('calculates token savings, reminder quality, cross-source reuse, and distillation precision with scopes', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(join(fixture.path, 'taga.db'), { now: () => new Date(timestamp) });
    const metrics = new MetricsService(database, () => new Date(timestamp));
    metrics.recordTokenComparison({ baselineTokens: 1000, contextTokens: 600, source: 'same-task-baseline', projectId: 'project-1', agentId: 'claude-code', occurredAt: timestamp });
    metrics.record({ kind: 'open', subjectType: 'memory', subjectId: 'memory-1', projectId: 'project-1', agentId: 'claude-code', sourceAgentId: 'codex', occurredAt: timestamp });
    const notifications = new NotificationService(database, new SqliteAuditLog(database), { clock: () => new Date(timestamp), policy: { ...DEFAULT_PROACTIVE_POLICY, allowL2Reminders: true } });
    const notification = await notifications.enqueue({ level: 'L2', kind: 'precheck', subjectType: 'memory', subjectId: 'memory-1', title: 'Reminder', message: 'Use the procedure.', source: 'precheck', projectId: 'project-1', agentId: 'claude-code' });
    await notifications.deliverPending('L2');
    await notifications.feedback(notification.record.id, 'opened');
    await notifications.feedback(notification.record.id, 'not_useful');
    database.saveCandidate(parseCandidate({ id: 'candidate-accepted', observationId: 'observation-a', agentId: 'claude-code', projectId: 'project-1', memoryType: 'lessons', title: 'A', summary: 'A', body: 'A', scopeSuggestion: { kind: 'project', id: 'project-1' }, worthLearning: true, evidenceIds: ['e-a'], confidence: 0.9, createdAt: timestamp, decidedAt: timestamp, decision: 'accepted' }));
    database.saveCandidate(parseCandidate({ id: 'candidate-rejected', observationId: 'observation-b', agentId: 'claude-code', projectId: 'project-1', memoryType: 'lessons', title: 'B', summary: 'B', body: 'B', scopeSuggestion: { kind: 'project', id: 'project-1' }, worthLearning: true, evidenceIds: ['e-b'], confidence: 0.5, createdAt: timestamp, decidedAt: timestamp, decision: 'rejected' }));
    const stats = await metrics.stats({ projectId: 'project-1', agentId: 'claude-code', windowDays: 1 });
    expect(metricRate(stats, 'token_savings_rate')).toBe(0.4);
    expect(metricRate(stats, 'reminder_adoption_rate')).toBe(1);
    expect(metricRate(stats, 'reminder_false_positive_rate')).toBe(1);
    expect(metricRate(stats, 'cross_source_reuse_rate')).toBe(1);
    expect(metricRate(stats, 'distillation_precision')).toBe(0.5);
    expect(stats.metrics.every((metric) => metric.scope.projectId === 'project-1' && metric.scope.agentId === 'claude-code')).toBe(true);
    expect((await metrics.ledger({ projectId: 'project-1', agentId: 'claude-code', windowDays: 1 })).tokenComparisons).toHaveLength(1);
    database.close();
    await fixture.cleanup();
  });
});

function memory(id: string, type: Memory['type'], anchors: Memory['anchors'], title: string): Memory {
  return parseMemory({
    schemaVersion: 1,
    id,
    type,
    scope: { kind: 'project', id: 'project-1' },
    projectId: 'project-1',
    status: 'active',
    title,
    summary: `${title} with bounded retry guidance`,
    confidence: 0.8,
    sourceTrust: 'observed',
    visibility: 'private',
    created: timestamp,
    updated: timestamp,
    contentHash: `sha256:${id}`,
    sources: [{ kind: 'test', locator: 'm3-03-05.test.ts' }],
    anchors,
  });
}

function metricRate(report: Awaited<ReturnType<MetricsService['stats']>>, id: string): number | undefined {
  return report.metrics.find((metric) => metric.id === id)?.rate;
}
