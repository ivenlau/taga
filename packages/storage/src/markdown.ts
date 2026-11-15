import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { errorCodes, type MemoryType, type Scope, TagaError } from '../../domain/src/index.js';

export const markerBegin = '<!-- taga:begin v1 do-not-edit -->';
export const markerEnd = '<!-- taga:end -->';
export const instructionBlockBegin = '<!-- taga:instructions:begin v1 do-not-edit -->';
export const instructionBlockEnd = '<!-- taga:instructions:end -->';

export interface ManagedBlockMarkers {
  readonly begin: string;
  readonly end: string;
}

const defaultMarkers: ManagedBlockMarkers = { begin: markerBegin, end: markerEnd };

function allKnownMarkers(): readonly string[] {
  return [markerBegin, markerEnd, instructionBlockBegin, instructionBlockEnd];
}

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
  const normalized = content.replace(/\r\n/gu, '\n');
  if (!normalized.startsWith('---\n')) {
    throw new TagaError(errorCodes.validationFailed, 'markdown frontmatter is missing');
  }
  const closingOffset = normalized.indexOf('\n---\n', 4);
  if (closingOffset < 0) {
    throw new TagaError(errorCodes.validationFailed, 'markdown frontmatter is not closed');
  }
  const frontmatter: unknown = parseYaml(normalized.slice(4, closingOffset)) as unknown;
  if (frontmatter === null || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    throw new TagaError(errorCodes.validationFailed, 'markdown frontmatter must be an object');
  }
  return {
    frontmatter: frontmatter as Record<string, unknown>,
    body: normalized.slice(closingOffset + '\n---\n'.length),
  };
}

export function serializeMarkdownDocument(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  return `---\n${stringifyYaml(frontmatter)}---\n${body}`;
}

export function parseManagedBlock(content: string, markers: ManagedBlockMarkers = defaultMarkers): ManagedBlock {
  const beginOffsets = allOffsets(content, markers.begin);
  const endOffsets = allOffsets(content, markers.end);
  if (beginOffsets.length !== 1 || endOffsets.length !== 1) {
    throw new TagaError(errorCodes.conflict, 'managed marker count is invalid');
  }
  const start = beginOffsets[0];
  const end = endOffsets[0];
  if (start === undefined || end === undefined || end <= start) {
    throw new TagaError(errorCodes.conflict, 'managed marker order is invalid');
  }
  const managedContentStart = start + markers.begin.length;
  return {
    start,
    end: end + markers.end.length,
    content: content.slice(managedContentStart, end),
  };
}

export function replaceManagedBlock(content: string, generated: string, markers: ManagedBlockMarkers = defaultMarkers): string {
  const block = parseManagedBlock(content, markers);
  for (const marker of allKnownMarkers()) {
    if (generated.includes(marker)) {
      throw new TagaError(errorCodes.validationFailed, 'generated content contains managed markers');
    }
  }
  const replacement = `${markers.begin}\n${generated}\n${markers.end}`;
  return `${content.slice(0, block.start)}${replacement}${content.slice(block.end)}`;
}

export function contentHash(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

export async function writeManagedBlock(
  path: string,
  generated: string,
  expectedHash?: string,
  markers: ManagedBlockMarkers = defaultMarkers,
): Promise<string> {
  const before = await readFile(path, 'utf8');
  if (expectedHash !== undefined && contentHash(before) !== expectedHash) {
    throw new TagaError(errorCodes.conflict, 'markdown file changed externally');
  }
  const updated = replaceManagedBlock(before, generated, markers);
  await atomicWrite(path, updated);
  return contentHash(updated);
}

export async function upsertManagedBlock(
  path: string,
  generated: string,
  markers: ManagedBlockMarkers,
): Promise<void> {
  let current = '';
  try {
    current = await readFile(path, 'utf8');
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  for (const marker of allKnownMarkers()) {
    if (generated.includes(marker)) {
      throw new TagaError(errorCodes.validationFailed, 'generated content contains managed markers');
    }
  }
  const updated = current.includes(markers.begin) && current.includes(markers.end)
    ? replaceManagedBlock(current, generated, markers)
    : `${current}${current.length === 0 ? '' : '\n'}${markers.begin}\n${generated}\n${markers.end}\n`;
  await atomicWrite(path, updated);
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
