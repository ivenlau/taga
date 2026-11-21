import { describe, expect, it } from 'vitest';
import {
  GovernanceService,
  InMemoryAuditLog,
  InMemoryMemoryRepository,
  SqliteAuditLog,
  isDefaultRecallEligible,
  scopeWeight,
} from '../packages/application/src/index.js';
import { DatabaseStore } from '../packages/storage/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';
import type { Memory } from '../packages/domain/src/index.js';

function activeMemory(): Memory {
  return {
    schemaVersion: 1,
    id: 'mem-1',
    type: 'lessons',
    scope: { kind: 'project', id: 'project-1' },
    projectId: 'project-1',
    status: 'active',
    title: 'Bound retries',
    summary: 'Use a bounded retry policy.',
    confidence: 0.9,
    sourceTrust: 'observed',
    visibility: 'private',
    created: '2026-11-10T00:00:00.000Z',
    updated: '2026-11-10T00:00:00.000Z',
    lastVerified: null,
    lastRecalled: null,
    reviewCount: 0,
    usefulCount: 0,
    notUsefulCount: 0,
    expiresAt: null,
    contentHash: 'sha256:mem-1',
    sources: [{ kind: 'test', locator: 'governance.test.ts' }],
    anchors: [],
    tags: [],
    supersedes: null,
  };
}

describe('memory governance', () => {
  it('records versioned edits and an audit hash chain', async () => {
    const repository = new InMemoryMemoryRepository();
    const audit = new InMemoryAuditLog();
    const service = new GovernanceService(repository, audit, () => new Date('2026-11-10T01:00:00.000Z'));
    await service.create(activeMemory(), { actor: 'user', actorId: 'user-1' }, 'initial memory');
    const edited = await service.edit('mem-1', 'mem-2', { title: 'Bound retries v2' }, { actor: 'user' }, 'clarify');

    expect(edited.id).toBe('mem-2');
    expect(edited.supersedes).toBe('mem-1');
    expect((await repository.get('mem-1'))?.status).toBe('superseded');
    const events = await audit.list();
    expect(events).toHaveLength(3);
    expect(events[1]?.prevHash).toBe(events[0]?.eventHash);
    expect(events[2]?.prevHash).toBe(events[1]?.eventHash);
  });

  it('records dropped sources in audit when an edit shrinks the source list', async () => {
    const repository = new InMemoryMemoryRepository();
    const audit = new InMemoryAuditLog();
    const service = new GovernanceService(repository, audit, () => new Date('2026-11-10T01:00:00.000Z'));
    await service.create(activeMemory(), { actor: 'user' }, 'initial memory');

    await service.edit('mem-1', 'mem-2', { sources: [{ kind: 'test', locator: 'replacement.test.ts' }] }, { actor: 'user' }, 'replace stale source');
    const events = await audit.list();
    const versionEvent = events.find((event) => event.eventType === 'memory.version_created');
    expect(versionEvent?.payload).toMatchObject({
      droppedSources: [{ kind: 'test', locator: 'governance.test.ts' }],
    });
    const supersededEvent = events.find((event) => event.eventType === 'memory.superseded');
    expect(supersededEvent?.payload).toMatchObject({
      droppedSources: [{ kind: 'test', locator: 'governance.test.ts' }],
    });

    await service.edit('mem-2', 'mem-3', { title: 'Bound retries v3' }, { actor: 'user' }, 'clarify wording');
    const laterEvents = await audit.list();
    const laterVersion = laterEvents.find((event) => event.eventType === 'memory.version_created' && event.subjectId === 'mem-3');
    expect(laterVersion?.payload).not.toHaveProperty('droppedSources');
  });

  it('requires confirmation for forget and excludes non-active memory by default', async () => {
    const repository = new InMemoryMemoryRepository();
    const audit = new InMemoryAuditLog();
    const service = new GovernanceService(repository, audit);
    await service.create(activeMemory(), { actor: 'user' }, 'initial memory');

    await expect(service.forget('mem-1', { actor: 'user' }, 'remove', false)).rejects.toThrow();
    const forgotten = await service.forget('mem-1', { actor: 'user' }, 'remove', true);

    expect(forgotten.status).toBe('forgotten');
    expect(isDefaultRecallEligible(forgotten)).toBe(false);
  });

  it('uses project, domain, and global scope precedence', () => {
    expect(scopeWeight({ kind: 'project', id: 'p' })).toBe(1);
    expect(scopeWeight({ kind: 'domain', id: 'd' })).toBe(0.8);
    expect(scopeWeight({ kind: 'global' })).toBe(0.6);
  });

  it('keeps the audit chain after reopening SQLite', async () => {
    const fixture = await createTemporaryDirectory();
    const path = `${fixture.path}/taga.db`;
    const firstDatabase = new DatabaseStore(path);
    const firstAudit = new SqliteAuditLog(firstDatabase);
    await firstAudit.append({ eventType: 'memory.created', actor: 'user', actorId: 'user-1', subjectType: 'memory', subjectId: 'mem-1', occurredAt: '2026-11-10T01:00:00.000Z', reason: 'fixture', payload: { source: 'test' } });
    firstDatabase.close();
    const secondDatabase = new DatabaseStore(path);
    const secondAudit = new SqliteAuditLog(secondDatabase);
    const events = await secondAudit.list();
    expect(events).toHaveLength(1);
    expect(events[0]?.actorId).toBe('user-1');
    expect(events[0]?.payload).toEqual({ source: 'test' });
    secondDatabase.close();
    await fixture.cleanup();
  });
});
