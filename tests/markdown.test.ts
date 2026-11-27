import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  contentHash,
  markerBegin,
  markerEnd,
  parseMarkdownDocument,
  removeManagedBlock,
  replaceManagedBlock,
  writeManagedBlock,
  writeMarkdownDocument,
} from '../packages/storage/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';

describe('Markdown storage primitives', () => {
  it('parses and serializes frontmatter while preserving the body', () => {
    const input = `---\nunknown: keep\ntitle: Example\n---\n\nUser content\n`;
    const parsed = parseMarkdownDocument(input);
    const output = `---\n${JSON.stringify(parsed.frontmatter)}\n---\n${parsed.body}`;

    expect(parsed.frontmatter).toMatchObject({ unknown: 'keep', title: 'Example' });
    expect(parsed.body).toBe('\nUser content\n');
    expect(output).toContain('User content');
  });

  it('changes only the managed marker block', () => {
    const before = `before\n${markerBegin}\nold\n${markerEnd}\nafter\n`;
    const after = replaceManagedBlock(before, 'new\nline');

    expect(after).toBe(`before\n${markerBegin}\nnew\nline\n${markerEnd}\nafter\n`);
    expect(after.slice(0, after.indexOf(markerBegin))).toBe('before\n');
    expect(after.slice(after.indexOf(markerEnd) + markerEnd.length)).toBe('\nafter\n');
  });

  it('rejects invalid or externally changed markers without writing', async () => {
    const fixture = await createTemporaryDirectory();
    const path = join(fixture.path, 'AGENTS.md');
    const original = `head\n${markerBegin}\nold\n${markerEnd}\ntail\n`;
    await writeFile(path, original, 'utf8');

    await expect(writeManagedBlock(path, 'new', contentHash(`${original}changed`))).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe(original);
    expect(() => replaceManagedBlock(`head\n${markerBegin}\nold\n${markerBegin}\n${markerEnd}`, 'new')).toThrow();

    await fixture.cleanup();
  });

  it('writes new Markdown files atomically with stable content hashes', async () => {
    const fixture = await createTemporaryDirectory();
    const path = join(fixture.path, 'memory.md');
    const hash = await writeMarkdownDocument(path, { schema_version: 1, title: 'Example' }, 'Body\n');

    expect(hash).toBe(contentHash(await readFile(path, 'utf8')));
    expect(parseMarkdownDocument(await readFile(path, 'utf8')).body).toBe('Body\n');
    await fixture.cleanup();
  });

  it('removes a managed block and reports when there is none', async () => {
    const fixture = await createTemporaryDirectory();
    const path = join(fixture.path, 'CLAUDE.md');
    expect(await removeManagedBlock(path)).toBe(false);

    await writeFile(path, `# Notes\n\n${markerBegin}\nold\n${markerEnd}\n`, 'utf8');
    expect(await removeManagedBlock(path)).toBe(true);
    expect(await readFile(path, 'utf8')).toBe('# Notes\n');

    await writeFile(path, `${markerBegin}\nold\n${markerEnd}\n\n# Notes\n`, 'utf8');
    expect(await removeManagedBlock(path)).toBe(true);
    expect(await readFile(path, 'utf8')).toBe('# Notes\n');

    await writeFile(path, '# Notes\n', 'utf8');
    expect(await removeManagedBlock(path)).toBe(false);
    expect(await readFile(path, 'utf8')).toBe('# Notes\n');

    // An unbalanced block is not Taga's to touch.
    await writeFile(path, `${markerBegin}\nold\n`, 'utf8');
    expect(await removeManagedBlock(path)).toBe(false);
    expect(await readFile(path, 'utf8')).toBe(`${markerBegin}\nold\n`);
    await fixture.cleanup();
  });
});
