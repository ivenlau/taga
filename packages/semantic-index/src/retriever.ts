import type { Embedder } from '../../embedding/src/index.js';
import type { DatabaseStore, MemoryIndexEntry } from '../../storage/src/index.js';
import type { Scope } from '../../domain/src/index.js';
import type { SearchInput, SemanticCandidate, SemanticRetriever } from '../../retrieval/src/index.js';
import type { SemanticIndexHit, ZvecMemoryIndex } from './index.js';

export interface ZvecSemanticRetrieverOptions {
  readonly database: DatabaseStore;
  readonly index: ZvecMemoryIndex;
  readonly embedder: Embedder;
  readonly overfetch?: number;
}

export class ZvecSemanticRetriever implements SemanticRetriever {
  private readonly overfetch: number;

  constructor(private readonly options: ZvecSemanticRetrieverOptions) {
    this.overfetch = options.overfetch ?? 8;
  }

  async search(input: SearchInput): Promise<readonly SemanticCandidate[]> {
    const query = input.query.trim();
    if (query.length === 0) return [];
    const [embedded] = await this.options.embedder.embed([{ id: 'semantic-query', text: query }]);
    if (embedded === undefined) return [];
    const hits = await this.options.index.query({
      vector: embedded.vector,
      topK: Math.max(input.limit ?? 10, 10) * this.overfetch,
    });
    return aggregateHits(hits, this.options.database, input.scope).slice(0, input.limit ?? 10);
  }
}

function aggregateHits(hits: readonly SemanticIndexHit[], database: DatabaseStore, scope?: Scope): SemanticCandidate[] {
  const best = new Map<string, SemanticIndexHit>();
  for (const hit of hits) {
    const current = best.get(hit.memoryId);
    if (current === undefined || hit.score < current.score || hit.score === current.score && hit.chunkIndex < current.chunkIndex) best.set(hit.memoryId, hit);
  }
  return [...best.values()]
    .sort((left, right) => left.score - right.score || left.memoryId.localeCompare(right.memoryId))
    .flatMap((hit) => {
      const memory = database.getMemoryIndex(hit.memoryId);
      if (memory === null || memory.contentHash !== hit.contentHash || !isRecallable(memory, scope)) return [];
      return [{
        memory,
        score: 1 / (1 + Math.max(0, hit.score)),
        matchReason: ['match:semantic', 'semantic:zvec', 'semantic:chunk:' + hit.chunkIndex],
        bestChunk: { index: hit.chunkIndex, start: hit.chunkStart, end: hit.chunkEnd },
      }];
    });
}

function isRecallable(entry: MemoryIndexEntry, target?: Scope): boolean {
  if (entry.status !== 'active' || entry.visibility === 'excluded') return false;
  if (target === undefined || entry.scopeKind === 'global') return true;
  if (target.kind === 'project') return entry.scopeKind === 'project' && entry.scopeId === target.id || entry.scopeKind === 'domain';
  if (target.kind === 'domain') return entry.scopeKind === 'domain' && entry.scopeId === target.id;
  return false;
}
