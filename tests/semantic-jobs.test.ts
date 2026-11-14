import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { semanticJobHandlers } from '../apps/daemon/src/semantic.js';
import { enqueueSemanticRemove, enqueueSemanticUpsert } from '../packages/semantic-index/src/index.js';
import { DatabaseStore } from '../packages/storage/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';

describe('semantic durable jobs', () => {
  it('deduplicates upsert jobs by memory content hash and registers daemon handlers', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(join(fixture.path, 'taga.db'));
    try {
      expect(enqueueSemanticUpsert(database, 'memory-1', 'sha256:one')).toBe(true);
      expect(enqueueSemanticUpsert(database, 'memory-1', 'sha256:one')).toBe(false);
      expect(enqueueSemanticUpsert(database, 'memory-1', 'sha256:two')).toBe(true);
      expect(enqueueSemanticRemove(database, 'memory-1')).toBe(true);
      expect(database.listJobs().map(({ kind }) => kind)).toEqual(['semantic.remove', 'semantic.upsert', 'semantic.upsert']);
      expect([...semanticJobHandlers(fixture.path, database).keys()]).toEqual(['semantic.upsert', 'semantic.remove', 'semantic.rebuild', 'semantic.optimize']);
    } finally {
      database.close();
      await fixture.cleanup();
    }
  });
});
