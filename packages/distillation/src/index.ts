import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  ProactivePolicyService,
  DEFAULT_PROACTIVE_POLICY,
  GovernanceService,
  llmConfigFromEnv,
  type AuditLog,
  type LifecycleActor,
  type LlmConfig,
  type MemoryRepository,
} from '../../application/src/index.js';
import {
  parseCandidate,
  parseMemory,
  type Candidate,
  type EvidenceEvent,
  type Memory,
  type Observation,
} from '../../domain/src/index.js';
import { z } from 'zod';
import type { DatabaseStore } from '../../storage/src/index.js';
import type { NotificationService } from '../../notifications/src/index.js';
import { classifySegment, extractProseSummary, memoryTypeForObservation, type EvidenceSignal } from './mining.js';
import type { CandidatePolisher, PolishResult } from './polish.js';

export * from './mining.js';
export * from './polish.js';
export * from './adjudicate.js';

export interface DistillationInput {
  readonly observation: Observation;
  readonly evidence: readonly EvidenceEvent[];
  readonly verified?: boolean;
}

export interface DistillationGate {
  readonly accepted: boolean;
  readonly reasons: readonly string[];
}

export interface Distiller {
  distill(input: DistillationInput): Promise<Candidate>;
}

export interface StructuredCompletionRequest {
  readonly system: string;
  readonly user: string;
  readonly model: string;
  readonly timeoutMs: number;
}

export interface StructuredCompletionResponse {
  readonly text: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly latencyMs: number;
  readonly cost?: number;
}

export interface StructuredCompletionProvider {
  complete(request: StructuredCompletionRequest): Promise<StructuredCompletionResponse>;
}

export interface LlmDistillerOptions {
  readonly provider: StructuredCompletionProvider;
  readonly providerName: string;
  readonly model: string;
  readonly promptVersion?: string;
  readonly timeoutMs?: number;
}

export interface DistillationFallbackEvent {
  readonly provider: string;
  readonly model: string;
  readonly reason: string;
  readonly errorKind?: string;
  readonly evidenceIds: readonly string[];
}

/** Failure taxonomy for LLM calls: only 'other' is retry-ambiguous; the rest never warrant retries. */
export function classifyLlmError(message: string): 'rate-limit' | 'quota' | 'auth' | 'timeout' | 'output' | 'other' {
  if (/\b429\b|rate.?limit|too many requests/iu.test(message)) return 'rate-limit';
  if (/\b402\b|quota|billing|insufficient/iu.test(message)) return 'quota';
  if (/\b401\b|\b403\b|unauthor|forbidden|api key/iu.test(message)) return 'auth';
  if (/timeout|aborted/iu.test(message)) return 'timeout';
  if (/json|schema|invalid|unsupported evidence|did not contain/iu.test(message)) return 'output';
  return 'other';
}

const llmDraftSchema = z.object({
  memoryType: z.enum(['preferences', 'environment', 'procedures', 'lessons', 'projects']),
  title: z.string().min(1).max(120),
  summary: z.string().min(1),
  body: z.string(),
  confidence: z.number().min(0).max(1),
  facts: z.array(z.object({
    text: z.string().min(1),
    evidenceIds: z.array(z.string().min(1)).min(1),
    confidence: z.number().min(0).max(1).optional(),
  })).default([]),
  entities: z.array(z.object({
    name: z.string().min(1),
    type: z.string().min(1).optional(),
    evidenceIds: z.array(z.string().min(1)).min(1),
  })).default([]),
  temporalFacts: z.array(z.object({
    text: z.string().min(1),
    occurredStart: z.string().optional(),
    occurredEnd: z.string().optional(),
    evidenceIds: z.array(z.string().min(1)).min(1),
  })).default([]),
  causalLinks: z.array(z.object({
    fromFact: z.string().min(1),
    toFact: z.string().min(1),
    relation: z.enum(['causes', 'enables', 'prevents', 'contradicts']),
    evidenceIds: z.array(z.string().min(1)).min(1),
  })).default([]),
  applicability: z.object({
    conditions: z.array(z.string().min(1)).default([]),
    exclusions: z.array(z.string().min(1)).default([]),
  }).default({ conditions: [], exclusions: [] }),
});

type LlmDraft = z.infer<typeof llmDraftSchema>;

export class LlmDistiller implements Distiller {
  private readonly timeoutMs: number;
  private readonly promptVersion: string;

