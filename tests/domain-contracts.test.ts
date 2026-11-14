import { describe, expect, it } from 'vitest';
import {
  errorCodes,
  memorySchema,
  parseMemory,
  transitionMemory,
  TagaError,
} from '../packages/domain/src/index.js';

const source = { kind: 'test' as const, locator: 'tests/domain-contracts.test.ts' };

function memory(status: 'draft' | 'active' | 'stale' | 'superseded' | 'forgotten' = 'draft') {
  return {
    schemaVersion: 1 as const,
    id: 'mem-1',
    type: 'lessons' as const,
    scope: { kind: 'project' as const, id: 'project-1' },
    projectId: 'project-1',
    status,
    title: 'Use a bounded retry',
    summary: 'Retry transient failures with a bounded policy.',
    confidence: 0.8,
    sourceTrust: 'observed' as const,
    visibility: 'private' as const,
    created: '2026-11-10T00:00:00.000Z',
    updated: '2026-11-10T00:00:00.000Z',
    lastVerified: null,
    lastRecalled: null,
    reviewCount: 0,
    usefulCount: 0,
    notUsefulCount: 0,
    expiresAt: null,
    contentHash: 'sha256:memory-1',
    sources: [source],
    anchors: [],
    tags: ['reliability'],
    supersedes: null,
  };
}

describe('domain contracts', () => {
  it('rejects invalid scope, confidence, visibility, and active sources', () => {
    const result = memorySchema.safeParse({
      ...memory('active'),
      scope: { kind: 'project', id: 'project-2' },
      projectId: 'project-1',
      confidence: 1.2,
      visibility: 'public',
      sources: [],
    });

    expect(result.success).toBe(false);
  });

  it('accepts a valid draft and transitions only through legal states', () => {
    const draft = parseMemory(memory());
    const active = transitionMemory(draft, { type: 'activate' });
    const stale = transitionMemory(active, { type: 'mark_stale' });
    const refreshed = transitionMemory(stale, { type: 'refresh' });

    expect(active.status).toBe('active');
    expect(stale.status).toBe('stale');
    expect(refreshed.status).toBe('active');
  });

  it('rejects illegal transitions with a stable conflict code', () => {
    const forgotten = parseMemory(memory('forgotten'));

    expect(() => transitionMemory(forgotten, { type: 'activate' })).toThrowError(
      expect.objectContaining({ code: errorCodes.conflict }),
    );
  });

  it('rejects self-supersede and does not return a successful result', () => {
    const active = parseMemory(memory('active'));

    expect(() => transitionMemory(active, { type: 'supersede', replacementId: active.id })).toThrow(
      TagaError,
    );
  });
});
