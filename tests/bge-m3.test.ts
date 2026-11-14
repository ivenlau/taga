import { describe, expect, it } from 'vitest';
import { createLocalBgeM3Embedder, type BgeM3Pipeline } from '../packages/embedding/src/index.js';

const modelPath = process.env.TAGA_BGE_M3_MODEL_PATH;

describe('local BGE-M3 embedder', () => {
  it('reports unavailable for a missing local model path', async () => {
    const embedder = createLocalBgeM3Embedder({ modelPath: 'D:/missing/taga-bge-m3' });
    await expect(embedder.embed([{ id: 'missing-model', text: 'secret local test' }])).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('classifies an incompatible tensor shape without exposing source text', async () => {
    const incompatiblePipeline = (() => Promise.resolve({ dims: [1, 3], data: new Float32Array([1, 2, 3]) })) as unknown as BgeM3Pipeline;
    const embedder = createLocalBgeM3Embedder({
      modelPath: 'D:/test-model',
      loader: () => Promise.resolve(incompatiblePipeline),
      dimensions: 1024,
    });
    await expect(embedder.embed([{ id: 'bad-shape', text: 'private source text' }])).rejects.toMatchObject({ code: 'incompatible' });
  });

  it.skipIf(modelPath === undefined)('runs real local BGE-M3 inference for Chinese and English text', async () => {
    const embedder = createLocalBgeM3Embedder({ modelPath: modelPath ?? '', batchSize: 2 });
    const results = await embedder.embed([
      { id: 'zh', text: '这是一个本地记忆测试。' },
      { id: 'en', text: 'This is a local memory test.' },
      { id: 'zh-2', text: '本地模型应保持批量输入顺序。' },
      { id: 'en-2', text: 'Batch output order must remain stable.' },
      { id: 'zh-3', text: '向量将用于后续的本地语义索引。' },
    ]);

    expect(results.map(({ id }) => id)).toEqual(['zh', 'en', 'zh-2', 'en-2', 'zh-3']);
    for (const result of results) {
      expect(result.vector).toHaveLength(1024);
      expect(result.vector.every(Number.isFinite)).toBe(true);
      const norm = Math.sqrt(result.vector.reduce((sum, value) => sum + value * value, 0));
      expect(norm).toBeCloseTo(1, 5);
    }
    expect(embedder.metadata).toMatchObject({
      provider: 'transformers.js',
      model: 'Xenova/bge-m3',
      dimensions: 1024,
      normalized: true,
    });
  }, 90_000);
});
