import { scopeWeight } from '../../application/src/index.js';
import type { Memory, MemoryType, Scope } from '../../domain/src/index.js';
import type { DatabaseStore, MemoryIndexEntry } from '../../storage/src/index.js';

export interface SearchInput {
  readonly query: string;
  readonly alternates?: readonly string[];
  readonly scope?: Scope;
  readonly limit?: number;
  readonly now?: string;
  readonly includeDraft?: boolean;
}

export const DRAFT_RECALL_PENALTY = 0.5;

const MAX_QUERY_ALTERNATES = 6;

export interface RecallCandidate {
  readonly memory: MemoryIndexEntry;
  readonly score: number;
  readonly matchReason: readonly string[];
  readonly source: 'fts5';
}

export interface SemanticCandidate {
  readonly memory: MemoryIndexEntry;
  readonly score: number;
  readonly matchReason?: readonly string[];
  readonly bestChunk?: { readonly index: number; readonly start: number; readonly end: number };
}

export interface SemanticRetriever {
  search(input: SearchInput): Promise<readonly SemanticCandidate[]>;
}

export interface HybridRecallCandidate {
  readonly memory: MemoryIndexEntry;
  readonly score: number;
  readonly relevance: number;
  readonly lexicalScore?: number;
  readonly semanticScore?: number;
  readonly matchReason: readonly string[];
  readonly source: 'fts5' | 'hybrid';
}

export interface HybridRetrievalResult {
  readonly items: readonly HybridRecallCandidate[];
  readonly degraded: boolean;
  readonly semanticAvailable: boolean;
  readonly repairSuggestion?: 'reindex';
}

export interface ProgressiveIndexRow {
  readonly id: string;
  readonly title: string;
  readonly type: MemoryTypeForIndex;
  readonly scope: string;
  readonly updatedAt: string;
  readonly score: number;
  readonly matchReason: readonly string[];
}

export interface OfflineQueryCase {
  readonly query: string;
  readonly relevantIds: readonly string[];
  readonly scope?: Scope;
  readonly now?: string;
}

export interface OfflineEvaluationReport {
  readonly queries: number;
  readonly recallAt5: number;
  readonly recallAt10: number;
  readonly precisionAt5: number;
  readonly mrr: number;
  readonly ndcgAt10: number;
  readonly zeroResultRate: number;
  readonly averageLatencyMs: number;
}
export interface ProgressiveDetail {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly sources: readonly string[];
  readonly truncated: boolean;
}

type MemoryTypeForIndex = MemoryIndexEntry['type'];
type LexicalBranchName = 'phrase' | 'strict' | 'relaxed' | 'alias' | 'identifier' | 'trigram' | `alternate:${number}`;

interface LexicalBranch {
  readonly name: LexicalBranchName;
  readonly weight: number;
  readonly results: readonly { readonly memory: MemoryIndexEntry; readonly rank: number }[];
}

export interface LexicalPlan {
  readonly tokens: readonly string[];
  readonly phraseQuery?: string;
  readonly strictQuery: string;
  readonly relaxedQuery: string;
  readonly aliasQuery?: string;
  readonly identifierQuery?: string;
  readonly trigramQuery?: string;
  readonly memoryTypeHint?: MemoryType;
  readonly timeRange?: { readonly start: number; readonly end: number };
}

export const DEFAULT_LEXICAL_ALIASES: Readonly<Record<string, readonly string[]>> = {
  access: ['permission', 'authorization'],
  permission: ['access', 'authorization'],
  migrate: ['migration'],
  migration: ['migrate', 'schema'],
  retry: ['backoff', 'retries'],
  backoff: ['retry', 'retries'],
  failure: ['error', 'failed'],
  error: ['failure', 'failed'],
  claude: ['claude-code'],
  codex: ['codex-cli'],
};

export class FtsRetrievalProvider {
  private readonly aliases: Readonly<Record<string, readonly string[]>>;

  constructor(
    private readonly database: DatabaseStore,
    options: { readonly aliases?: Readonly<Record<string, readonly string[]>> } = {},
  ) {
    this.aliases = options.aliases ?? DEFAULT_LEXICAL_ALIASES;
  }

  upsert(memory: Memory, body: string): void {
    this.database.upsertMemoryIndex(toIndexEntry(memory, body));
  }

  remove(memoryId: string): void {
    this.database.removeMemoryIndex(memoryId);
  }

  rebuild(entries: readonly { memory: Memory; body: string }[]): void {
    this.database.rebuildMemoryIndex(entries.map(({ memory, body }) => toIndexEntry(memory, body)));
  }

