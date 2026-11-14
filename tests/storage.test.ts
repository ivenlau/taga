import { describe, expect, it } from 'vitest';
import { DatabaseStore } from '../packages/storage/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';

describe('DatabaseStore', () => {
  it('runs migrations idempotently and reports healthy integrity', async () => {
    const fixture = await createTemporaryDirectory();
    const databasePath = `${fixture.path}/taga.db`;
    const first = new DatabaseStore(databasePath);
    first.upsertMetadata('brain.version', '1');
    first.close();

    const second = new DatabaseStore(databasePath);
    expect(second.getMetadata('brain.version')).toBe('1');
    expect(second.integrityCheck()).toMatchObject({ ok: true, schemaVersion: 4 });
    second.close();
    await fixture.cleanup();
  });

  it('rolls back metadata writes when a transaction fails', async () => {
    const fixture = await createTemporaryDirectory();
    const store = new DatabaseStore(`${fixture.path}/taga.db`);

    expect(() =>
      store.transaction(() => {
        store.upsertMetadata('rollback', 'value');
        throw new Error('abort');
      }),
    ).toThrow('abort');
    expect(store.getMetadata('rollback')).toBeNull();

    store.close();
    await fixture.cleanup();
  });

  it('leases a job once and requires the owner to complete it', async () => {
    const fixture = await createTemporaryDirectory();
    const store = new DatabaseStore(`${fixture.path}/taga.db`);
    store.enqueueJob({ id: 'job-1', kind: 'reindex', payload: '{}' });

    const claimed = store.acquireJob('job-1', 'worker-a', 30_000);
    expect(claimed?.status).toBe('running');
    expect(store.acquireJob('job-1', 'worker-b', 30_000)).toBeNull();
    expect(() => store.completeJob('job-1', 'worker-b')).toThrow();
    store.completeJob('job-1', 'worker-a');
    expect(store.getJob('job-1')?.status).toBe('succeeded');

    store.close();
    await fixture.cleanup();
  });

  it('persists source cursors in the local database', async () => {
    const fixture = await createTemporaryDirectory();
    const path = `${fixture.path}/taga.db`;
    const first = new DatabaseStore(path);
    first.saveCursor('pi-session', 42, 'v1');
    first.close();
    const second = new DatabaseStore(path);
    expect(second.getCursor('pi-session')).toMatchObject({ offset: 42, sourceVersion: 'v1' });
    second.close();
    await fixture.cleanup();
  });
});