  constructor(private readonly options: LlmDistillerOptions) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.promptVersion = options.promptVersion ?? 'm4-llm-v1';
  }

  async distill(input: DistillationInput): Promise<Candidate> {
    const response = await withTimeout(this.options.provider.complete({
      system: llmSystemPrompt(),
      user: buildLlmUserPrompt(input),
      model: this.options.model,
      timeoutMs: this.timeoutMs,
    }), this.timeoutMs);
    const draft = parseLlmDraft(response.text);
    validateDraftSources(draft, input.evidence);
    const first = input.evidence[0];
    if (first === undefined) throw new Error('evidence is required');
    return parseCandidate({
      id: `candidate-${randomUUID()}`,
      observationId: input.observation.id,
      ...(first.agentId === undefined ? {} : { agentId: first.agentId }),
      ...(first.projectId === undefined ? {} : { projectId: first.projectId }),
      ...(first.sessionId === undefined ? {} : { sessionId: first.sessionId }),
      ...(first.taskId === undefined ? {} : { taskId: first.taskId }),
      memoryType: draft.memoryType,
      title: draft.title,
      summary: draft.summary,
      body: draft.body,
      scopeSuggestion: input.observation.projectId === undefined
        ? { kind: 'global' as const }
        : { kind: 'project' as const, id: input.observation.projectId },
      worthLearning: input.observation.reuse >= 0.55,
      evidenceIds: input.evidence.map((event) => event.id),
      anchors: uniqueEvidenceRefs(input.evidence),
      confidence: Math.min(0.95, Math.max(0.5, draft.confidence)),
      facts: draft.facts.map((fact) => ({ ...fact, confidence: fact.confidence ?? draft.confidence })),
      entities: draft.entities,
      temporalFacts: draft.temporalFacts,
      causalLinks: draft.causalLinks,
      applicabilityDetails: draft.applicability,
      createdAt: input.observation.createdAt,
      decision: 'pending' as const,
      model: {
        provider: this.options.providerName,
        model: this.options.model,
        mode: 'llm' as const,
        promptVersion: this.promptVersion,
        schemaVersion: 'candidate-v2',
        inputEvidenceIds: input.evidence.map((event) => event.id),
        ...(response.inputTokens === undefined ? {} : { inputTokens: response.inputTokens }),
        ...(response.outputTokens === undefined ? {} : { outputTokens: response.outputTokens }),
        latencyMs: response.latencyMs,
        ...(response.cost === undefined ? {} : { cost: response.cost }),
      },
    });
  }
}

export class FetchOpenAiCompatibleProvider implements StructuredCompletionProvider {
  constructor(private readonly options: { endpoint: string; apiKey?: string; headers?: Record<string, string> }) {}

  async complete(request: StructuredCompletionRequest): Promise<StructuredCompletionResponse> {
    const started = Date.now();
    const response = await fetch(this.options.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.options.apiKey === undefined ? {} : { authorization: `Bearer ${this.options.apiKey}` }),
        ...this.options.headers,
      },
      body: JSON.stringify({
        model: request.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.user }],
      }),
      signal: AbortSignal.timeout(request.timeoutMs),
    });
    if (!response.ok) throw new Error(`LLM provider returned HTTP ${response.status}`);
    const payload: unknown = await response.json();
    return {
      text: readOpenAiText(payload),
      latencyMs: Date.now() - started,
      ...readOpenAiUsage(payload),
    };
  }
}

export function createLlmProvider(config: { readonly mode: 'off' | 'shadow' | 'on'; readonly endpoint: string; readonly apiKey?: string }): StructuredCompletionProvider | undefined {
  if (config.mode === 'off' || config.endpoint.length === 0) return undefined;
  return new FetchOpenAiCompatibleProvider({
    endpoint: config.endpoint,
    ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
  });
}

/** Persisted daily usage so the cap survives wrapper/chain recreation (e.g. one chain per job). */
export interface DailyCapState {
  load(day: string): number;
  save(day: string, count: number): void;
}

export function withDailyCap(
  provider: StructuredCompletionProvider,
  cap: number,
  clock: () => Date = () => new Date(),
  state?: DailyCapState,
): StructuredCompletionProvider {
  let day = clock().toISOString().slice(0, 10);
  let count = state?.load(day) ?? 0;
  return {
    complete: (request: StructuredCompletionRequest): Promise<StructuredCompletionResponse> => {
      const today = clock().toISOString().slice(0, 10);
      if (today !== day) {
        day = today;
        count = state?.load(day) ?? 0;
      }
      if (count >= cap) {
        return Promise.reject(new Error(`llm daily cap reached (${cap} calls on ${day})`));
      }
      count += 1;
      state?.save(day, count);
      return provider.complete(request);
    },
  };
}

export interface LlmConsumerUsage {
  calls: number;
  tokens: number;
}

/** Per-day usage record; `consumers` buckets by chain consumer (distill/learn/reflect/consolidation). */
export interface LlmBudgetUsage {
  calls: number;
  tokens: number;
  consumers: Record<string, LlmConsumerUsage>;
  warned?: boolean;
}

export interface LlmBudgetConfig {
  readonly dailyCalls?: number;
  readonly dailyTokens?: number;
  /** Share of the daily budget a single consumer may use; 1 disables the split. */
  readonly perConsumerShare?: number;
}

export interface LlmBudgetState {
  load(day: string): LlmBudgetUsage | null;
  save(day: string, usage: LlmBudgetUsage): void;
}

export function estimateRequestTokens(request: StructuredCompletionRequest): number {
  return Math.ceil((request.system.length + request.user.length) / 4);
}

function emptyBudgetUsage(): LlmBudgetUsage {
  return { calls: 0, tokens: 0, consumers: {} };
}

/**
 * Choke-point LLM budget gate: enforces daily calls, daily tokens (actual usage when the
 * provider reports it, request estimate otherwise) and a per-consumer share. Beyond the
 * budget the call rejects so callers fail over to deterministic paths.
 */
