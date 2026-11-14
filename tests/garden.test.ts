import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteAuditLog } from '../packages/application/src/index.js';
import { GardenService } from '../packages/garden/src/index.js';
import { parseMemory, type Memory } from '../packages/domain/src/index.js';
import { DatabaseStore, MarkdownMemoryRepository, writeMarkdownDocument } from '../packages/storage/src/index.js';
import { BrainLayout } from '../packages/storage/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';

const now = '2026-11-11T00:00:00.000Z';

describe('M2-06 garden proposals', () => {
  it('creates duplicate and conflict proposals without mutating Memory, then deduplicates scans', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(join(fixture.path, 'taga.db'));
    const service = new GardenService(database, { clock: () => new Date(now) });
    const duplicateA = memory('a', 'Same rule', 'sha256:same');
    const duplicateB = memory('b', 'Same rule copy', 'sha256:same');
    const conflict = memory('c', 'Conflict rule', 'sha256:one');
    const conflictOther = memory('d', 'Conflict rule', 'sha256:two');
    const first = service.scan([duplicateA, duplicateB, conflict, conflictOther]);
    expect(first.proposals.map((proposal) => proposal.category).sort()).toEqual(['conflict', 'duplicate']);
    expect(first.proposals.every((proposal) => proposal.status === 'pending')).toBe(true);
    expect(service.scan([duplicateA, duplicateB, conflict, conflictOther]).unchanged).toBe(2);
    expect(service.list('pending')).toHaveLength(2);
    database.close();
    await fixture.cleanup();
  });

  it('remembers rejected findings and only mutates through explicit governed acceptance', async () => {
    const fixture = await createTemporaryDirectory();
    const brain = join(fixture.path, 'brain');
    const stale = memory('stale', 'Expired rule', 'sha256:stale', '2026-11-01T00:00:00.000Z');
    await writeMarkdownDocument(new BrainLayout(brain).memoryFilePath(stale.type, stale.scope, stale.id), stale, 'expired');
    const database = new DatabaseStore(join(brain, 'taga.db'));
    const service = new GardenService(database, { clock: () => new Date(now) });
    const report = service.scan([stale]);
    const proposal = report.proposals[0];
    expect(proposal?.category).toBe('stale');
    expect((await new MarkdownMemoryRepository(brain).get(stale.id))?.status).toBe('active');
    const rejected = await service.review(proposal?.id ?? '', 'rejected', {
      repository: new MarkdownMemoryRepository(brain),
      audit: new SqliteAuditLog(database),
      actor: { actor: 'user' },
    });
    expect(rejected.status).toBe('rejected');
    expect((await new MarkdownMemoryRepository(brain).get(stale.id))?.status).toBe('active');

    const next = service.scan([stale]);
    expect(next.proposals).toHaveLength(0);
    const freshProposal = service.list('rejected')[0];
    expect(freshProposal).toBeDefined();
    const changed = { ...stale, contentHash: 'sha256:changed' };
    const changedProposal = service.scan([changed]).proposals[0];
    const accepted = await service.review(changedProposal?.id ?? '', 'accepted', {
      repository: new MarkdownMemoryRepository(brain),
      audit: new SqliteAuditLog(database),
      actor: { actor: 'user' },
      action: 'mark_stale',
      targetId: stale.id,
    });
    expect(accepted.status).toBe('accepted');
    expect((await new MarkdownMemoryRepository(brain).get(stale.id))?.status).toBe('stale');
    database.close();
    await fixture.cleanup();
  });
});

function memory(id: string, title: string, hash: string, expiresAt?: string): Memory {
  return parseMemory({
    schemaVersion: 1,
    id,
    type: 'lessons',
    scope: { kind: 'project', id: 'project-1' },
    projectId: 'project-1',
    status: 'active',
    title,
    summary: `${title} summary`,
    confidence: 0.8,
    sourceTrust: 'user_authored',
    visibility: 'private',
    created: now,
    updated: now,
    lastVerified: null,
    lastRecalled: null,
    reviewCount: 0,
    usefulCount: 0,
    notUsefulCount: 0,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    contentHash: hash,
    sources: [{ kind: 'file', locator: `${id}.md` }],
    anchors: [],
    tags: ['garden'],
    supersedes: null,
  });
}