  search(input: SearchInput): RecallCandidate[] {
    const limit = input.limit ?? 10;
    if (limit <= 0 || !Number.isInteger(limit)) return [];
    const plan = buildLexicalQueryPlan(input.query, input.now, this.aliases);
    if (plan.tokens.length === 0) return [];
    const fetchLimit = Math.max(limit * 4, 20);
    const branches: LexicalBranch[] = [];
    if (plan.phraseQuery !== undefined) branches.push(this.runBranch('phrase', plan.phraseQuery, 1, input, fetchLimit));
    branches.push(this.runBranch('strict', plan.strictQuery, 0.95, input, fetchLimit));
    if ((branches.at(-1)?.results.length ?? 0) < limit) {
      branches.push(this.runBranch('relaxed', plan.relaxedQuery, 0.55, input, fetchLimit));
    }
    if (plan.aliasQuery !== undefined) {
      branches.push(this.runBranch('alias', plan.aliasQuery, 0.45, input, fetchLimit));
    }
    if (plan.identifierQuery !== undefined) {
      branches.push(this.runBranch('identifier', plan.identifierQuery, 0.9, input, fetchLimit));
    }
    (input.alternates ?? []).slice(0, MAX_QUERY_ALTERNATES).forEach((alternate, index) => {
      const alternateQuery = buildTokenQuery(tokenizeQuery(alternate), 'OR');
      if (alternateQuery !== '""') branches.push(this.runBranch(`alternate:${index}`, alternateQuery, 0.6, input, fetchLimit));
    });
    let results = fuseLexicalBranches(branches, input, plan);
    if (results.length < limit && plan.trigramQuery !== undefined) {
      const trigramBranch = this.runBranch('trigram', plan.trigramQuery, 0.25, input, fetchLimit);
      results = fuseLexicalBranches([...branches, trigramBranch], input, plan);
    }
    return results.slice(0, limit);
  }

  async searchHybrid(input: SearchInput, semantic: SemanticRetriever | undefined): Promise<HybridRetrievalResult> {
    const lexical = this.search(input).map((item) => ({
      memory: item.memory,
      score: item.score,
      matchReason: item.matchReason,
    }));
    if (semantic === undefined) {
      return {
        items: lexical.map((item) => ({ ...item, relevance: item.score, source: 'fts5' as const })),
        degraded: false,
        semanticAvailable: false,
      };
    }
    try {
      const semanticResults = await semantic.search(input);
      const filtered = semanticResults.filter((item) => isRecallable(item.memory, input.scope, input));
      const fused = fuseRankedResults(lexical, filtered, { includeDraft: input.includeDraft === true });
      return {
        items: fused.slice(0, input.limit ?? 10),
        degraded: false,
        semanticAvailable: true,
      };
    } catch {
      return {
        items: lexical.map((item) => ({ ...item, relevance: item.score, source: 'fts5' as const, matchReason: [...item.matchReason, 'semantic:unavailable'] })),
        degraded: true,
        semanticAvailable: false,
        repairSuggestion: 'reindex' as const,
      };
    }
  }

  searchSafe(input: SearchInput): RetrievalResult {
    try {
      return { items: this.search(input), degraded: false };
    } catch {
      return { items: [], degraded: true, repairSuggestion: 'reindex' };
    }
  }

  get(memoryId: string): MemoryIndexEntry | null {
    return this.database.getMemoryIndex(memoryId);
  }

  timeline(memoryId: string): TimelineEvent[] {
    const entry = this.get(memoryId);
    return entry === null ? [] : [{ memoryId, event: 'indexed', occurredAt: entry.updatedAt }];
  }

  why(memoryId: string, query: string): readonly string[] {
    const result = this.search({ query, limit: 50 }).find(({ memory }) => memory.id === memoryId);
    return result?.matchReason ?? [];
  }

  private runBranch(name: LexicalBranchName, query: string, weight: number, input: SearchInput, limit: number): LexicalBranch {
    if (query.length === 0) return { name, weight, results: [] };
    try {
      const matches = name === 'trigram'
        ? this.database.searchMemoryTrigram(query, limit)
        : this.database.searchMemoryIndex(query, limit);
      return {
        name,
        weight,
        results: matches
          .filter(({ entry }) => isRecallable(entry, input.scope, input))
          .map(({ entry }, index) => ({ memory: entry, rank: index + 1 })),
      };
    } catch {
      return { name, weight, results: [] };
    }
  }
}

