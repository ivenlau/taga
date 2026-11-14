import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { DatabaseStore, writeMarkdownDocument } from '../packages/storage/src/index.js';
import { RecoveryService } from '../packages/recovery/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';
import type { Memory } from '../packages/domain/src/index.js';

function memory(): Memory {
  return {
    schemaVersion: 1, id: 'memory-forget', type: 'lessons', scope: { kind: 'global' }, projectId: null, status: 'active',
    title: 'Forget me', summary: 'Temporary memory', confidence: 0.8, sourceTrust: 'user_authored', visibility: 'private',
    created: '2026-11-10T00:00:00.000Z', updated: '2026-11-10T00:00:00.000Z', lastVerified: null, lastRecalled: null,
    reviewCount: 0, usefulCount: 0, notUsefulCount: 0, expiresAt: null, contentHash: 'sha256:forget',
    sources: [{ kind: 'test', locator: 'recovery.test.ts' }], anchors: [], tags: [], supersedes: null,
  };
}

describe('recovery', () => {
  it('removes markdown and index, then prevents replay during reindex', async () => {
    const fixture = await createTemporaryDirectory();
    const item = memory();
    await writeMarkdownDocument(join(fixture.path, 'lessons', 'global', `${item.id}.md`), item, 'temporary body');
    const database = new DatabaseStore(join(fixture.path, 'taga.db'));
    const service = new RecoveryService(fixture.path, database);
    await service.reindex();
    expect((await service.preview(item.id)).indexed).toBe(true);
    await service.forget(item.id, true);
    expect(database.hasTombstone('memory', item.id)).toBe(true);
    expect(database.getMemoryIndex(item.id)).toBeNull();
    expect((await service.reindex()).indexed).toBe(0);
    database.close();
    await fixture.cleanup();
  });

  it('reports malformed markdown as an orphan during reindex', async () => {
    const fixture = await createTemporaryDirectory();
    const orphan = join(fixture.path, 'lessons', 'global', 'broken.md');
    await writeMarkdownDocument(orphan, memory(), 'valid body');
    const original = await import('node:fs/promises');
    await original.writeFile(orphan, 'not frontmatter', 'utf8');
    const database = new DatabaseStore(join(fixture.path, 'taga.db'));
    const report = await new RecoveryService(fixture.path, database).reindex();
    expect(report.orphanFiles).toContain(orphan);
    expect(report.scanned).toBe(1);
    database.close();
    await fixture.cleanup();
  });
});
