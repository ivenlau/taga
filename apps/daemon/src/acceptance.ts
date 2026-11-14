import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  AgentAdapterRegistry,
  type AgentAdapter,
  type SourceAdapter,
  type SourceRecord,
} from '../../../packages/adapters/src/index.js';
import { SqliteAuditLog } from '../../../packages/application/src/index.js';
import { JsonCandidateRepository, ReviewService } from '../../../packages/distillation/src/index.js';
import { parseCandidate } from '../../../packages/domain/src/index.js';
import { normalizeEvidence } from '../../../packages/redaction/src/index.js';
import { FtsRetrievalProvider } from '../../../packages/retrieval/src/index.js';
import { DatabaseStore, MarkdownMemoryRepository } from '../../../packages/storage/src/index.js';

export interface AgentAcceptanceInput {
  readonly agentId: string;
  readonly brainPath: string;
  readonly projectId: string;
  readonly confirmed: boolean;
}

export interface AgentAcceptanceReport {
  readonly agentId: string;
  readonly parserVersion: string;
  readonly sourcePath: string;
  readonly evidenceId: string;
  readonly candidateId: string;
  readonly memoryId: string;
  readonly recalled: boolean;
}

export class AgentAcceptanceService {
  constructor(
    private readonly registry: AgentAdapterRegistry = new AgentAdapterRegistry(),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async verify(input: AgentAcceptanceInput): Promise<AgentAcceptanceReport> {
    if (!input.confirmed) throw new Error('real-agent verification requires explicit confirmation');
    const adapter = this.registry.get(input.agentId);
    if (adapter === null) throw new Error(`unsupported agent: ${input.agentId}`);
    const detection = await adapter.detect({ includeVersion: false, includeSourceScan: false });
    if (!detection.available) throw new Error(`agent is unavailable: ${detection.reason ?? 'not detected'}`);
    const record = await this.firstRecord(adapter);
    if (record === null) throw new Error('no supported complete session record was found');

    const database = new DatabaseStore(join(input.brainPath, 'taga.db'));
    try {
      const normalized = normalizeEvidence({
        id: `evidence-live-${createHash('sha256').update(`${adapter.id}:${record.source.id}:${record.record.id}`).digest('hex')}`,
        source: record.record.source,
        raw: record.record.raw,
        path: record.record.path,
        agentId: adapter.id,
        projectId: input.projectId,
        occurredAt: record.record.occurredAt,
        capturedAt: this.clock().toISOString(),
        parserVersion: record.source.parserVersion,
        refs: [{ kind: 'file', locator: record.record.path }],
      });
      database.saveEvidence(normalized.event);
      if (normalized.event.sensitivity === 'blocked') throw new Error('selected session record was blocked by redaction policy');

      const candidateId = `candidate-live-${createHash('sha256').update(normalized.event.id).digest('hex')}`;
      const title = `Verified ${adapter.id} real-agent integration`;
      const candidate = parseCandidate({
        id: candidateId,
        observationId: `observation-live-${createHash('sha256').update(candidateId).digest('hex')}`,
        agentId: adapter.id,
        projectId: input.projectId,
        memoryType: 'lessons',
        title,
        summary: `${title} through a governed Evidence, review, and recall path.`,
        body: normalized.event.payload.summary,
        scopeSuggestion: { kind: 'project', id: input.projectId },
        worthLearning: true,
        evidenceIds: [normalized.event.id],
        confidence: 0.9,
        createdAt: this.clock().toISOString(),
        decision: 'pending',
        model: {
          provider: 'deterministic-live-acceptance',
          model: 'none',
          promptVersion: 'm2-live-v1',
          schemaVersion: 'candidate-v1',
          inputEvidenceIds: [normalized.event.id],
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: 0,
        },
      });
      const candidates = new JsonCandidateRepository(join(input.brainPath, 'candidates.json'));
      candidates.save(candidate);
      const repository = new MarkdownMemoryRepository(input.brainPath);
      const review = new ReviewService(candidates, repository, new SqliteAuditLog(database), this.clock);
      const memory = await review.accept(candidate.id, { actor: 'user', actorId: 'live-acceptance' }, `verify ${adapter.id} real-agent integration`);
      const stored = await repository.records();
      const recordForMemory = stored.find((item) => item.memory.id === memory.id);
      if (recordForMemory === undefined) throw new Error('accepted memory was not persisted');
      const retrieval = new FtsRetrievalProvider(database);
      retrieval.upsert(recordForMemory.memory, recordForMemory.body);
      const recalled = retrieval.search({ query: adapter.id, scope: { kind: 'project', id: input.projectId } })
        .some((item) => item.memory.id === memory.id);
      if (!recalled) throw new Error('accepted memory was not recalled');
      const report: AgentAcceptanceReport = {
        agentId: adapter.id,
        parserVersion: record.source.parserVersion,
        sourcePath: record.record.path,
        evidenceId: normalized.event.id,
        candidateId: candidate.id,
        memoryId: memory.id,
        recalled,
      };
      database.upsertMetadata(`release:agent:${adapter.id}`, JSON.stringify({ ...report, verifiedAt: this.clock().toISOString() }));
      return report;
    } finally {
      database.close();
    }
  }

  private async firstRecord(adapter: AgentAdapter): Promise<{ source: SourceAdapter; record: SourceRecord } | null> {
    for (const source of await adapter.sessionSources()) {
      if (!(await source.detect()).available) continue;
      const record = await firstSourceRecord(source);
      if (record !== null) return { source, record };
    }
    return null;
  }
}

async function firstSourceRecord(source: SourceAdapter): Promise<SourceRecord | null> {
  for await (const record of source.readSince({ offset: 0, sourceVersion: source.parserVersion })) return record;
  return null;
}
