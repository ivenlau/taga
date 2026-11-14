import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Memory, MemoryType } from '../packages/domain/src/index.js';
import { GardenService } from '../packages/garden/src/index.js';
import { ProcedureService, type ProcedureReuseKind } from '../packages/procedures/src/index.js';
import { BrainLayout, DatabaseStore, writeMarkdownDocument } from '../packages/storage/src/index.js';

const brainPath = resolve(process.argv[2] ?? '.tmp-m2-release');
const now = '2026-11-11T12:00:00.000Z';
await mkdir(brainPath, { recursive: true });
const database = new DatabaseStore(`${brainPath}/taga.db`, { now: () => new Date(now) });
const layout = new BrainLayout(brainPath);

const memories = [
  memory('release-preference-a', 'preferences', 'sha256:release-duplicate', 'Release preference A'),
  memory('release-preference-b', 'preferences', 'sha256:release-duplicate', 'Release preference B'),
  memory('release-environment-a', 'environment', 'sha256:release-environment-a', 'Release runtime'),
  memory('release-environment-b', 'environment', 'sha256:release-environment-b', 'Release runtime'),
  memory('release-procedure', 'procedures', 'sha256:release-procedure', 'M2 release procedure', '2026-01-02T00:00:00.000Z'),
  memory('release-lesson', 'lessons', 'sha256:release-lesson', 'Release lesson'),
  memory('release-project', 'projects', 'sha256:release-project', 'Release project'),
];

for (const item of memories) {
  await writeMarkdownDocument(layout.memoryFilePath(item.type, item.scope, item.id), item, `${item.title} body`);
}

new GardenService(database, { clock: () => new Date(now) }).scan(memories);
const procedures = new ProcedureService(database, () => new Date(now));
const procedure = memories.find((item) => item.id === 'release-procedure');
if (procedure === undefined) throw new Error('release procedure fixture is missing');
procedures.define(procedure, {
  prerequisites: ['M2 build passes'],
  steps: ['run release gates'],
  verification: ['release check has no blockers'],
  applicability: ['*'],
  safety: ['do not persist private Evidence bodies'],
  risk: 'low',
});
for (const kind of ['recall', 'useful', 'verified'] satisfies readonly ProcedureReuseKind[]) {
  procedures.recordReuse({ procedureId: procedure.id, kind, projectId: 'taga-m2-release', taskId: 'm2-release', occurredAt: now });
}
database.close();
process.stdout.write(`${JSON.stringify({ ok: true, brainPath, memories: memories.length })}\n`);

function memory(id: string, type: MemoryType, contentHash: string, title: string, expiresAt: string | null = null): Memory {
  return {
    schemaVersion: 1,
    id,
    type,
    scope: { kind: 'global' },
    projectId: null,
    status: 'active',
    title,
    summary: `${title} summary`,
    confidence: 0.9,
    sourceTrust: 'user_authored',
    visibility: 'private',
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-11-11T00:00:00.000Z',
    lastVerified: null,
    lastRecalled: null,
    reviewCount: 0,
    usefulCount: 0,
    notUsefulCount: 0,
    expiresAt,
    contentHash,
    sources: [{ kind: 'test', locator: 'scripts/prepare-m2-release-fixture.ts' }],
    anchors: [],
    tags: ['m2-release'],
    supersedes: null,
  };
}