export function withLlmBudget(
  provider: StructuredCompletionProvider,
  config: LlmBudgetConfig,
  consumer = 'default',
  state?: LlmBudgetState,
  clock: () => Date = () => new Date(),
): StructuredCompletionProvider {
  let day = clock().toISOString().slice(0, 10);
  let usage: LlmBudgetUsage = state?.load(day) ?? emptyBudgetUsage();
  return {
    complete: (request: StructuredCompletionRequest): Promise<StructuredCompletionResponse> => {
      const today = clock().toISOString().slice(0, 10);
      if (today !== day) {
        day = today;
        usage = state?.load(day) ?? emptyBudgetUsage();
      }
      const estimate = estimateRequestTokens(request);
      const mine = usage.consumers[consumer] ?? { calls: 0, tokens: 0 };
      const share = config.perConsumerShare ?? 1;
      const consumerCallLimit = config.dailyCalls === undefined ? undefined : Math.floor(config.dailyCalls * share);
      const consumerTokenLimit = config.dailyTokens === undefined ? undefined : Math.floor(config.dailyTokens * share);
      if (config.dailyCalls !== undefined && usage.calls >= config.dailyCalls) {
        return Promise.reject(new Error(`llm daily cap reached (${config.dailyCalls} calls on ${day})`));
      }
      if (config.dailyTokens !== undefined && usage.tokens + estimate > config.dailyTokens) {
        return Promise.reject(new Error(`llm daily token budget reached (${config.dailyTokens} tokens on ${day})`));
      }
      if (share < 1 && consumerCallLimit !== undefined && mine.calls >= consumerCallLimit) {
        return Promise.reject(new Error(`llm consumer budget reached (${consumer} ${consumerCallLimit} calls on ${day})`));
      }
      if (share < 1 && consumerTokenLimit !== undefined && mine.tokens + estimate > consumerTokenLimit) {
        return Promise.reject(new Error(`llm consumer budget reached (${consumer} ${consumerTokenLimit} tokens on ${day})`));
      }
      return provider.complete(request).then((response) => {
        const tokens = (response.inputTokens ?? 0) + (response.outputTokens ?? 0) || estimate;
        usage = {
          calls: usage.calls + 1,
          tokens: usage.tokens + tokens,
          consumers: { ...usage.consumers, [consumer]: { calls: mine.calls + 1, tokens: mine.tokens + tokens } },
          ...(usage.warned === undefined ? {} : { warned: usage.warned }),
        };
        state?.save(day, usage);
        return response;
      });
    },
  };
}

export function metadataLlmBudgetState(database: DatabaseStore): LlmBudgetState {
  return {
    load: (day: string): LlmBudgetUsage | null => {
      const raw = database.getMetadata(`llm-budget:${day}`);
      if (raw === null) return null;
      try {
        const parsed = JSON.parse(raw) as Partial<LlmBudgetUsage>;
        if (typeof parsed !== 'object' || parsed === null) return null;
        return {
          calls: typeof parsed.calls === 'number' ? parsed.calls : 0,
          tokens: typeof parsed.tokens === 'number' ? parsed.tokens : 0,
          consumers: typeof parsed.consumers === 'object' && parsed.consumers !== null ? parsed.consumers : {},
          ...(parsed.warned === undefined ? {} : { warned: parsed.warned }),
        };
      } catch {
        return null;
      }
    },
    save: (day: string, usage: LlmBudgetUsage): void => {
      database.upsertMetadata(`llm-budget:${day}`, JSON.stringify(usage));
    },
  };
}

function readOpenAiUsage(payload: unknown): { readonly inputTokens?: number; readonly outputTokens?: number } {
  if (typeof payload !== 'object' || payload === null) return {};
  const usage = (payload as Record<string, unknown>).usage;
  if (typeof usage !== 'object' || usage === null) return {};
  const inputTokens = (usage as Record<string, unknown>).prompt_tokens;
  const outputTokens = (usage as Record<string, unknown>).completion_tokens;
  return {
    ...(typeof inputTokens === 'number' ? { inputTokens } : {}),
    ...(typeof outputTokens === 'number' ? { outputTokens } : {}),
  };
}

export class FallbackDistiller implements Distiller {
  constructor(
    private readonly primary: Distiller,
    private readonly fallback: Distiller,
    private readonly onFallback?: (event: DistillationFallbackEvent) => void,
  ) {}

  async distill(input: DistillationInput): Promise<Candidate> {
    try {
      return await this.primary.distill(input);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'provider-failed';
      this.onFallback?.({ provider: 'primary', model: 'configured', reason, errorKind: classifyLlmError(reason), evidenceIds: input.evidence.map((event) => event.id) });
      const fallback = await this.fallback.distill(input);
      return parseCandidate({
        ...fallback,
        model: fallback.model === undefined
          ? {
              provider: 'deterministic-auto',
              model: 'm3',
              mode: 'deterministic',
              promptVersion: 'fallback',
              schemaVersion: 'candidate-v2',
              inputEvidenceIds: input.evidence.map((event) => event.id),
              latencyMs: 0,
              fallbackReason: reason,
            }
          : { ...fallback.model, fallbackReason: reason },
      });
    }
  }
}

export class ShadowDistiller implements Distiller {
  constructor(
    private readonly deterministic: Distiller,
    private readonly shadow: Distiller,
    private readonly onComparison: (comparison: { readonly deterministic: Candidate; readonly shadow: Candidate | null; readonly error?: string }) => void,
  ) {}

  async distill(input: DistillationInput): Promise<Candidate> {
    const deterministic = await this.deterministic.distill(input);
    try {
      const shadow = await this.shadow.distill(input);
      this.onComparison({ deterministic, shadow });
    } catch (error) {
      this.onComparison({ deterministic, shadow: null, error: error instanceof Error ? error.message : 'shadow-provider-failed' });
    }
    return deterministic;
  }
}

export class FakeDistiller implements Distiller {
  constructor(private readonly provider = 'fake', private readonly model = 'fixture') {}

