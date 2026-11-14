import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { errorCodes, TagaError } from '../packages/domain/src/index.js';
import { JsonLogger } from '../packages/observability/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';

describe('foundation primitives', () => {
  it('uses stable error codes without leaking untyped details', () => {
    const error = new TagaError(errorCodes.validationFailed, 'invalid input', {
      field: 'title',
    });

    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.details).toEqual({ field: 'title' });
  });

  it('emits structured records through an injectable sink', () => {
    const records: unknown[] = [];
    const logger = new JsonLogger(
      'audit',
      (record) => records.push(record),
      () => new Date('2026-11-10T00:00:00.000Z'),
    );

    logger.info({ eventType: 'test', resultCount: 1 });

    expect(records).toEqual([
      {
        timestamp: '2026-11-10T00:00:00.000Z',
        level: 'info',
        component: 'audit',
        eventType: 'test',
        resultCount: 1,
      },
    ]);
  });

  it('isolates temporary fixtures and cleans them up', async () => {
    const fixture = await createTemporaryDirectory();
    const markerPath = join(fixture.path, 'marker.txt');

    await writeFile(markerPath, 'fixture', 'utf8');
    expect(await readFile(markerPath, 'utf8')).toBe('fixture');

    await fixture.cleanup();
    await expect(readFile(markerPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
