import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';

export interface RerankCandidate {
  readonly memoryId: string;
  readonly title: string;
  readonly summary: string;
  readonly snippet: string;
  readonly fusedScore: number;
  readonly fusedRank: number;
}

export interface RerankedCandidate extends RerankCandidate {
  readonly rerankScore: number;
}

export interface RerankerMetadata {
  readonly provider: string;
  readonly model: string;
  readonly fingerprint: string;
}

export interface Reranker {
  readonly metadata: RerankerMetadata;
  rerank(input: {
    readonly query: string;
    readonly candidates: readonly RerankCandidate[];
    readonly limit?: number;
    readonly timeoutMs?: number;
  }): Promise<readonly RerankedCandidate[]>;
}

export interface LocalCrossEncoderOptions {
  readonly modelPath: string;
  readonly modelId?: string;
  readonly loader?: CrossEncoderPipelineLoader;
}

export type CrossEncoderPipeline = (
  texts: string | readonly string[],
  options?: { readonly text_pair?: string | readonly string[]; readonly top_k?: number },
) => Promise<unknown>;

export type CrossEncoderPipelineLoader = (modelPath: string) => Promise<CrossEncoderPipeline>;

export class RerankerError extends Error {
  constructor(readonly code: 'unavailable' | 'invalid' | 'unknown', message: string) {
    super(message);
    this.name = 'RerankerError';
  }
}

export function createLocalCrossEncoderReranker(options: LocalCrossEncoderOptions): Reranker {
  const model = options.modelId ?? 'BAAI/bge-reranker-v2-m3';
  const metadata: RerankerMetadata = {
    provider: 'transformers.js',
    model,
    fingerprint: `reranker:${model}:taga-v1`,
  };
  const loader = options.loader ?? defaultCrossEncoderPipelineLoader;
  let pipelinePromise: Promise<CrossEncoderPipeline> | undefined;
  const load = async (): Promise<CrossEncoderPipeline> => {
    if (pipelinePromise === undefined) {
      pipelinePromise = loader(options.modelPath).catch((error: unknown) => {
        pipelinePromise = undefined;
        throw classifyRerankerError(error);
      });
    }
    return pipelinePromise;
  };
  return {
    metadata,
    async rerank(input): Promise<readonly RerankedCandidate[]> {
      if (input.query.trim().length === 0 || input.candidates.length === 0) return [];
      const candidates = input.candidates.slice(0, input.limit ?? input.candidates.length);
      const classifier = await load();
      const queries = candidates.map(() => input.query);
      const documents = candidates.map(candidate => formatDocument(candidate));
      const result = await withTimeout(
        classifier(queries, { text_pair: documents, top_k: 1 }),
        input.timeoutMs ?? 350,
      );
      const scores = readScores(result, candidates.length);
      return candidates
        .map((candidate, index) => ({ ...candidate, rerankScore: scores[index] ?? 0 }))
        .sort((left, right) => right.rerankScore - left.rerankScore || left.fusedRank - right.fusedRank || left.memoryId.localeCompare(right.memoryId));
    },
  };
}

export function createDeterministicReranker(): Reranker {
  return {
    metadata: { provider: 'deterministic', model: 'token-overlap', fingerprint: 'reranker:deterministic:v1' },
    rerank(input): Promise<readonly RerankedCandidate[]> {
      const queryTokens = tokenize(input.query);
      return Promise.resolve(input.candidates
        .slice(0, input.limit ?? input.candidates.length)
        .map(candidate => {
          const documentTokens = new Set(tokenize(formatDocument(candidate)));
          const overlap = queryTokens.filter(token => documentTokens.has(token)).length;
          return { ...candidate, rerankScore: overlap / Math.max(queryTokens.length, 1) };
        })
        .sort((left, right) => right.rerankScore - left.rerankScore || left.fusedRank - right.fusedRank));
    },
  };
}

async function defaultCrossEncoderPipelineLoader(modelPath: string): Promise<CrossEncoderPipeline> {
  try {
    await access(modelPath, constants.F_OK);
  } catch {
    throw new RerankerError('unavailable', 'configured local reranker model path does not exist');
  }
  const transformers = await import('@huggingface/transformers');
  const tokenizer = await transformers.AutoTokenizer.from_pretrained(modelPath, { local_files_only: true });
  const model = await transformers.AutoModelForSequenceClassification.from_pretrained(modelPath, {
    dtype: 'fp32',
    local_files_only: true,
  }) as unknown as (inputs: unknown) => Promise<{ readonly logits: { tolist(): unknown } }>;
  return async (texts, options = {}) => {
    const inputs = typeof texts === 'string' ? [texts] : [...texts];
    const textPair = options.text_pair;
    const encoded = tokenizer(inputs, {
      ...(textPair === undefined ? {} : { text_pair: typeof textPair === 'string' ? inputs.map(() => textPair) : [...textPair] }),
      padding: true,
      truncation: true,
    });
    const output = await model(encoded);
    const values: unknown = output.logits.tolist();
    if (!Array.isArray(values)) throw new RerankerError('invalid', 'reranker returned invalid logits');
    return values.map((row: unknown) => ({
      label: 'LABEL_0',
      score: sigmoid(Number(Array.isArray(row) ? row[0] ?? 0 : 0)),
    }));
  };
}

function sigmoid(value: number): number {
  return value >= 0 ? 1 / (1 + Math.exp(-value)) : Math.exp(value) / (1 + Math.exp(value));
}

function readScores(value: unknown, expected: number): number[] {
  if (!Array.isArray(value)) throw new RerankerError('invalid', 'reranker returned an invalid batch');
  const items = value as readonly unknown[];
  return items.slice(0, expected).map(item => {
    const output: unknown = Array.isArray(item) ? item[0] : item;
    if (typeof output !== 'object' || output === null || !('score' in output)) return 0;
    const score = Number((output as { readonly score: unknown }).score);
    return Number.isFinite(score) ? score : 0;
  });
}

function formatDocument(candidate: RerankCandidate): string {
  return [candidate.title, candidate.summary, candidate.snippet].filter(Boolean).join('\n');
}

function tokenize(value: string): string[] {
  return value.toLocaleLowerCase().normalize('NFKC').match(/[\p{L}\p{N}_-]+/gu) ?? [];
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new RerankerError('invalid', 'reranker timeout must be positive');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new RerankerError('unknown', 'reranker timeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function rerankerCacheKey(query: string, candidate: RerankCandidate, fingerprint: string): string {
  return createHash('sha256').update(`${fingerprint}\n${query}\n${candidate.memoryId}\n${candidate.snippet}`).digest('hex');
}

function classifyRerankerError(error: unknown): RerankerError {
  if (error instanceof RerankerError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return /enoent|not found|local_files_only|model path/i.test(message)
    ? new RerankerError('unavailable', 'local reranker model is unavailable')
    : new RerankerError('unknown', 'local reranker provider failed');
}
