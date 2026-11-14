import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { errorCodes, type MemoryType, type Scope, TagaError } from '../../domain/src/index.js';

export const markerBegin = '<!-- taga:begin v1 do-not-edit -->';
export const markerEnd = '<!-- taga:end -->';

export interface ParsedMarkdownDocument {
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
}

export interface ManagedBlock {
  readonly start: number;
  readonly end: number;
  readonly content: string;
}

export class BrainLayout {
  constructor(readonly root: string) {}

  memoryFilePath(type: MemoryType, scope: Scope, memoryId: string): string {
    const scopePath = scope.kind === 'global'
      ? 'global'
      : join(scope.kind, scope.id);
    return join(this.root, type, scopePath, `${memoryId}.md`);
  }
}

export function parseMarkdownDocument(content: string): ParsedMarkdownDocument {
  if (!content.startsWith('---\n')) {
    throw new TagaError(errorCodes.validationFailed, 'markdown frontmatter is missing');
  }
  const closingOffset = content.indexOf('\n---\n', 4);
  if (closingOffset < 0) {
    throw new TagaError(errorCodes.validationFailed, 'markdown frontmatter is not closed');
  }
  const frontmatter: unknown = parseYaml(content.slice(4, closingOffset)) as unknown;
  if (frontmatter === null || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    throw new TagaError(errorCodes.validationFailed, 'markdown frontmatter must be an object');
  }
  return {
    frontmatter: frontmatter as Record<string, unknown>,
    body: content.slice(closingOffset + '\n---\n'.length),
  };
}

export function serializeMarkdownDocument(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  return `---\n${stringifyYaml(frontmatter)}---\n${body}`;
}

export function parseManagedBlock(content: string): ManagedBlock {
  const beginOffsets = allOffsets(content, markerBegin);
  const endOffsets = allOffsets(content, markerEnd);
  if (beginOffsets.length !== 1 || endOffsets.length !== 1) {
    throw new TagaError(errorCodes.conflict, 'managed marker count is invalid');
  }
  const start = beginOffsets[0];
  const end = endOffsets[0];
  if (start === undefined || end === undefined || end <= start) {
    throw new TagaError(errorCodes.conflict, 'managed marker order is invalid');
  }
  const managedContentStart = start + markerBegin.length;
  return {
    start,
    end: end + markerEnd.length,
    content: content.slice(managedContentStart, end),
  };
}

export function replaceManagedBlock(content: string, generated: string): string {
  const block = parseManagedBlock(content);
  if (generated.includes(markerBegin) || generated.includes(markerEnd)) {
    throw new TagaError(errorCodes.validationFailed, 'generated content contains managed markers');
  }
  const replacement = `${markerBegin}\n${generated}\n${markerEnd}`;
  return `${content.slice(0, block.start)}${replacement}${content.slice(block.end)}`;
}

export function contentHash(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

export async function writeManagedBlock(
  path: string,
  generated: string,
  expectedHash?: string,
): Promise<string> {
  const before = await readFile(path, 'utf8');
  if (expectedHash !== undefined && contentHash(before) !== expectedHash) {
    throw new TagaError(errorCodes.conflict, 'markdown file changed externally');
  }
  const updated = replaceManagedBlock(before, generated);
  await atomicWrite(path, updated);
  return contentHash(updated);
}

export async function writeMarkdownDocument(
  path: string,
  frontmatter: Record<string, unknown>,
  body: string,
  expectedHash?: string,
): Promise<string> {
  let current = '';
  try {
    current = await readFile(path, 'utf8');
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }
  if (current !== '' && expectedHash !== undefined && contentHash(current) !== expectedHash) {
    throw new TagaError(errorCodes.conflict, 'markdown file changed externally');
  }
  const updated = serializeMarkdownDocument(frontmatter, body);
  await atomicWrite(path, updated);
  return contentHash(updated);
}

export async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, 'w');
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
  } finally {
    if (handle !== undefined) {
      await handle.close();
    }
    await rm(temporaryPath, { force: true });
  }
}

function allOffsets(content: string, token: string): number[] {
  const offsets: number[] = [];
  let offset = content.indexOf(token);
  while (offset >= 0) {
    offsets.push(offset);
    offset = content.indexOf(token, offset + token.length);
  }
  return offsets;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
