import { join } from 'node:path';
import {
  CONSOLIDATION_JOB_KIND,
  GovernanceService,
  ProactivePolicyService,
  SqliteAuditLog,
  consolidationPolicy,
  type ConsolidationConfig,
  type DedupVerdict,
} from '../../../packages/application/src/index.js';
import { chunkText, createLocalBgeM3Embedder } from '../../../packages/embedding/src/index.js';
import { GardenService } from '../../../packages/garden/src/index.js';
import type { NotificationService } from '../../../packages/notifications/src/index.js';
import { enqueueSemanticUpsert, ZvecMemoryIndex } from '../../../packages/semantic-index/src/index.js';
import { FtsRetrievalProvider } from '../../../packages/retrieval/src/index.js';
import { FetchOpenAiCompatibleProvider, metadataLlmBudgetState, withLlmBudget, type StructuredCompletionProvider } from '../../../packages/distillation/src/index.js';
import { MarkdownMemoryRepository, type DatabaseStore, type JobRecord, type StoredMemory } from '../../../packages/storage/src/index.js';
import { LlmMergeJudge } from './consolidation-llm.js';

export interface ConsolidationJobDeps {
  readonly notifications?: NotificationService;
}

interface DedupVerdictRecord {
  readonly verdict: DedupVerdict;
  readonly bestMatchId?: string;
  readonly score?: number;
  readonly mergedText?: string;
}

export function consolidationJobHandlers(
  brainPath: string,
  database: DatabaseStore,
  config: ConsolidationConfig,
  semanticModelPath: string,
  deps: ConsolidationJobDeps = {},
): ReadonlyMap<string, (job: JobRecord) => Promise<void>> {
  return new Map([
    [CONSOLIDATION_JOB_KIND, async () => { await runConsolidationScan(brainPath, database, config, semanticModelPath, deps); }],
  ]);
}

export async function runConsolidationScan(
  brainPath: string,
  database: DatabaseStore,
  config: ConsolidationConfig,
  semanticModelPath: string,
  deps: ConsolidationJobDeps = {},
): Promise<void> {
  if (!config.enabled) return;
  const audit = new SqliteAuditLog(database);
  const repository = new MarkdownMemoryRepository(brainPath);
  const records = await repository.records();
  const drafts = records.filter((record) => record.memory.status === 'draft' && record.memory.visibility !== 'excluded');
  if (drafts.length === 0) return;

  const dedup = await semanticDedupVerdicts(brainPath, database, config, semanticModelPath, records, drafts);
  const garden = new GardenService(database);
  const policy = new ProactivePolicyService(audit, consolidationPolicy(config));
  const governance = new GovernanceService(repository, audit);
  let failures = 0;

  for (const draft of drafts) {
    try {
      const memory = draft.memory;
      const verdict = dedup.verdicts.get(memory.id) ?? 'skipped';
      const bestMatch = dedup.bestMatch.get(memory.id);
      if ((verdict === 'duplicate' || verdict === 'merge') && bestMatch !== undefined) {
        const existing = records.find((record) => record.memory.id === bestMatch.memoryId);
        if (existing !== undefined) {
          reportOverlap(garden, deps.notifications, draft, existing, bestMatch, verdict, config, dedup.mergedText.get(memory.id));
        }
        continue;
      }
      if (verdict !== 'novel' && verdict !== 'keep' && verdict !== 'skipped') continue;
      if (memory.usefulCount < config.minUsefulCount) continue;
      if (memory.notUsefulCount >= config.maxNotUsefulCount) continue;
      const decision = await policy.decide({
        action: 'activate',
        subjectType: 'memory',
        subjectId: memory.id,
        memoryType: memory.type,
        confidence: memory.confidence,
        usefulCount: memory.usefulCount,
        dedupVerdict: verdict,
        scope: memory.scope,
      });
      if (!decision.allowed) continue;
      const updated = await governance.transition(
        memory.id,
        { type: 'activate' },
        { actor: 'daemon', actorId: 'consolidation' },
        `feedback auto-activation (useful=${memory.usefulCount}, dedup=${verdict})`,
      );
      new FtsRetrievalProvider(database).upsert(updated, draft.body);
      enqueueSemanticUpsert(database, updated.id, updated.contentHash);
      await deps.notifications?.enqueue({
        level: 'L1',
        kind: 'candidate',
        subjectType: 'memory',
        subjectId: updated.id,
        title: 'Memory auto-activated',
        message: `${updated.title} was promoted to active after ${memory.usefulCount} useful feedback(s) (dedup: ${verdict}).`,
        source: 'consolidation.scan',
        ...(memory.scope.kind === 'project' ? { projectId: memory.scope.id } : {}),
        dedupeKey: `auto-activate:${updated.id}`,
      });
    } catch {
      failures += 1;
    }
  }
  if (failures === drafts.length) throw new Error('consolidation scan failed for every draft');
}

