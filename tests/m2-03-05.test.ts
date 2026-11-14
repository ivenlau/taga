import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BrainBrowser } from '../packages/browsing/src/index.js';
import { DevelopmentEvidenceService } from '../packages/development/src/index.js';
import { parseMemory, type Memory } from '../packages/domain/src/index.js';
import { ProcedureService } from '../packages/procedures/src/index.js';
import {
  BrainLayout,
  DatabaseStore,
  writeMarkdownDocument,
} from '../packages/storage/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';

const timestamp = '2026-11-11T00:00:00.000Z';

describe('M2-03 development evidence sources', () => {
  it('redacts and deduplicates development Evidence, while probes create pending candidates', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(join(fixture.path, 'taga.db'));
    const service = new DevelopmentEvidenceService(database, {
      clock: () => new Date(timestamp),
      command: (command) => Promise.resolve(`${command === 'node' ? 'v24.0.0' : '10.0.0'}\n`),
    });
    const first = service.recordTestResult({
      projectId: 'project-1',
      testCommand: 'pnpm test',
      outcome: 'failed',
      output: 'password=secret-value',
      occurredAt: timestamp,
    });
    const second = service.recordTestResult({
      projectId: 'project-1',
      testCommand: 'pnpm test',
      outcome: 'failed',
      output: 'password=secret-value',
      occurredAt: timestamp,
    });
    expect(first.saved).toBe(true);
    expect(second.saved).toBe(false);
    expect(JSON.stringify(database.listEvidence())).not.toContain('secret-value');
    const probe = await service.probeEnvironment(fixture.path, 'project-1');
    expect(probe.candidate.decision).toBe('pending');
    expect(database.listCandidates()).toHaveLength(1);
    database.close();
    await fixture.cleanup();
  });
});

describe('M2-04 Brain browsing', () => {
  it('provides partition filters, pagination, detail relations, and opt-in bodies', async () => {
    const fixture = await createTemporaryDirectory();
    const brain = join(fixture.path, 'brain');
    await mkdir(brain, { recursive: true });
    const project = memory('project-1', 'projects', 'Project', 'active');
    const procedure = memory('procedure-1', 'procedures', 'Procedure', 'active');
    await writeMemory(brain, project, 'project body');
    await writeMemory(brain, procedure, 'private procedure body');
    const database = new DatabaseStore(join(brain, 'taga.db'));
    const browser = new BrainBrowser(brain, database);
    const page = await browser.list({ type: 'procedures', limit: 1 });
    expect(page.items.map((item) => item.id)).toEqual(['procedure-1']);
    const detail = await browser.detail('procedure-1');
    expect(detail?.body).toBeUndefined();
    expect(detail?.related.some((item) => item.id === 'project-1')).toBe(true);
    expect((await browser.detail('procedure-1', { includeBody: true }))?.body).toContain('private');
    database.close();
    await fixture.cleanup();
  });
});

describe('M2-05 procedure reuse', () => {
  it('keeps drafts out of skill recall and records idempotent reuse events', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(join(fixture.path, 'taga.db'));
    const service = new ProcedureService(database, () => new Date(timestamp));
    const draft = memory('procedure-1', 'procedures', 'Procedure', 'draft');
    const active = { ...draft, status: 'active' as const };
    service.define(active, {
      prerequisites: ['clean tree'],
      steps: ['run tests'],
      verification: ['tests pass'],
      applicability: ['project-1'],
      safety: ['review output'],
      risk: 'medium',
    });
    expect(service.recall(draft, 'project-1')).toBeNull();
    expect(service.recall(active, 'project-1')?.metadata.steps).toEqual(['run tests']);
    service.recordReuse({ procedureId: active.id, kind: 'useful', projectId: 'project-1', taskId: 'task-1' });
    service.recordReuse({ procedureId: active.id, kind: 'useful', projectId: 'project-1', taskId: 'task-1' });
    service.recordReuse({ procedureId: active.id, kind: 'verified', projectId: 'project-1', taskId: 'task-1' });
    expect(service.stats(active.id).counts.useful).toBe(1);
    expect(service.stats(active.id).verifiedRate).toBe(1);
    database.close();
    await fixture.cleanup();
  });
});

function memory(id: string, type: Memory['type'], title: string, status: Memory['status']): Memory {
  return parseMemory({
    schemaVersion: 1,
    id,
    type,
    scope: { kind: 'project', id: 'project-1' },
    projectId: 'project-1',
    status,
    title,
    summary: `${title} summary`,
    confidence: 0.8,
    sourceTrust: 'user_authored',
    visibility: 'private',
    created: timestamp,
    updated: timestamp,
    reviewCount: 0,
    usefulCount: 0,
    notUsefulCount: 0,
    contentHash: `sha256:${id}`,
    sources: [{ kind: 'file', locator: `${id}.md` }],
    anchors: [],
    tags: [type],
  });
}

async function writeMemory(brain: string, value: Memory, body: string): Promise<void> {
  await writeMarkdownDocument(new BrainLayout(brain).memoryFilePath(value.type, value.scope, value.id), value, body);
}
