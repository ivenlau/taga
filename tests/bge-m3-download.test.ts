import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { downloadBgeM3Model } from '../packages/embedding/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';

describe('BGE-M3 model download', () => {
  it('resumes a partial file, verifies it, and reuses the completed cache', async () => {
    const fixture = await createTemporaryDirectory();
    const content = Buffer.from('verified-model-content');
    const file = {
      path: 'onnx/model.onnx',
      size: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
    };
    const modelRoot = join(fixture.path, 'brain', 'models', 'test', 'bge-m3');
    const partPath = join(modelRoot, 'onnx', 'model.onnx.part');
    await mkdir(join(modelRoot, 'onnx'), { recursive: true });
    await writeFile(partPath, content.subarray(0, 8));
    const requests: RequestInit[] = [];
    const fetcher = ((_input: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      return Promise.resolve(new Response(content.subarray(8), { status: 206 }));
    }) as typeof fetch;

    const path = await downloadBgeM3Model({
      brainPath: join(fixture.path, 'brain'),
      modelId: 'test/bge-m3',
      revision: 'test-revision',
      files: [file],
      fetcher,
    });

    expect(path).toBe(modelRoot);
    expect(await readFile(join(modelRoot, 'onnx', 'model.onnx'))).toEqual(content);
    expect(new Headers(requests[0]?.headers).get('Range')).toBe('bytes=8-');

    const noFetch = (() => Promise.reject(new Error('completed cache should be reused'))) as typeof fetch;
    await expect(downloadBgeM3Model({
      brainPath: join(fixture.path, 'brain'),
      modelId: 'test/bge-m3',
      revision: 'test-revision',
      files: [file],
      fetcher: noFetch,
    })).resolves.toBe(modelRoot);
    await fixture.cleanup();
  });

  it('does not publish a file when checksum verification fails', async () => {
    const fixture = await createTemporaryDirectory();
    const content = Buffer.from('corrupt');
    const fetcher = (() => Promise.resolve(new Response(content, { status: 200 }))) as typeof fetch;
    const target = join(fixture.path, 'brain', 'models', 'test', 'bge-m3', 'config.json');

    await expect(downloadBgeM3Model({
      brainPath: join(fixture.path, 'brain'),
      modelId: 'test/bge-m3',
      files: [{ path: 'config.json', size: content.length, sha256: '0'.repeat(64) }],
      fetcher,
    })).rejects.toThrow('checksum verification failed');
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
    await fixture.cleanup();
  });
});