export class ProgressiveRecallService {
  constructor(private readonly provider: FtsRetrievalProvider) {}

  index(input: SearchInput & { readonly limit?: number }): ProgressiveIndexRow[] {
    return this.provider.search(input).map((result) => ({
      id: result.memory.id,
      title: result.memory.title,
      type: result.memory.type,
      scope: result.memory.scopeKind === 'global' ? 'global' : `${result.memory.scopeKind}:${result.memory.scopeId ?? ''}`,
      updatedAt: result.memory.updatedAt,
      score: result.score,
      matchReason: result.matchReason,
    }));
  }

  timeline(memoryId: string, limit = 7): TimelineEvent[] {
    return this.provider.timeline(memoryId).slice(0, Math.max(0, limit));
  }

  details(memoryIds: readonly string[], maxBodyCharacters = 8_000, options?: { readonly includeDraft?: boolean }): ProgressiveDetail[] {
    const limit = Math.max(0, maxBodyCharacters);
    return memoryIds.flatMap((memoryId) => {
      const memory = this.provider.get(memoryId);
      if (memory === null || memory.visibility === 'excluded') return [];
      if (memory.status !== 'active' && !(options?.includeDraft === true && memory.status === 'draft')) return [];
      const body = memory.body;
      return [{
        id: memory.id,
        title: memory.title,
        summary: memory.summary,
        body: body.slice(0, limit),
        sources: memory.sourceRefs === undefined ? [] : [...memory.sourceRefs],
        truncated: body.length > limit,
      }];
    });
  }
}

export function evaluateOfflineRetrieval(provider: FtsRetrievalProvider, cases: readonly OfflineQueryCase[]): OfflineEvaluationReport {
  if (cases.length === 0) {
    return { queries: 0, recallAt5: 0, recallAt10: 0, precisionAt5: 0, mrr: 0, ndcgAt10: 0, zeroResultRate: 0, averageLatencyMs: 0 };
  }
  let recallAt5 = 0;
  let recallAt10 = 0;
  let precisionAt5 = 0;
  let mrr = 0;
  let ndcgAt10 = 0;
  let zeroResultCount = 0;
  let latencyMs = 0;
  for (const testCase of cases) {
    const started = Date.now();
    const results = provider.search({ query: testCase.query, ...(testCase.scope === undefined ? {} : { scope: testCase.scope }), ...(testCase.now === undefined ? {} : { now: testCase.now }), limit: 10 });
    latencyMs += Date.now() - started;
    if (results.length === 0) zeroResultCount += 1;
    const relevant = new Set(testCase.relevantIds);
    const ids = results.map((result) => result.memory.id);
    const hitsAt5 = ids.slice(0, 5).filter((id) => relevant.has(id)).length;
    const hitsAt10 = ids.slice(0, 10).filter((id) => relevant.has(id)).length;
    recallAt5 += hitsAt5 / Math.max(1, relevant.size);
    recallAt10 += hitsAt10 / Math.max(1, relevant.size);
    precisionAt5 += hitsAt5 / Math.max(1, Math.min(5, ids.length));
    const firstRelevant = ids.findIndex((id) => relevant.has(id));
    mrr += firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1);
    const ideal = Math.min(relevant.size, 10);
    const dcg = ids.slice(0, 10).reduce((sum, id, index) => sum + (relevant.has(id) ? 1 / Math.log2(index + 2) : 0), 0);
    const idcg = Array.from({ length: ideal }, (_, index) => 1 / Math.log2(index + 2)).reduce((sum, value) => sum + value, 0);
    ndcgAt10 += idcg === 0 ? 0 : dcg / idcg;
  }
  return {
    queries: cases.length,
    recallAt5: recallAt5 / cases.length,
    recallAt10: recallAt10 / cases.length,
    precisionAt5: precisionAt5 / cases.length,
    mrr: mrr / cases.length,
    ndcgAt10: ndcgAt10 / cases.length,
    zeroResultRate: zeroResultCount / cases.length,
    averageLatencyMs: latencyMs / cases.length,
  };
}
export function buildFtsQuery(input: string): string {
  const tokens = tokenizeQuery(input);
  return buildTokenQuery(tokens, 'AND');
}

