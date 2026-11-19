import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ContextPackBuilder, summarizePack } from '../packages/context/src/index.js';
import { markerBegin, markerEnd } from '../packages/storage/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';
import type { Memory } from '../packages/domain/src/index.js';

function memory(id: string, scope: Memory['scope'], title: string, overrides: Partial<Memory> = {}): Memory {
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
    ...overrides,
  };
}

const now = new Date('2026-11-19T00:00:00.000Z');

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

  it('estimates CJK content against the budget conservatively', () => {
    const cjkPack = new ContextPackBuilder().build({
      agentId: 'claude',
      channel: 'mcp',
      tokenBudget: 30,
      candidates: [{ memory: memory('cjk', { kind: 'global' }, 'Tt', { summary: '中'.repeat(40) }), body: '中'.repeat(40) }],
    }, now);
    expect(cjkPack.decisions.find((decision) => decision.memoryId === 'cjk')?.decision).toBe('truncated');
    expect(cjkPack.content).not.toContain('中');

    const asciiPack = new ContextPackBuilder().build({
      agentId: 'claude',
      channel: 'mcp',
      tokenBudget: 30,
      candidates: [{ memory: memory('ascii', { kind: 'global' }, 'Tt', { summary: 'x'.repeat(40) }), body: 'y'.repeat(40) }],
    }, now);
    expect(asciiPack.decisions.find((decision) => decision.memoryId === 'ascii')?.decision).toBe('included');
    expect(asciiPack.content).toContain('y'.repeat(40));
  });

  it('orders same-scope candidates by freshness over id', () => {
    const pack = new ContextPackBuilder().build({
      agentId: 'claude',
      channel: 'mcp',
      candidates: [
        { memory: memory('aaa-old', { kind: 'global' }, 'Old', { confidence: 0.5, updated: '2026-08-20T00:00:00.000Z' }), body: 'old body' },
        { memory: memory('zzz-new', { kind: 'global' }, 'New', { confidence: 0.5, updated: '2026-11-18T00:00:00.000Z' }), body: 'new body' },
      ],
    }, now);
    expect(pack.content.indexOf('new body')).toBeLessThan(pack.content.indexOf('old body'));
  });

  it('caps duplicate title families at two included entries', () => {
    const candidates = ['f1', 'f2', 'f3'].map((id) => ({ memory: memory(id, { kind: 'global' }, 'Same'), body: `body ${id}` }));
    const pack = new ContextPackBuilder().build({ agentId: 'claude', channel: 'mcp', candidates }, now);
    expect(pack.decisions.filter((decision) => decision.decision === 'included')).toHaveLength(2);
    expect(pack.decisions.find((decision) => decision.memoryId === 'f3')).toEqual({
      memoryId: 'f3',
      decision: 'excluded',
      reason: ['family-cap-exceeded'],
      budgetBucket: 'lessons',
    });
  });

  it('reserves budget share so one bucket cannot starve another', () => {
    const pack = new ContextPackBuilder().build({
      agentId: 'claude',
      channel: 'mcp',
      tokenBudget: 20,
      candidates: [
        { memory: memory('lesson-a', { kind: 'global' }, 'Aa', { summary: 'S' }), body: 'a'.repeat(24) },
        { memory: memory('lesson-b', { kind: 'global' }, 'Bb', { summary: 's'.repeat(24) }), body: 'b'.repeat(17) },
        { memory: memory('pref-c', { kind: 'global' }, 'Cc', { type: 'preferences', confidence: 0.5, summary: 'S' }), body: 'c'.repeat(8) },
      ],
    }, now);
    expect(pack.decisions.find((decision) => decision.memoryId === 'pref-c')?.decision).toBe('included');
    expect(pack.content).toContain('c'.repeat(8));
    expect(pack.decisions.find((decision) => decision.memoryId === 'lesson-b')?.reason).toContain('body-omitted-token-budget');
    expect(pack.content).toContain('a'.repeat(24));
  });

  it('degrades oversized bodies to summary-only content', () => {
    const pack = new ContextPackBuilder().build({
      agentId: 'claude',
      channel: 'mcp',
      tokenBudget: 8,
      candidates: [{ memory: memory('big', { kind: 'global' }, 'Tt', { summary: 'S' }), body: 'b'.repeat(40) }],
    }, now);
    const decision = pack.decisions.find((item) => item.memoryId === 'big');
    expect(decision?.decision).toBe('included');
    expect(decision?.reason).toContain('body-omitted-token-budget');
    expect(pack.content).toContain('Tt');
    expect(pack.content).not.toContain('b'.repeat(40));
  });

  it('renders task and cwd in the pack header', () => {
    const pack = new ContextPackBuilder().build({
      agentId: 'claude',
      channel: 'mcp',
      task: 'fix the tests',
      cwd: 'D:/work/app',
      candidates: [],
    }, now);
    expect(pack.content).toContain('Task: fix the tests');
    expect(pack.content).toContain('Cwd: D:/work/app');
  });

  it('admits domain advisory sections only outside the static channel', () => {
    const contributions = [{ title: 'Writing procedures and style lessons', content: '- pending one', candidateIds: ['c1'] }];
    const mcpPack = new ContextPackBuilder().build({ agentId: 'claude', channel: 'mcp', candidates: [], domainContributions: contributions }, now);
    expect(mcpPack.sections.find((section) => section.kind === 'domain')?.content).toContain('pending one');
    expect(mcpPack.decisions.some((decision) => decision.reason.includes('domain-pack-advisory'))).toBe(true);

    const staticPack = new ContextPackBuilder().build({ agentId: 'claude', channel: 'static', candidates: [], domainContributions: contributions }, now);
    expect(staticPack.sections.find((section) => section.kind === 'domain')).toBeUndefined();
    expect(staticPack.content).not.toContain('pending one');
    expect(staticPack.decisions.find((decision) => decision.source === 'domain-pack:Writing procedures and style lessons')).toEqual({
      decision: 'excluded',
      reason: ['static-channel-policy'],
      source: 'domain-pack:Writing procedures and style lessons',
    });
  });

  it('summarizes decisions per bucket for audit payloads', () => {
    const pack = new ContextPackBuilder().build({
      agentId: 'claude',
      channel: 'mcp',
      tokenBudget: 20,
      candidates: [
        { memory: memory('lesson-a', { kind: 'global' }, 'Aa', { summary: 'S' }), body: 'a'.repeat(24) },
        { memory: memory('pref-c', { kind: 'global' }, 'Cc', { type: 'preferences', confidence: 0.5, summary: 'S' }), body: 'c'.repeat(8) },
      ],
    }, now);
    const stats = summarizePack(pack);
    expect(stats.included).toBe(2);
    expect(stats.truncated).toBe(0);
    expect(stats.excluded).toBe(0);
    expect(stats.buckets.lessons).toEqual({ included: 1, truncated: 0 });
    expect(stats.buckets.preferences).toEqual({ included: 1, truncated: 0 });
    expect(stats.tokenEstimate).toBe(pack.tokenEstimate);
  });
});