async function semanticDedupVerdicts(
  brainPath: string,
  database: DatabaseStore,
  config: ConsolidationConfig,
  modelPath: string,
  records: readonly StoredMemory[],
  drafts: readonly StoredMemory[],
): Promise<{ verdicts: ReadonlyMap<string, DedupVerdict>; bestMatch: ReadonlyMap<string, { memoryId: string; score: number }>; mergedText: ReadonlyMap<string, string> }> {
  const verdicts = new Map<string, DedupVerdict>();
  const bestMatch = new Map<string, { memoryId: string; score: number }>();
  const mergedText = new Map<string, string>();
  const index = new ZvecMemoryIndex(join(brainPath, '.taga', 'semantic'));
  const integrity = await index.integrity();
  const semanticUnavailable = modelPath.length === 0 || integrity.activeGeneration === null;
  const semanticMismatch = !semanticUnavailable && (() => {
    const embedder = createLocalBgeM3Embedder({ modelPath, batchSize: 4 });
    return integrity.activeGeneration?.embeddingFingerprint !== embedder.metadata.fingerprint || integrity.activeGeneration?.dimensions !== embedder.metadata.dimensions;
  })();
  if (semanticUnavailable || semanticMismatch) {
    for (const draft of drafts) {
      const cached = loadVerdict(database, draft.memory.id, draft.memory.contentHash);
      if (cached === null) {
        verdicts.set(draft.memory.id, 'skipped');
        continue;
      }
      verdicts.set(draft.memory.id, cached.verdict);
      if (cached.bestMatchId !== undefined) bestMatch.set(draft.memory.id, { memoryId: cached.bestMatchId, score: cached.score ?? 0 });
      if (cached.mergedText !== undefined) mergedText.set(draft.memory.id, cached.mergedText);
    }
    return { verdicts, bestMatch, mergedText };
  }
  const embedder = createLocalBgeM3Embedder({ modelPath, batchSize: 4 });
  const judge = createMergeJudge(config, database);
  const byId = new Map(records.map((record) => [record.memory.id, record]));

  for (const draft of drafts) {
    const cached = loadVerdict(database, draft.memory.id, draft.memory.contentHash);
    if (cached !== null) {
      verdicts.set(draft.memory.id, cached.verdict);
      if (cached.bestMatchId !== undefined) bestMatch.set(draft.memory.id, { memoryId: cached.bestMatchId, score: cached.score ?? 0 });
      if (cached.mergedText !== undefined) mergedText.set(draft.memory.id, cached.mergedText);
      continue;
    }
    const found = await nearestActive(index, embedder, draft);
    let verdict: DedupVerdict = 'novel';
    let match: { memoryId: string; score: number } | undefined;
    let merged: string | undefined;
    if (found !== undefined) {
      match = found;
      if (found.score >= config.rejectSimilarity) {
        verdict = 'duplicate';
      } else if (found.score >= config.mergeSimilarity) {
        verdict = 'merge';
        const existing = byId.get(found.memoryId);
        if (judge !== undefined && existing !== undefined) {
          try {
            const decision = await judge.judge({
              draftTitle: draft.memory.title,
              draftBody: draft.body,
              existingTitle: existing.memory.title,
              existingBody: existing.body,
            });
            verdict = decision.action;
            merged = decision.mergedText;
          } catch {
            verdict = 'merge';
          }
        }
      }
    }
    verdicts.set(draft.memory.id, verdict);
    if (match !== undefined) bestMatch.set(draft.memory.id, match);
    if (merged !== undefined) mergedText.set(draft.memory.id, merged);
    saveVerdict(database, draft.memory.id, draft.memory.contentHash, {
      verdict,
      ...(match === undefined ? {} : { bestMatchId: match.memoryId, score: match.score }),
      ...(merged === undefined ? {} : { mergedText: merged }),
    });
  }
  return { verdicts, bestMatch, mergedText };
}