export function buildLexicalQueryPlan(
  input: string,
  nowInput?: string,
  aliases: Readonly<Record<string, readonly string[]>> = DEFAULT_LEXICAL_ALIASES,
): LexicalPlan {
  const tokens = tokenizeQuery(input);
  const phraseQuery = tokens.length >= 2 ? `"${tokens.join(' ')}"` : undefined;
  const expanded = unique([...tokens, ...tokens.flatMap((token) => aliases[token] ?? [])]);
  const aliasTokens = expanded.filter((token) => !tokens.includes(token));
  const identifierTokens = extractIdentifierTokens(input);
  const timeRange = parseTimeRange(input, nowInput);
  const memoryTypeHint = inferMemoryType(input);
  return {
    tokens,
    ...(phraseQuery === undefined ? {} : { phraseQuery }),
    strictQuery: buildTokenQuery(tokens, 'AND'),
    relaxedQuery: buildTokenQuery(tokens, 'OR'),
    ...(aliasTokens.length === 0 ? {} : { aliasQuery: buildTokenQuery(aliasTokens, 'OR') }),
    ...(identifierTokens.length === 0 ? {} : { identifierQuery: buildIdentifierQuery(identifierTokens) }),
    ...(tokens.length === 0 ? {} : { trigramQuery: buildTrigramQuery(tokens) }),
    ...(memoryTypeHint === undefined ? {} : { memoryTypeHint }),
    ...(timeRange === undefined ? {} : { timeRange }),
  };
}

export function buildTrigramQuery(tokens: readonly string[]): string {
  return unique(tokens.flatMap(makeTrigrams)).slice(0, 96).map((token) => `"${token}"`).join(' OR ');
}

function buildTokenQuery(tokens: readonly string[], operator: 'AND' | 'OR'): string {
  if (tokens.length === 0) return '""';
  return tokens.map((token) => `"${escapeFtsToken(token)}"*`).join(` ${operator} `);
}

function buildIdentifierQuery(tokens: readonly string[]): string {
  return tokens.map((token) => ['paths', 'symbols', 'commands', 'error_codes'].map((field) => `${field} : "${escapeFtsToken(token)}"*`).join(' OR ')).join(' OR ');
}

function tokenizeQuery(input: string): string[] {
  const tokens = input.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return unique(tokens.filter((token) => !['and', 'or', 'not'].includes(token)));
}

function extractIdentifierTokens(input: string): string[] {
  return unique((input.normalize('NFKC').match(/[A-Za-z][A-Za-z0-9_./:-]{2,}/g) ?? []).flatMap((value) => tokenizeQuery(value)));
}

function inferMemoryType(input: string): MemoryType | undefined {
  const value = input.normalize('NFKC').toLocaleLowerCase();
  if (/偏好|喜欢|默认|prefer|default|always|never|禁止|不要/u.test(value)) return 'preferences';
  if (/步骤|流程|怎么做|procedure|runbook|how to/u.test(value)) return 'procedures';
  if (/经验|教训|lesson|learned|失败/u.test(value)) return 'lessons';
  if (/环境|配置|environment|config/u.test(value)) return 'environment';
  if (/项目|project/u.test(value)) return 'projects';
  return undefined;
}

function parseTimeRange(input: string, nowInput?: string): { readonly start: number; readonly end: number } | undefined {
  const value = input.normalize('NFKC').toLocaleLowerCase();
  const now = nowInput === undefined ? Date.now() : Date.parse(nowInput);
  if (!Number.isFinite(now)) return undefined;
  const day = 24 * 60 * 60 * 1000;
  if (/今天|today/u.test(value)) return { start: startOfDay(now), end: startOfDay(now) + day };
  if (/昨天|yesterday/u.test(value)) return { start: startOfDay(now) - day, end: startOfDay(now) };
  if (/最近|recent|latest/u.test(value)) return { start: now - 30 * day, end: now + day };
  if (/上周|last week/u.test(value)) {
    const current = startOfDay(now);
    const weekday = new Date(current).getUTCDay() || 7;
    const end = current - (weekday - 1) * day;
    return { start: end - 7 * day, end };
  }
  const date = value.match(/\b(20\d{2}-\d{2}-\d{2})\b/u)?.[1];
  if (date !== undefined) {
    const start = Date.parse(`${date}T00:00:00.000Z`);
    return Number.isFinite(start) ? { start, end: start + day } : undefined;
  }
  return undefined;
}

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function fuseLexicalBranches(branches: readonly LexicalBranch[], input: SearchInput, plan: LexicalPlan): RecallCandidate[] {
  const byId = new Map<string, { memory: MemoryIndexEntry; relevance: number; reasons: Set<string> }>();
  for (const branch of branches) {
    branch.results.forEach((result) => {
      const current = byId.get(result.memory.id) ?? { memory: result.memory, relevance: 0, reasons: new Set<string>() };
      current.relevance += branch.weight / (60 + result.rank);
      current.reasons.add(`match:${branch.name}`);
      byId.set(result.memory.id, current);
    });
  }
  return [...byId.values()]
    .map((item) => {
      const scope = scopeForEntry(item.memory);
      const temporal = timeBoost(item.memory.updatedAt, plan.timeRange);
      const type = plan.memoryTypeHint === undefined || item.memory.type === plan.memoryTypeHint ? 1.12 : 0.94;
      const draftRecall = item.memory.status === 'draft';
      const draftPenalty = draftRecall ? DRAFT_RECALL_PENALTY : 1;
      const score = item.relevance * scopeWeight(scope) * item.memory.confidence * sourceTrustWeight(item.memory.sourceTrust) * temporal * type * draftPenalty;
      const reasons = [...item.reasons, `scope:${scope.kind}`, draftRecall ? 'status:draft:unverified' : `status:${item.memory.status}`, 'rank:rrf'];
      reasons.push(...proofReasons(item.memory));
      if (plan.memoryTypeHint !== undefined) reasons.push(`type:${item.memory.type === plan.memoryTypeHint ? 'match' : 'mismatch'}`);
      if (plan.timeRange !== undefined) reasons.push(`time:${temporal > 1 ? 'match' : 'outside'}`);
      return { memory: item.memory, score, matchReason: reasons, source: 'fts5' as const };
    })
    .sort((left, right) => right.score - left.score || left.memory.id.localeCompare(right.memory.id));
}

