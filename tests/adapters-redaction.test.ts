import { describe, expect, it } from 'vitest';
import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonlSourceAdapter, PiAgentAdapter } from '../packages/adapters/src/index.js';
import { normalizeEvidence, redactText } from '../packages/redaction/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';

describe('source adapters', () => {
  it('resumes at a cursor, deduplicates identical records, and isolates malformed lines', async () => {
    const fixture = await createTemporaryDirectory();
    const path = join(fixture.path, 'session.jsonl');
    await writeFile(path, '{"event":"one"}\nnot-json\n{"event":"two"}\n', 'utf8');
    const adapter = new JsonlSourceAdapter('fixture', path);
    const first = [];
    for await (const record of adapter.readSince({ offset: 0, sourceVersion: 'v1' })) first.push(record);
    expect(first).toHaveLength(2);
    expect(adapter.errors()).toHaveLength(1);
    const second = [];
    for await (const record of adapter.readSince(adapter.checkpoint(first[0]!))) second.push(record);
    expect(second).toHaveLength(1);
    await appendFile(path, '{"event":"three"}\n', 'utf8');
    const third = [];
    for await (const record of adapter.readSince(adapter.checkpoint(first[1]!))) third.push(record);
    expect(third).toHaveLength(1);
    expect((await new PiAgentAdapter(path).detect()).available).toBe(true);
    await fixture.cleanup();
  });

  it('uses UTF-8 byte offsets for multibyte JSONL records', async () => {
    const fixture = await createTemporaryDirectory();
    const path = join(fixture.path, 'unicode-session.jsonl');
    await writeFile(path, '{"event":"中文"}\n{"event":"第二条"}\n', 'utf8');
    const adapter = new JsonlSourceAdapter('unicode', path);
    const records = [];
    for await (const record of adapter.readSince({ offset: 0, sourceVersion: 'v1' })) records.push(record);
    expect(records).toHaveLength(2);
    expect(records[0]?.cursor.offset).toBe(Buffer.byteLength('{"event":"中文"}\n'));
    const resumed = [];
    for await (const record of adapter.readSince(adapter.checkpoint(records[0]!))) resumed.push(record);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.payload).toEqual({ event: '第二条' });
    await fixture.cleanup();
  });
});

describe('redaction', () => {
  it('replaces secrets without exposing originals and blocks private keys', () => {
    const result = redactText('password=top-secret token eyJabc.def.ghi api_key=sk_test_123456789012');
    expect(result.text).not.toContain('top-secret');
    expect(result.text).not.toContain('eyJabc');
    expect(result.action).toBe('replace');
    const blocked = normalizeEvidence({
      id: 'evidence-1', source: 'watcher', raw: '-----BEGIN PRIVATE KEY-----secret-----END PRIVATE KEY-----',
      path: 'secret.pem', occurredAt: '2026-11-10T00:00:00.000Z', capturedAt: '2026-11-10T00:00:00.000Z',
    });
    expect(blocked.event.sensitivity).toBe('blocked');
    expect(JSON.stringify(blocked.event)).not.toContain('secret');
  });
});
