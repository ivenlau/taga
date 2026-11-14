import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseMemory, type Memory } from '../../domain/src/index.js';
import { BrainLayout, parseMarkdownDocument, writeMarkdownDocument } from './markdown.js';

export interface StoredMemory {
  readonly memory: Memory;
  readonly body: string;
  readonly path: string;
}

export class MarkdownMemoryRepository {
  private readonly bodies = new Map<string, string>();

  constructor(private readonly brainPath: string) {}

  async get(id: string): Promise<Memory | null> {
    return (await this.list()).find((memory) => memory.id === id) ?? null;
  }

  async list(): Promise<Memory[]> {
    return (await this.records()).map((record) => record.memory);
  }

  async records(): Promise<StoredMemory[]> {
    const paths: string[] = [];
    await visit(this.brainPath, paths);
    const result: StoredMemory[] = [];
    for (const path of paths) {
      try {
        const parsed = parseMarkdownDocument(await readFile(path, 'utf8'));
        const memory = parseMemory(parsed.frontmatter);
        this.bodies.set(memory.id, parsed.body);
        result.push({ memory, body: parsed.body, path });
      } catch {
        continue;
      }
    }
    return result;
  }

  async save(memory: Memory): Promise<void> {
    const path = new BrainLayout(this.brainPath).memoryFilePath(memory.type, memory.scope, memory.id);
    const body = this.bodies.get(memory.id) ?? memory.summary;
    await writeMarkdownDocument(path, memory, body);
    this.bodies.set(memory.id, body);
  }

  setBody(memoryId: string, body: string): void {
    this.bodies.set(memoryId, body);
  }
}

async function visit(path: string, result: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  for (const entry of entries) {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) await visit(entryPath, result);
    else if (entry.isFile() && entry.name.endsWith('.md')) result.push(entryPath);
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