function proofReasons(entry: MemoryIndexEntry): readonly string[] {
  const reasons: string[] = [];
  if ((entry.usefulCount ?? 0) > 0) reasons.push(`proof:useful:${entry.usefulCount}`);
  if (entry.lastVerified !== undefined && entry.lastVerified !== null) reasons.push('proof:verified');
  return reasons;
}

function timeBoost(updatedAt: string, range: LexicalPlan['timeRange']): number {
  if (range === undefined) return 1;
  const timestamp = Date.parse(updatedAt);
  return Number.isFinite(timestamp) && timestamp >= range.start && timestamp < range.end ? 1.18 : 0.9;
}

function toIndexEntry(memory: Memory, body: string): MemoryIndexEntry {
  const refs = [...memory.sources, ...memory.anchors];
  const sourceRefs = unique(refs.map((source) => `${source.kind}:${source.locator}`));
  return {
    id: memory.id,
    type: memory.type,
    status: memory.status,
    visibility: memory.visibility,
    scopeKind: memory.scope.kind,
    scopeId: memory.scope.kind === 'global' ? null : memory.scope.id,
    title: memory.title,
    summary: memory.summary,
    body,
    tags: memory.tags,
    paths: unique(refs.filter((source) => source.kind === 'file' || source.kind === 'line').map((source) => source.locator)),
    symbols: unique(refs.filter((source) => source.kind === 'symbol').map((source) => source.locator)),
    commands: extractCommands(`${memory.title}\n${memory.summary}\n${body}`),
    errorCodes: extractErrorCodes(`${memory.title}\n${memory.summary}\n${body}`),
    aliases: unique([...memory.tags, memory.type, ...memory.sources.map((source) => source.label ?? '')].filter((value) => value.length > 0)),
    sourceRefs,
    confidence: memory.confidence,
    sourceTrust: memory.sourceTrust,
    contentHash: memory.contentHash,
    updatedAt: memory.updated,
    usefulCount: memory.usefulCount,
    notUsefulCount: memory.notUsefulCount,
    ...(memory.lastVerified === undefined || memory.lastVerified === null ? {} : { lastVerified: memory.lastVerified }),
  };
}

function extractCommands(input: string): string[] {
  return unique((input.match(/\b(?:pnpm|npm|yarn|git|taga|node|docker|cargo|go|python)\s+[A-Za-z0-9_./:@=-]+/giu) ?? []).map((value) => value.toLocaleLowerCase()));
}

function extractErrorCodes(input: string): string[] {
  return unique(input.match(/\b(?:E[A-Z][A-Z0-9_]+|HTTP[- ]?\d{3}|[A-Z]{2,}_[A-Z0-9_]+)\b/gu) ?? []);
}

function makeTrigrams(value: string): string[] {
  const characters = Array.from(value.normalize('NFKC').toLocaleLowerCase());
  const result: string[] = [];
  for (let index = 0; index <= characters.length - 3; index += 1) result.push(characters.slice(index, index + 3).join(''));
  return result;
}