  distill(input: DistillationInput): Promise<Candidate> {
    const first = input.evidence[0];
    if (first === undefined) throw new Error('evidence is required');
    const memoryType = memoryTypeForObservation(input.observation.kind);
    const candidate = {
      id: `candidate-${randomUUID()}`,
      observationId: input.observation.id,
      ...(first.agentId === undefined ? {} : { agentId: first.agentId }),
      ...(first.projectId === undefined ? {} : { projectId: first.projectId }),
      ...(first.sessionId === undefined ? {} : { sessionId: first.sessionId }),
      ...(first.taskId === undefined ? {} : { taskId: first.taskId }),
      memoryType,
      title: input.observation.summary.slice(0, 120),
      summary: input.observation.summary,
      body: first.payload.text ?? first.payload.summary,
      scopeSuggestion: input.observation.projectId === undefined
        ? { kind: 'global' as const }
        : { kind: 'project' as const, id: input.observation.projectId },
      worthLearning: input.observation.reuse >= 0.55,
      evidenceIds: input.evidence.map((event) => event.id),
      anchors: input.evidence.flatMap((event) => event.refs).filter((ref, index, refs) => refs.findIndex((item) => item.kind === ref.kind && item.locator === ref.locator) === index),
      confidence: Math.min(0.95, Math.max(0.5, (input.observation.evidenceQuality + input.observation.reuse + input.observation.novelty) / 3 + (input.evidence.some((event) => event.refs.some((ref) => ref.kind === 'test' || ref.kind === 'commit')) ? 0.1 : 0))),
      createdAt: input.observation.createdAt,
      decision: 'pending' as const,
      model: {
        provider: this.provider,
        model: this.model,
        mode: 'deterministic' as const,
        promptVersion: 'prompt-v1',
        schemaVersion: 'candidate-v2',
        inputEvidenceIds: input.evidence.map((event) => event.id),
        inputTokens: input.evidence.reduce((sum, event) => sum + Math.ceil((event.payload.text ?? event.payload.summary).length / 4), 0),
        outputTokens: Math.ceil(input.observation.summary.length / 4),
        latencyMs: 0,
      },
    };
    return Promise.resolve(parseCandidate(candidate));
  }
}

export interface CandidateRepository {
  save(candidate: Candidate): void;
  get(id: string): Candidate | null;
  list(): Candidate[];
}

export class InMemoryCandidateRepository implements CandidateRepository {
  private readonly items = new Map<string, Candidate>();

  save(candidate: Candidate): void {
    this.items.set(candidate.id, candidate);
  }

  get(id: string): Candidate | null {
    return this.items.get(id) ?? null;
  }

  list(): Candidate[] {
    return [...this.items.values()];
  }
}

export class JsonCandidateRepository implements CandidateRepository {
  constructor(private readonly path: string) {}

