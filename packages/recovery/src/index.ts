import { unlink, readFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite, markerBegin, markerEnd, parseManagedBlock, parseMarkdownDocument, replaceManagedBlock } from '../../storage/src/index.js';
import { FtsRetrievalProvider } from '../../retrieval/src/index.js';
import type { DatabaseStore } from '../../storage/src/index.js';
import { parseMemory, type Memory } from '../../domain/src/index.js';
import { TagaError, errorCodes } from '../../domain/src/index.js';
import { enqueueSemanticRebuild, enqueueSemanticRemove } from '../../semantic-index/src/index.js';

export interface ForgetPreview {
  readonly memoryId: string;
  readonly filePath: string;
  readonly indexed: boolean;
  readonly tombstoned: boolean;
  readonly impact: readonly string[];
}

export interface ReindexReport {
  readonly scanned: number;
  readonly indexed: number;
  readonly skippedTombstones: number;
  readonly orphanFiles: readonly string[];
}

interface MemoryFile {
  readonly memory: Memory;
  readonly path: string;
  readonly body: string;
}

interface ScannedFiles {
  readonly valid: readonly MemoryFile[];
  readonly orphanFiles: readonly string[];
}

export class RecoveryService {
  constructor(private readonly brainPath: string, private readonly database: DatabaseStore) {}

  async preview(memoryId: string): Promise<ForgetPreview> {
    const memoryFile = (await this.files()).find((item) => item.memory.id === memoryId);
    if (memoryFile === undefined) throw new TagaError(errorCodes.notFound, 'memory not found', { id: memoryId });
    return {
      memoryId,
      filePath: memoryFile.path,
      indexed: this.database.getMemoryIndex(memoryId) !== null,
      tombstoned: this.database.hasTombstone('memory', memoryId),
      impact: ['markdown', 'fts5', 'context-pack', 'replay'],
    };
  }

  async forget(memoryId: string, confirmed: boolean, reason = 'user requested forget', injectionPaths: readonly string[] = []): Promise<ForgetPreview> {
    const memoryFile = (await this.files()).find((item) => item.memory.id === memoryId);
    if (memoryFile === undefined) throw new TagaError(errorCodes.notFound, 'memory not found', { id: memoryId });
    const preview: ForgetPreview = {
      memoryId,
      filePath: memoryFile.path,
      indexed: this.database.getMemoryIndex(memoryId) !== null,
      tombstoned: this.database.hasTombstone('memory', memoryId),
      impact: ['markdown', 'fts5', 'context-pack', 'replay'],
    };
    if (!confirmed) throw new TagaError(errorCodes.validationFailed, 'forget requires explicit confirmation', { id: memoryId });
    try {
      await unlink(preview.filePath);
      this.database.transaction(() => {
        this.database.removeMemoryIndex(memoryId);
        enqueueSemanticRemove(this.database, memoryId);
        this.database.addTombstone('memory', memoryId, null, reason);
        this.database.upsertMetadata(`recovery:${memoryId}`, 'complete');
      });
      await this.removeFromInjectionTargets(memoryFile.memory, memoryFile.body, injectionPaths);
      return { ...preview, indexed: false, tombstoned: true };
    } catch (error) {
      this.database.upsertMetadata(`recovery:${memoryId}`, 'recovery_pending');
      throw error;
    }
  }

  async reindex(): Promise<ReindexReport> {
    await mkdir(this.brainPath, { recursive: true });
    const scanned = await this.scanFiles();
    const files = scanned.valid;
    const entries = [];
    let skippedTombstones = 0;
    for (const item of files) {
      if (this.database.hasTombstone('memory', item.memory.id)) {
        skippedTombstones += 1;
        continue;
      }
      entries.push({ memory: item.memory, body: item.body });
    }
    new FtsRetrievalProvider(this.database).rebuild(entries);
    enqueueSemanticRebuild(this.database);
    return { scanned: files.length + scanned.orphanFiles.length, indexed: entries.length, skippedTombstones, orphanFiles: scanned.orphanFiles };
  }

  private async files(): Promise<readonly MemoryFile[]> {
    return (await this.scanFiles()).valid;
  }

  private async scanFiles(): Promise<ScannedFiles> {
    const paths: string[] = [];
    await visit(this.brainPath, paths);
    const result: MemoryFile[] = [];
    const orphanFiles: string[] = [];
    for (const path of paths) {
      try {
        const parsed = parseMarkdownDocument(await readFile(path, 'utf8'));
        result.push({ memory: parseMemory(parsed.frontmatter), path, body: parsed.body });
      } catch {
        orphanFiles.push(path);
      }
    }
    return { valid: result, orphanFiles };
  }

  private async removeFromInjectionTargets(memory: Memory, body: string, paths: readonly string[]): Promise<void> {
    const exact = `${memory.title}\n${memory.summary}\n${body}`;
    for (const path of paths) {
      let current: string;
      try {
        current = await readFile(path, 'utf8');
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      if (!current.includes(markerBegin) && !current.includes(markerEnd)) continue;
      const block = parseManagedBlock(current);
      const sections = block.content
        .split(/\n\n(?=### |[^#])/u)
        .filter((section) => !section.includes(exact));
      await atomicWrite(path, replaceManagedBlock(current, sections.join('\n\n')));
    }
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