function escapeFtsToken(token: string): string {
  return token.replaceAll('"', '""');
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function scopeForEntry(entry: MemoryIndexEntry): Scope {
  if (entry.scopeKind === 'global') return { kind: 'global' };
  if (entry.scopeKind === 'domain' || entry.scopeKind === 'project') return { kind: entry.scopeKind, id: entry.scopeId ?? '' };
  return { kind: 'global' };
}

function isRecallable(entry: MemoryIndexEntry, target?: Scope, options?: { readonly includeDraft?: boolean }): boolean {
  if (entry.visibility === 'excluded') return false;
  if (entry.status === 'active') return scopeMatches(entry, target);
  if (options?.includeDraft === true && entry.status === 'draft') return scopeMatches(entry, target);
  return false;
}

function scopeMatches(entry: MemoryIndexEntry, target?: Scope): boolean {
  if (entry.scopeKind === 'global') return true;
  if (target === undefined) return entry.scopeKind === 'domain';
  if (target.kind === 'project') return entry.scopeKind === 'project' && entry.scopeId === target.id || entry.scopeKind === 'domain';
  if (target.kind === 'domain') return entry.scopeKind === 'domain' && entry.scopeId === target.id;
  return false;
}

function sourceTrustWeight(sourceTrust: string): number {
  switch (sourceTrust) {
    case 'user_authored': return 1;
    case 'observed': return 0.9;
    case 'inferred': return 0.7;
    default: return 0;
  }
}

function fuseRankedResults(
  lexical: readonly { readonly memory: MemoryIndexEntry; readonly score: number; readonly matchReason: readonly string[] }[],
  semantic: readonly SemanticCandidate[],
  options: { readonly lexicalWeight?: number; readonly semanticWeight?: number; readonly includeDraft?: boolean },
): HybridRecallCandidate[] {
  const lexicalWeight = options.lexicalWeight ?? 1;
  const semanticWeight = options.semanticWeight ?? 1;
  const byId = new Map<string, {
    memory: MemoryIndexEntry;
    lexicalRank?: number;
    semanticRank?: number;
    lexicalScore?: number;
    semanticScore?: number;
    reasons: string[];
  }>();
  lexical.forEach((item, index) => {
    byId.set(item.memory.id, {
      memory: item.memory,
      lexicalRank: index + 1,
      lexicalScore: item.score,
      reasons: [...item.matchReason, 'match:lexical'],
    });
  });
  semantic.forEach((item, index) => {
    const current = byId.get(item.memory.id);
    if (current === undefined) {
      byId.set(item.memory.id, {
        memory: item.memory,
        semanticRank: index + 1,
        semanticScore: item.score,
        reasons: [...(item.matchReason ?? []), 'match:semantic'],
      });
      return;
    }
    current.semanticRank = index + 1;
    current.semanticScore = item.score;
    current.reasons.push(...(item.matchReason ?? []), 'match:semantic');
  });
  return [...byId.values()]
    .map((item) => {
      const draftRecall = options.includeDraft === true && item.memory.status === 'draft';
      const draftPenalty = draftRecall ? DRAFT_RECALL_PENALTY : 1;
      const relevance = (lexicalWeight * (item.lexicalRank === undefined ? 0 : 1 / (60 + item.lexicalRank))
        + semanticWeight * (item.semanticRank === undefined ? 0 : 1 / (60 + item.semanticRank))) * draftPenalty;
      const reasons = draftRecall && item.lexicalRank === undefined ? [...item.reasons, 'status:draft:unverified'] : item.reasons;
      reasons.push(...proofReasons(item.memory));
      return {
        memory: item.memory,
        score: relevance,
        relevance,
        ...(item.lexicalScore === undefined ? {} : { lexicalScore: item.lexicalScore }),
        ...(item.semanticScore === undefined ? {} : { semanticScore: item.semanticScore }),
        matchReason: [...new Set(reasons)],
        source: item.lexicalRank === undefined ? 'hybrid' as const : item.semanticRank === undefined ? 'fts5' as const : 'hybrid' as const,
      };
    })
    .sort((left, right) => right.relevance - left.relevance || left.memory.id.localeCompare(right.memory.id));
}

export interface RetrievalResult {
  readonly items: readonly RecallCandidate[];
  readonly degraded: boolean;
  readonly repairSuggestion?: 'reindex';
};

export interface TimelineEvent {
  readonly memoryId: string;
  readonly event: 'indexed';
  readonly occurredAt: string;
};