  save(candidate: Candidate): void {
    const items = this.list().filter((item) => item.id !== candidate.id);
    items.push(candidate);
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(items)}\n`, 'utf8');
    renameSync(temporary, this.path);
  }

  get(id: string): Candidate | null {
    return this.list().find((candidate) => candidate.id === id) ?? null;
  }

  list(): Candidate[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      if (!Array.isArray(parsed)) return [];
      return parsed.map((candidate) => parseCandidate(candidate));
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }
}

export class DatabaseCandidateRepository implements CandidateRepository {
  constructor(private readonly database: DatabaseStore) {}

  save(candidate: Candidate): void {
    this.database.saveCandidate(candidate);
  }

  get(id: string): Candidate | null {
    return this.database.getCandidate(id);
  }

  list(): Candidate[] {
    return [...this.database.listCandidates()];
  }
}

export class DistillationService {
  constructor(
    private readonly provider: Distiller,
    private readonly candidates: CandidateRepository,
  ) {}

  async createCandidate(input: DistillationInput): Promise<Candidate | null> {
    const gate = evaluateGate(input);
    if (!gate.accepted) return null;
    const candidate = await this.provider.distill(input);
    const duplicate = this.candidates.list().find((existing) => existing.decision === 'pending' && existing.memoryType === candidate.memoryType && JSON.stringify(existing.scopeSuggestion) === JSON.stringify(candidate.scopeSuggestion) && existing.summary === candidate.summary);
    if (duplicate !== undefined) return duplicate;
    this.candidates.save(candidate);
    return candidate;
  }
}

export interface SemanticDuplicateVerdict {
  readonly duplicate: boolean;
  readonly duplicateOf?: string;
  readonly score?: number;
}

export interface AutomaticDistillationOptions {
  readonly clock?: () => Date;
  readonly policy?: ConstructorParameters<typeof ProactivePolicyService>[1];
  readonly audit?: AuditLog;
  readonly memories?: MemoryRepository;
  readonly notifications?: NotificationService;
  readonly duplicateGate?: (candidate: Candidate) => Promise<SemanticDuplicateVerdict | undefined>;
  readonly polisher?: CandidatePolisher;
}

export interface AutomaticDistillationReport {
  readonly segments: number;
  readonly candidates: number;
  readonly duplicates: number;
  readonly rejected: number;
  readonly activated: number;
  readonly reasons: readonly string[];
}

export class AutomaticDistillationService {
  private readonly clock: () => Date;

  constructor(
    private readonly database: DatabaseStore,
    private readonly provider: Distiller = new FakeDistiller('deterministic-auto', 'm3'),
    private readonly candidates: CandidateRepository = new DatabaseCandidateRepository(database),
    private readonly options: AutomaticDistillationOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
  }

  async run(input: { readonly projectId?: string; readonly sessionId?: string; readonly eventIds?: readonly string[] } = {}): Promise<AutomaticDistillationReport> {
    const policy = new ProactivePolicyService(this.options.audit ?? new NoopAuditLog(), this.options.policy ?? DEFAULT_PROACTIVE_POLICY, this.clock);
    const policyDecision = await policy.decide({ action: 'distill', subjectType: 'distillation_run', subjectId: `${input.projectId ?? 'all'}:${input.sessionId ?? 'all'}` });
    if (!policyDecision.allowed) return { segments: 0, candidates: 0, duplicates: 0, rejected: 0, activated: 0, reasons: [policyDecision.reason] };

    const scoped = input.eventIds === undefined
      ? this.database.listEvidence()
      : input.eventIds
        .map((id) => this.database.getEvidence(id))
        .filter((event): event is EvidenceEvent => event !== null);
    const evidence = scoped.filter((event) =>
      (input.projectId === undefined || event.projectId === input.projectId) &&
      (input.sessionId === undefined || event.sessionId === input.sessionId),
    );
    const groups = groupEvidence(evidence);
    let candidates = 0;
    let duplicates = 0;
    let rejected = 0;
    let activated = 0;
    const reasons: string[] = [];
    let knownMemories = this.options.memories === undefined ? null : await this.options.memories.list();
    const processed = new Set(this.database.listObservations().map((item) => item.id));
    const distillSegment = async (segment: readonly EvidenceEvent[], observation: Observation): Promise<void> => {
      const service = new DistillationService(this.provider, this.candidates);
      const candidate = await service.createCandidate({ observation, evidence: segment, verified: true });
      if (candidate === null) {
        rejected += 1;
        reasons.push(`${observation.id}:value-gate-rejected`);
        await this.recordDecision('distillation.rejected', observation.id, 'value-gate-rejected', { evidenceIds: observation.evidenceIds });
        return;
      }
      const proposed = { ...candidate, decisionReason: 'candidate-created' };
      this.candidates.save(proposed);
      const matchingMemory = knownMemories === null
        ? null
        : knownMemories.find((memory) => memory.status !== 'forgotten' && memory.type === proposed.memoryType && memory.summary === proposed.summary);
      if (matchingMemory !== undefined && matchingMemory !== null) {
        this.candidates.save({ ...proposed, decisionReason: 'duplicate-memory', duplicateOf: matchingMemory.id });
        duplicates += 1;
        reasons.push(`${proposed.id}:duplicate-memory:${matchingMemory.id}`);
        await this.recordDecision('distillation.duplicate', proposed.id, 'duplicate-memory', { duplicateOf: matchingMemory.id });
        return;
      }
      const gate = this.options.duplicateGate === undefined ? undefined : await this.options.duplicateGate(proposed);
      if (gate !== undefined && gate.duplicate) {
        this.candidates.save({ ...proposed, decisionReason: 'semantic-duplicate', ...(gate.duplicateOf === undefined ? {} : { duplicateOf: gate.duplicateOf }) });
        duplicates += 1;
        reasons.push(`${proposed.id}:semantic-duplicate:${gate.duplicateOf ?? 'unknown'}`);
        await this.recordDecision('distillation.semantic_duplicate', proposed.id, 'semantic-duplicate', { ...(gate.duplicateOf === undefined ? {} : { duplicateOf: gate.duplicateOf }), ...(gate.score === undefined ? {} : { score: gate.score }) });
        return;
      }
      candidates += 1;
      await this.recordDecision('distillation.candidate_created', proposed.id, 'candidate-created', { memoryType: proposed.memoryType, scope: proposed.scopeSuggestion, confidence: proposed.confidence });
      await this.options.notifications?.enqueue({
        level: 'L1',
        kind: 'candidate',
        subjectType: 'candidate',
        subjectId: proposed.id,
        title: proposed.title,
        message: proposed.summary,
        source: 'automatic-distillation',
        scope: proposed.scopeSuggestion,
        ...(proposed.scopeSuggestion.kind === 'project' ? { projectId: proposed.scopeSuggestion.id } : {}),
        dedupeKey: proposed.summary,
      });
      if (proposed.memoryType === 'lessons' && this.options.audit !== undefined && this.options.memories !== undefined) {
        const activation = await policy.decide({ action: 'activate', subjectType: 'candidate', subjectId: proposed.id, memoryType: proposed.memoryType, confidence: proposed.confidence, evidenceGatePassed: true, scope: proposed.scopeSuggestion });
        if (activation.allowed) {
          await new ReviewService(this.candidates, this.options.memories, this.options.audit, this.clock, this.options.polisher).accept(proposed.id, { actor: 'daemon' }, activation.reason);
          activated += 1;
          knownMemories = await this.options.memories.list();
        }
      }
    };
    for (const segment of groups) {
      const observation = buildObservation(segment, this.clock);
      if (!observation.verified) {
        rejected += 1;
        reasons.push(`${observation.observation.id}:verification-required`);
        await this.recordDecision('distillation.rejected', observation.observation.id, 'verification-required', { evidenceIds: observation.observation.evidenceIds });
        continue;
      }
      if (processed.has(observation.observation.id)) continue;
      await distillSegment(segment, observation.observation);
      this.database.saveObservation(observation.observation);
      processed.add(observation.observation.id);
    }
    return { segments: groups.length, candidates, duplicates, rejected, activated, reasons };
  }

  private async recordDecision(eventType: string, subjectId: string, reason: string, payload: Record<string, unknown>): Promise<void> {
    if (this.options.audit === undefined) return;
    await this.options.audit.append({
      eventType,
      actor: 'daemon',
      subjectType: 'distillation',
      subjectId,
      occurredAt: this.clock().toISOString(),
      reason,
      payload,
    });
  }
}

export class ReviewService {
  constructor(
    private readonly candidates: CandidateRepository,
    private readonly memories: MemoryRepository,
    private readonly audit: AuditLog,
    private readonly clock: () => Date = () => new Date(),
    private readonly polisher?: CandidatePolisher,
  ) {}

  list(): Candidate[] {
    return this.candidates.list().filter((candidate) => candidate.decision === 'pending');
  }

  async reject(id: string, actor: LifecycleActor, reason: string): Promise<Candidate> {
    const candidate = this.require(id);
    if (candidate.decision !== 'pending') throw new Error(`candidate is already ${candidate.decision}`);
    const updated = parseCandidate({ ...candidate, decision: 'rejected', decidedAt: this.clock().toISOString() });
    this.candidates.save(updated);
    await this.audit.append({
      eventType: 'candidate.rejected',
      actor: actor.actor,
      ...(actor.actorId === undefined ? {} : { actorId: actor.actorId }),
      subjectType: 'candidate',
      subjectId: id,
      occurredAt: this.clock().toISOString(),
      reason,
      payload: { title: candidate.title, memoryType: candidate.memoryType },
    });
    return updated;
  }

  async accept(id: string, actor: LifecycleActor, reason: string): Promise<Memory> {
    const candidate = this.require(id);
    const now = this.clock().toISOString();
    // L2 polish: one bounded quality pass on accepted deterministic drafts; any failure keeps the draft.
    const polish: PolishResult | null = this.polisher !== undefined && candidate.model?.mode === 'deterministic'
      ? await this.polisher.polish(candidate)
      : null;
    const polished = polish !== null && polish.polished;
    const memory = parseMemory({
      schemaVersion: 1,
      id: `memory-${randomUUID()}`,
      type: candidate.memoryType,
      scope: candidate.scopeSuggestion,
      projectId: candidate.scopeSuggestion.kind === 'project' ? candidate.scopeSuggestion.id : null,
      status: 'active',
      title: polished ? polish.title : candidate.title,
      summary: polished ? polish.summary : candidate.summary,
      confidence: polished && polish.confidence !== undefined ? polish.confidence : candidate.confidence,
      sourceTrust: 'observed',
      visibility: 'private',
      created: now,
      updated: now,
      lastVerified: null,
      lastRecalled: null,
      reviewCount: 1,
      usefulCount: 0,
      notUsefulCount: 0,
      expiresAt: null,
      contentHash: `sha256:${candidate.id}`,
      sources: candidate.evidenceIds.map((evidenceId) => ({ kind: 'tool_call' as const, locator: `evidence:${evidenceId}` })),
      anchors: [],
      tags: [],
      supersedes: null,
    });
    const governance = new GovernanceService(this.memories, this.audit, this.clock);
    await governance.create(memory, actor, reason);
    this.candidates.save({ ...candidate, decision: 'accepted', decidedAt: this.clock().toISOString() });
    return memory;
  }

  merge(id: string, replacementId: string): Candidate {
    const candidate = this.require(id);
    if (id === replacementId) throw new Error('candidate cannot merge itself');
    const replacement = this.require(replacementId);
    const updated = { ...candidate, decision: 'merged' as const, decidedAt: this.clock().toISOString(), summary: `${candidate.summary}\nMerged with ${replacement.id}.` };
    this.candidates.save(updated);
    return updated;
  }

  edit(id: string, changes: Partial<Pick<Candidate, 'title' | 'summary' | 'body'>>): Candidate {
    const candidate = this.require(id);
    const updated = parseCandidate({ ...candidate, ...changes });
    this.candidates.save(updated);
    return updated;
  }

  private require(id: string): Candidate {
    const candidate = this.candidates.get(id);
    if (candidate === null) throw new Error('candidate not found');
    return candidate;
  }
}

export function evaluateGate(input: DistillationInput): DistillationGate {
  const reasons: string[] = [];
  if (input.evidence.length === 0 || input.observation.evidenceIds.length === 0) reasons.push('source-required');
  const signal = segmentSignal(input.evidence);
  if (signal.kind !== 'outcome' && signal.kind !== 'fact') reasons.push('no-outcome-signal');
  if (input.evidence.some((event) => event.sensitivity === 'blocked')) reasons.push('blocked-evidence');
  if (input.verified === false) reasons.push('verification-required');
  return { accepted: reasons.length === 0, reasons };
}

function groupEvidence(evidence: readonly EvidenceEvent[]): EvidenceEvent[][] {
  const groups = new Map<string, EvidenceEvent[]>();
  for (const event of evidence) {
    const key = event.sessionId ?? `${event.projectId ?? 'global'}:${event.agentId ?? 'unknown'}`;
    const current = groups.get(key) ?? [];
    current.push(event);
    groups.set(key, current);
  }
  return [...groups.values()].map((group) => group.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt)));
}

function buildObservation(evidence: readonly EvidenceEvent[], clock: () => Date): { readonly observation: Observation; readonly verified: boolean } {
  const text = evidence.map((event) => event.payload.text ?? event.payload.summary).join('\n');
  const signal = segmentSignal(evidence);
  const verified = signal.kind === 'outcome' || signal.kind === 'fact';
  const kind: Observation['kind'] = /\b(?:preference|prefer|always use|style)\b/iu.test(text)
    ? 'preference'
    : /\b(?:environment|version|runtime|toolchain)\b/iu.test(text)
      ? 'environment'
      : /\b(?:step|run|use|command|procedure|workflow|fix|retry)\b/iu.test(text)
        ? 'procedure'
        : 'problem';
  const first = evidence[0];
  return {
    verified,
    observation: {
      id: `observation-${stableSegmentId(evidence)}`,
      evidenceIds: evidence.map((event) => event.id),
      ...(first?.projectId === undefined ? {} : { projectId: first.projectId }),
      ...(first?.sessionId === undefined ? {} : { sessionId: first.sessionId }),
      kind,
      summary: extractProseSummary(text),
      novelty: signal.kind === 'outcome' ? 0.8 : signal.kind === 'fact' ? 0.6 : 0.3,
      reuse: signal.kind === 'outcome' ? 0.8 : signal.kind === 'fact' ? 0.7 : 0.4,
      evidenceQuality: !verified ? 0.5 : evidence.some((event) => event.sensitivity === 'redacted') ? 0.7 : 0.9,
      sensitivityRisk: evidence.some((event) => event.sensitivity === 'blocked') ? 1 : 0,
      createdAt: clock().toISOString(),
    },
  };
}

/** Segment signal with test/commit refs treated as outcome proof. */
function segmentSignal(evidence: readonly EvidenceEvent[]): EvidenceSignal {
  const signal = classifySegment(evidence);
  const hasRefProof = evidence.some((event) => event.refs.some((ref) => ref.kind === 'test' || ref.kind === 'commit'));
  return hasRefProof && signal.kind !== 'outcome' ? { kind: 'outcome', flags: [...signal.flags, 'test-ref'] } : signal;
}

function stableSegmentId(evidence: readonly EvidenceEvent[]): string {
  return evidence.map((event) => event.id).sort().join('-').replace(/[^a-zA-Z0-9-]/gu, '').slice(0, 120);
}

class NoopAuditLog implements AuditLog {
  append(input: Parameters<AuditLog['append']>[0]): Promise<Awaited<ReturnType<AuditLog['append']>>> {
    return Promise.resolve({ ...input, eventHash: 'noop' });
  }

  list(): Promise<Awaited<ReturnType<AuditLog['list']>>> {
    return Promise.resolve([]);
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function llmSystemPrompt(): string {
  return [
    'You are Taga memory distillation.',
    'Use only the supplied redacted Evidence; do not invent facts or source references.',
    'Return one JSON object and no markdown.',
    'Cite supplied evidence ids in the body for factual claims.',
    'Keep the candidate pending; never request or emit secrets, commands to execute, or external actions.',
  ].join(' ');
}

const MAX_LLM_PAYLOAD_CHARS = 4000;

function boundedPayload(payload: EvidenceEvent['payload']): EvidenceEvent['payload'] {
  const clip = (value: string): string => value.length <= MAX_LLM_PAYLOAD_CHARS
    ? value
    : `${value.slice(0, MAX_LLM_PAYLOAD_CHARS)}<elided chars=${value.length - MAX_LLM_PAYLOAD_CHARS} reason="oversize">`;
  return {
    ...payload,
    summary: clip(payload.summary),
    ...(payload.text === undefined ? {} : { text: clip(payload.text) }),
  };
}

function buildLlmUserPrompt(input: DistillationInput): string {
  return JSON.stringify({
    observation: input.observation,
    evidence: input.evidence.map((event) => ({
      id: event.id,
      source: event.source,
      projectId: event.projectId,
      sessionId: event.sessionId,
      occurredAt: event.occurredAt,
      refs: event.refs,
      payload: boundedPayload(event.payload),
      sensitivity: event.sensitivity,
    })),
    outputSchema: {
      memoryType: 'preferences|environment|procedures|lessons|projects',
      title: 'string',
      summary: 'string',
      body: 'string (cite supplied evidence ids inline for factual claims)',
      confidence: 'number 0..1',
    },
  });
}

function parseLlmDraft(text: string): LlmDraft {
  return llmDraftSchema.parse(parseJsonObjectPayload(text));
}

function parseJsonObjectPayload(text: string): unknown {
  const withoutThinking = text
    .replace(/<think>[\s\S]*?<\/think>/giu, '')
    .trim()
    .replace(/^```(?:json)?\s*/iu, '')
    .replace(/\s*```$/u, '')
    .trim();
  try {
    return JSON.parse(withoutThinking) as unknown;
  } catch {
    const start = withoutThinking.indexOf('{');
    const end = withoutThinking.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(withoutThinking.slice(start, end + 1)) as unknown;
    }
    throw new Error('LLM response did not contain a JSON object');
  }
}

function validateDraftSources(draft: LlmDraft, evidence: readonly EvidenceEvent[]): void {
  const allowed = new Set(evidence.map((event) => event.id));
  const references = [
    ...draft.facts.flatMap((fact) => fact.evidenceIds),
    ...draft.entities.flatMap((entity) => entity.evidenceIds),
    ...draft.temporalFacts.flatMap((fact) => fact.evidenceIds),
    ...draft.causalLinks.flatMap((link) => link.evidenceIds),
  ];
  if (references.some((id) => !allowed.has(id))) {
    throw new Error('LLM output contains an unsupported evidence reference');
  }
}

function uniqueEvidenceRefs(evidence: readonly EvidenceEvent[]) {
  return evidence
    .flatMap((event) => event.refs)
    .filter((ref, index, refs) => refs.findIndex((item) => item.kind === ref.kind && item.locator === ref.locator) === index);
}

function readOpenAiText(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    throw new Error('LLM provider returned an invalid response');
  }
  const first: unknown = payload.choices[0];
  if (!isRecord(first) || !isRecord(first.message) || typeof first.message.content !== 'string') {
    throw new Error('LLM provider response has no message content');
  }
  return first.message.content;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('LLM provider timeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface ConsolidationProposal {
  readonly id: string;
  readonly kind: 'merge' | 'conflict';
  readonly candidateIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly reason: string;
  readonly createdAt: string;
}

export interface CandidateRankInput {
  readonly candidate: Candidate;
  readonly relevance: number;
  readonly freshness: number;
  readonly scope: number;
  readonly sourceTrust: number;
}

export function proposeConsolidation(candidates: readonly Candidate[], now = new Date().toISOString()): ConsolidationProposal[] {
  const proposals: ConsolidationProposal[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const left = candidates[index];
    if (left === undefined || left.decision !== 'pending') continue;
    for (let nextIndex = index + 1; nextIndex < candidates.length; nextIndex += 1) {
      const right = candidates[nextIndex];
      if (right === undefined || right.decision !== 'pending' || left.memoryType !== right.memoryType) continue;
      const sameScope = JSON.stringify(left.scopeSuggestion) === JSON.stringify(right.scopeSuggestion);
      const similarity = lexicalSimilarity(`${left.title} ${left.summary}`, `${right.title} ${right.summary}`);
      const sharedEvidence = left.evidenceIds.filter((id) => right.evidenceIds.includes(id));
      if (!sameScope || (similarity < 0.6 && sharedEvidence.length === 0)) continue;
      const leftFacts = left.facts ?? [];
      const rightFacts = right.facts ?? [];
      const conflicting = leftFacts.length > 0 && rightFacts.length > 0
        && leftFacts.some((fact) => rightFacts.some((other) => fact.text !== other.text && fact.text.toLowerCase().includes(other.text.toLowerCase().slice(0, 18))));
      proposals.push({
        id: `consolidation-${randomUUID()}`,
        kind: conflicting ? 'conflict' : 'merge',
        candidateIds: [left.id, right.id],
        evidenceIds: [...new Set([...left.evidenceIds, ...right.evidenceIds])],
        reason: conflicting ? 'similar candidates contain conflicting facts' : 'similar candidates share scope and reusable content',
        createdAt: now,
      });
    }
  }
  return proposals;
}

export function rankCandidates(items: readonly CandidateRankInput[]): CandidateRankInput[] {
  return [...items].sort((left, right) => rankScore(right) - rankScore(left) || left.candidate.id.localeCompare(right.candidate.id));
}

function rankScore(item: CandidateRankInput): number {
  return item.relevance * 0.5 + item.freshness * 0.15 + item.scope * 0.15 + item.sourceTrust * 0.1 + item.candidate.confidence * 0.1;
}

function lexicalSimilarity(left: string, right: string): number {
  const leftTokens = new Set(left.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []);
  const rightTokens = new Set(right.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return intersection / new Set([...leftTokens, ...rightTokens]).size;
}


export interface DistillerChainOptions {
  readonly audit?: AuditLog;
  readonly llm?: LlmConfig;
  readonly provider?: StructuredCompletionProvider;
  readonly budgetState?: LlmBudgetState;
  /** Budget accounting bucket: distill | learn | reflect | consolidation. */
  readonly consumer?: string;
}

export function buildDistillerChain(options: DistillerChainOptions = {}): Distiller {
  const llm = options.llm ?? llmConfigFromEnv();
  const deterministic = new FakeDistiller('deterministic-auto', 'm3');
  if (llm.mode === 'off') return deterministic;
  const baseProvider = options.provider ?? createLlmProvider(llm);
  if (baseProvider === undefined) return deterministic;
  const provider = withLlmBudget(baseProvider, {
    ...(llm.dailyCap === undefined ? {} : { dailyCalls: llm.dailyCap }),
    ...(llm.dailyTokens === undefined ? {} : { dailyTokens: llm.dailyTokens }),
    ...(llm.perConsumerShare === undefined ? {} : { perConsumerShare: llm.perConsumerShare }),
  }, options.consumer ?? 'distill', options.budgetState);
  const llmDistiller = new LlmDistiller({
    provider,
    providerName: llm.providerName,
    model: llm.model,
    timeoutMs: llm.timeoutMs,
  });
  if (llm.mode === 'shadow') {
    return new ShadowDistiller(deterministic, llmDistiller, (comparison) => {
      void options.audit?.append({
        eventType: 'distill.llm_shadow',
        actor: 'daemon',
        subjectType: 'distillation',
        subjectId: `shadow-${randomUUID()}`,
        occurredAt: new Date().toISOString(),
        reason: comparison.error === undefined ? 'llm shadow comparison recorded' : 'llm shadow provider failed',
        payload: {
          deterministicTitle: comparison.deterministic.title,
          deterministicMode: comparison.deterministic.model?.mode,
          ...(comparison.shadow === null
            ? {}
            : {
                shadowTitle: comparison.shadow.title,
                shadowMode: comparison.shadow.model?.mode,
                ...(comparison.shadow.model?.inputTokens === undefined ? {} : { shadowInputTokens: comparison.shadow.model?.inputTokens }),
                ...(comparison.shadow.model?.outputTokens === undefined ? {} : { shadowOutputTokens: comparison.shadow.model?.outputTokens }),
                ...(comparison.shadow.model?.latencyMs === undefined ? {} : { shadowLatencyMs: comparison.shadow.model?.latencyMs }),
              }),
          ...(comparison.error === undefined ? {} : { error: comparison.error }),
        },
      }).catch(() => undefined);
    });
  }
  if (llm.mode === 'on') {
    return new FallbackDistiller(llmDistiller, deterministic, (event) => {
      void options.audit?.append({
        eventType: 'distill.llm_fallback',
        actor: 'daemon',
        subjectType: 'distillation',
        subjectId: `fallback-${randomUUID()}`,
        occurredAt: new Date().toISOString(),
        reason: event.reason,
        payload: { provider: event.provider, model: event.model, evidenceCount: event.evidenceIds.length, ...(event.errorKind === undefined ? {} : { errorKind: event.errorKind }) },
      }).catch(() => undefined);
    });
  }
  return deterministic;
}
