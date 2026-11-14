import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseStore, markerBegin, markerEnd, writeMarkdownDocument } from '../packages/storage/src/index.js';
import { RecoveryService } from '../packages/recovery/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';
import type { Memory } from '../packages/domain/src/index.js';

describe('injection recovery', () => {
  it('removes forgotten memory content inside the managed marker only', async () => {
    const fixture = await createTemporaryDirectory();
    const memory: Memory = {
      schemaVersion: 1, id: 'memory-injected', type: 'lessons', scope: { kind: 'global' }, projectId: null, status: 'active',
      title: 'Forget injected', summary: 'Remove this summary', confidence: 0.8, sourceTrust: 'user_authored', visibility: 'private',
      created: '2026-11-10T00:00:00.000Z', updated: '2026-11-10T00:00:00.000Z', lastVerified: null, lastRecalled: null,
      reviewCount: 0, usefulCount: 0, notUsefulCount: 0, expiresAt: null, contentHash: 'sha256:injected',
      sources: [{ kind: 'test', locator: 'injection-recovery.test.ts' }], anchors: [], tags: [], supersedes: null,
    };
    const memoryPath = join(fixture.path, 'lessons', 'global', `${memory.id}.md`);
    const targetPath = join(fixture.path, 'AGENTS.md');
    await writeMarkdownDocument(memoryPath, memory, 'Remove this body');
    await import('node:fs/promises').then(({ writeFile }) => writeFile(targetPath, `outside\n${markerBegin}\n## taga Context\n### Lessons\n${memory.title}\n${memory.summary}\nRemove this body\n${markerEnd}\nafter\n`, 'utf8'));
    const database = new DatabaseStore(join(fixture.path, 'taga.db'));
    await new RecoveryService(fixture.path, database).forget(memory.id, true, 'test', [targetPath]);
    const target = await readFile(targetPath, 'utf8');
    expect(target).toContain('outside');
    expect(target).toContain('after');
    expect(target).not.toContain('Forget injected');
    database.close();
    await fixture.cleanup();
  });
});
