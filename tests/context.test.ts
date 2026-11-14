import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ContextPackBuilder } from '../packages/context/src/index.js';
import { markerBegin, markerEnd } from '../packages/storage/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';
import type { Memory } from '../packages/domain/src/index.js';

function memory(id: string, scope: Memory['scope'], title: string): Memory {
  return {
    schemaVersion: 1,
    id,
    type: 'lessons',
    scope,
    projectId: scope.kind === 'project' ? scope.id : null,
    status: 'active',
    title,
    summary: 'A tested rule.',
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
    contentHash: `sha256:${id}`,
    sources: [{ kind: 'test', locator: 'context.test.ts' }],
    anchors: [],
    tags: [],
    supersedes: null,
  };
}

describe('ContextPackBuilder', () => {
  it('includes deterministic project-first content and explains truncation', () => {
    const builder = new ContextPackBuilder();
    const pack = builder.build({
      agentId: 'claude',
      projectId: 'project-1',
      channel: 'static',
      tokenBudget: 10,
      candidates: [
        { memory: memory('global', { kind: 'global' }, 'Project'), body: 'global content' },
        { memory: memory('project', { kind: 'project', id: 'project-1' }, 'Project'), body: 'project content' },
      ],
    });

    expect(pack.sections[0]?.memoryIds).toEqual(['project']);
    expect(pack.truncated).toBe(true);
    expect(pack.decisions.every((decision) => decision.reason.length > 0)).toBe(true);
    expect(pack.decisions.find((decision) => decision.memoryId === 'project')?.reason).toContain(
      'conflict-visible',
    );
    expect(builder.trace(pack).nextQueryHint).toContain('memory_search');
  });

  it('injects only inside the managed marker block', async () => {
    const fixture = await createTemporaryDirectory();
    const path = join(fixture.path, 'AGENTS.md');
    await writeFile(path, `before\n${markerBegin}\nold\n${markerEnd}\nafter\n`, 'utf8');
    const pack = new ContextPackBuilder().build({
      agentId: 'pi',
      channel: 'preview',
      candidates: [],
    });

    await new ContextPackBuilder().inject(path, pack);
    const result = await readFile(path, 'utf8');
    expect(result.startsWith('before\n')).toBe(true);
    expect(result.endsWith('\nafter\n')).toBe(true);
    await fixture.cleanup();
  });
});
