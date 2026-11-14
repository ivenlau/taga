import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { ZvecRuntimeAdapter, ZvecRuntimeError, classifyZvecFailure, runZvecLifecycleProbe } from '../packages/zvec/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';

describe('Zvec runtime adapter', () => {
  it('loads the native module lazily', async () => {
    let calls = 0;
    const adapter = new ZvecRuntimeAdapter(() => {
      calls += 1;
      return Promise.reject(new Error('not loaded'));
    });

    expect(adapter.loaded).toBe(false);
    await expect(adapter.load()).rejects.toMatchObject({ code: 'unknown' });
    expect(calls).toBe(1);
    expect(adapter.loaded).toBe(false);
  });

  it.each([
    ['ERR_MODULE_NOT_FOUND', 'module missing', 'unavailable'],
    ['ERR_DLOPEN_FAILED', 'The specified module could not be found', 'incompatible'],
    ['ZVEC_INTERNAL_ERROR', "Can't lock read-only/read-write collection: LOCK", 'busy'],
    ['ZVEC_INTERNAL_ERROR', 'collection manifest is corrupt', 'corrupt'],
  ] as const)('classifies %s failures as %s', (code, message, expected) => {
    expect(classifyZvecFailure({ code, message })).toMatchObject({ code: expected });
  });

  it('runs create, upsert, query, delete, close, and reopen', async () => {
    const fixture = await createTemporaryDirectory();
    try {
      const report = await runZvecLifecycleProbe(join(fixture.path, 'collection'));
      expect(report.packageVersion).toBe('0.8.0');
      expect(report.inserted).toBe(2);
      expect(report.queryHitIds).toEqual(['alpha', 'beta']);
      expect(report.remainingAfterDelete).toBe(1);
      expect(report.reopenedDocCount).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it('allows concurrent read-only handles and enforces writer exclusivity', async () => {
    const fixture = await createTemporaryDirectory();
    const collectionPath = join(fixture.path, 'collection');
    const adapter = new ZvecRuntimeAdapter();
    try {
      await runZvecLifecycleProbe(collectionPath, adapter);
      const firstReader = await adapter.open(collectionPath, 'read-only');
      const secondReader = await adapter.open(collectionPath, 'read-only');
      expect(firstReader.stats.docCount).toBe(1);
      expect(secondReader.stats.docCount).toBe(1);
      secondReader.closeSync();
      firstReader.closeSync();

      const writer = await adapter.open(collectionPath, 'read-write');
      await expect(adapter.open(collectionPath, 'read-only')).rejects.toMatchObject({ code: 'busy' });
      await expect(adapter.open(collectionPath, 'read-write')).rejects.toMatchObject({ code: 'busy' });
      writer.closeSync();

      const readerAfterClose = await adapter.open(collectionPath, 'read-only');
      expect(readerAfterClose.stats.docCount).toBe(1);
      readerAfterClose.closeSync();
    } finally {
      await fixture.cleanup();
    }
  });

  it('exposes busy failures as structured adapter errors', async () => {
    const adapter = new ZvecRuntimeAdapter(() => Promise.reject(new ZvecRuntimeError('busy', 'collection is locked')));
    await expect(adapter.load()).rejects.toMatchObject({ code: 'busy' });
  });
});
