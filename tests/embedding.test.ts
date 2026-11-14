import { describe, expect, it } from 'vitest';
import { chunkText, createDeterministicEmbedder, embeddingFingerprint, EmbeddingError } from '../packages/embedding/src/index.js';

describe('embedding foundation', () => {
  it('creates deterministic normalized vectors with stable metadata', async () => {
    const embedder = createDeterministicEmbedder();
    const first = await embedder.embed([{ id: 'memory-1', text: '重试 transient network failure' }]);
    const second = await embedder.embed([{ id: 'memory-1', text: '重试 transient network failure' }]);
    const vector = first[0]?.vector ?? [];
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));

    expect(vector).toHaveLength(1024);
    expect(first).toEqual(second);
    expect(norm).toBeCloseTo(1, 10);
    expect(embedder.metadata).toMatchObject({
      provider: 'deterministic',
      dimensions: 1024,
      pooling: 'mean',
      normalized: true,
      implementationVersion: 'taga-embedding-v1',
    });
    expect(embedder.metadata.fingerprint).toMatch(/^sha256:/u);
  });

  it('changes fingerprint when embedding configuration changes', () => {
    const first = createDeterministicEmbedder({ dimensions: 1024 }).metadata;
    const second = createDeterministicEmbedder({ dimensions: 768 }).metadata;
    expect(embeddingFingerprint(first)).not.toBe(embeddingFingerprint(second));
  });

  it('chunks text with stable ranges, overlap, and full coverage', () => {
    const text = '第一段内容。第二段内容包含更多信息。第三段内容用于验证切块范围。'.repeat(20);
    const chunks = chunkText(text, { maxCharacters: 80, overlapCharacters: 12 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.start).toBe(0);
    expect(chunks.at(-1)?.end).toBe(text.length);
    for (const [index, chunk] of chunks.entries()) {
      expect(chunk.end - chunk.start).toBeLessThanOrEqual(80);
      expect(chunk.text).toBe(text.slice(chunk.start, chunk.end));
      expect(chunk.id).toContain(`chunk-${index}-`);
      const next = chunks[index + 1];
      if (next !== undefined) expect(next.start).toBeLessThan(chunk.end);
    }
  });

  it('rejects invalid input without exposing source text', async () => {
    const embedder = createDeterministicEmbedder();
    await expect(embedder.embed([{ id: '', text: 'secret text' }])).rejects.toMatchObject({ code: 'invalid-input' });
    expect(() => chunkText('text', { maxCharacters: 4, overlapCharacters: 4 })).toThrow(EmbeddingError);
  });
});