async function nearestActive(
  index: ZvecMemoryIndex,
  embedder: ReturnType<typeof createLocalBgeM3Embedder>,
  draft: StoredMemory,
): Promise<{ memoryId: string; score: number } | undefined> {
  const chunks = chunkText(`${draft.memory.title}\n\n${draft.memory.summary}\n\n${draft.body}`);
  const inputs = chunks.map((chunk) => ({ id: `${draft.memory.id}:${chunk.index}`, text: chunk.text }));
  const vectors = await embedder.embed(inputs);
  let best: { memoryId: string; score: number } | undefined;
  for (const vector of vectors) {
    const hits = await index.query({ vector: vector.vector, topK: 5, status: 'active' });
    for (const hit of hits) {
      const similarity = 1 / (1 + Math.max(0, hit.score));
      if (best === undefined || similarity > best.score) best = { memoryId: hit.memoryId, score: similarity };
    }
  }
  return best;
}

function reportOverlap(
  garden: GardenService,
  notifications: NotificationService | undefined,
  draft: StoredMemory,
  existing: StoredMemory,
  bestMatch: { memoryId: string; score: number },
  verdict: 'duplicate' | 'merge',
  config: ConsolidationConfig,
  mergedText: string | undefined,
): void {
  const proposal = garden.recordSemanticDuplicate({
    draft: draft.memory,
    existing: existing.memory,
    score: bestMatch.score,
    threshold: verdict === 'duplicate' ? config.rejectSimilarity : config.mergeSimilarity,
    verdict,
  });
  void notifications?.enqueue({
    level: 'L1',
    kind: 'conflict',
    subjectType: 'garden_proposal',
    subjectId: proposal.id,
    title: verdict === 'duplicate' ? 'Semantic duplicate detected' : 'Merge review suggested',
    message: mergedText === undefined
      ? proposal.reason
      : `${proposal.reason} — an LLM-suggested merged text is available (dedup metadata ${draft.memory.id}).`,
    source: 'consolidation.scan',
    dedupeKey: proposal.id,
  }).catch(() => undefined);
}

function createMergeJudge(config: ConsolidationConfig, database: DatabaseStore): LlmMergeJudge | undefined {
  if (config.llm === undefined) return undefined;
  const provider: StructuredCompletionProvider = withLlmBudget(new FetchOpenAiCompatibleProvider({
    endpoint: config.llm.endpoint,
    ...(config.llm.apiKey === undefined ? {} : { apiKey: config.llm.apiKey }),
  }), {
    ...(config.llm.dailyCap === undefined ? {} : { dailyCalls: config.llm.dailyCap }),
    ...(config.llm.dailyTokens === undefined ? {} : { dailyTokens: config.llm.dailyTokens }),
    ...(config.llm.perConsumerShare === undefined ? {} : { perConsumerShare: config.llm.perConsumerShare }),
  }, 'consolidation', metadataLlmBudgetState(database));
  return new LlmMergeJudge(provider, config.llm.model, config.llm.timeoutMs);
}

function verdictKey(memoryId: string, contentHash: string): string {
  return `consolidation:dedup:${memoryId}:${contentHash}`;
}

function loadVerdict(database: DatabaseStore, memoryId: string, contentHash: string): DedupVerdictRecord | null {
  const raw = database.getMetadata(verdictKey(memoryId, contentHash));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.verdict !== 'string' || !['novel', 'keep', 'merge', 'duplicate', 'skipped'].includes(parsed.verdict)) return null;
    if (parsed.contentHash !== contentHash) return null;
    return {
      verdict: parsed.verdict as DedupVerdict,
      ...(typeof parsed.bestMatchId === 'string' ? { bestMatchId: parsed.bestMatchId } : {}),
      ...(typeof parsed.score === 'number' ? { score: parsed.score } : {}),
      ...(typeof parsed.mergedText === 'string' ? { mergedText: parsed.mergedText } : {}),
    };
  } catch {
    return null;
  }
}

function saveVerdict(database: DatabaseStore, memoryId: string, contentHash: string, record: DedupVerdictRecord): void {
  database.upsertMetadata(verdictKey(memoryId, contentHash), JSON.stringify({
    schemaVersion: 1,
    memoryId,
    contentHash,
    verdict: record.verdict,
    bestMatchId: record.bestMatchId ?? null,
    score: record.score ?? null,
    ...(record.mergedText === undefined ? {} : { mergedText: record.mergedText }),
    at: new Date().toISOString(),
  }));
}
