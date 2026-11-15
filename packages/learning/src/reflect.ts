import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { normalizeEvidence } from '../../redaction/src/index.js';
import { parseObservation, type Memory } from '../../domain/src/index.js';
import { type AuditLog, type LlmConfig } from '../../application/src/index.js';
import {
  buildDistillerChain,
  DatabaseCandidateRepository,
  type StructuredCompletionProvider,
} from '../../distillation/src/index.js';
import { DatabaseStore, MarkdownMemoryRepository } from '../../storage/src/index.js';

export interface ReflectConfig {
  readonly mode: 'off' | 'on';
  readonly intervalMs: number;
  readonly windowDays: number;
  readonly minGroupSize: number;
  readonly maxGroups: number;
}

export function reflectConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ReflectConfig {
  const mode = env.TAGA_REFLECT_MODE === 'on' ? 'on' : 'off';
  return {
    mode,
    intervalMs: positiveInt(env.TAGA_REFLECT_INTERVAL_MS, 7 * 24 * 60 * 60 * 1000),
    windowDays: positiveInt(env.TAGA_REFLECT_WINDOW_DAYS, 7),
    minGroupSize: positiveInt(env.TAGA_REFLECT_MIN_GROUP, 3),
    maxGroups: positiveInt(env.TAGA_REFLECT_MAX_GROUPS, 5),
  };
}

export interface ReflectInput {
  readonly project?: string;
}

export interface ReflectGroupReport {
  readonly groupKey: string;
  readonly memberCount: number;
  readonly insightCandidateId: string | null;
}

export interface ReflectReport {
  readonly mode: ReflectConfig['mode'];
  readonly groupsConsidered: number;
  readonly groupsReflected: number;
  readonly candidates: number;
  readonly groups: readonly ReflectGroupReport[];
  readonly errors: readonly string[];
}

export const REFLECT_JOB_KIND = 'reflect.run';

export function enqueueScheduledReflectScan(
  database: { enqueueJobIfAbsent(input: { id: string; kind: string; payload: string }): boolean },
  config: ReflectConfig,
  now: Date,
): boolean {
  if (config.mode !== 'on') return false;
  return database.enqueueJobIfAbsent({
    id: `reflect-run-scheduled-${Math.floor(now.getTime() / config.intervalMs)}`,
    kind: REFLECT_JOB_KIND,
    payload: '{}',
  });
}

export interface ReflectRunOptions {
  readonly brainPath: string;
  readonly audit?: AuditLog;
  readonly llm?: LlmConfig;
  readonly provider?: StructuredCompletionProvider;
  readonly config?: ReflectConfig;
  readonly clock?: () => Date;
}

export async function runReflect(input: ReflectInput, options: ReflectRunOptions): Promise<ReflectReport> {
  const config = options.config ?? reflectConfigFromEnv();
  const clock = options.clock ?? (() => new Date());
  const now = clock();
  const windowStart = now.getTime() - config.windowDays * 24 * 60 * 60 * 1000;
  const errors: string[] = [];

  if (config.mode !== 'on') {
    return { mode: 'off', groupsConsidered: 0, groupsReflected: 0, candidates: 0, groups: [], errors: ['reflect is disabled (TAGA_REFLECT_MODE is not on)'] };
  }
  if (options.provider === undefined && options.llm?.mode !== 'on') {
    return { mode: 'off', groupsConsidered: 0, groupsReflected: 0, candidates: 0, groups: [], errors: ['reflect requires the LLM adapter (TAGA_LLM_MODE on) or an explicit provider'] };
  }

  const repository = new MarkdownMemoryRepository(options.brainPath);
  const memories = (await repository.list()).filter((memory) => {
    if (memory.status !== 'active' || memory.visibility === 'excluded') return false;
    const stamp = Date.parse(memory.updated);
    return Number.isFinite(stamp) && stamp >= windowStart;
  });

  const groups = groupMemories(memories, config.minGroupSize, input.project);
  const chain = buildDistillerChain({
    ...(options.audit === undefined ? {} : { audit: options.audit }),
    ...(options.llm === undefined ? {} : { llm: options.llm }),
    ...(options.provider === undefined ? {} : { provider: options.provider }),
  });
  const database = new DatabaseStore(join(options.brainPath, 'taga.db'));
  const candidatesRepo = new DatabaseCandidateRepository(database);
  const groupReports: ReflectGroupReport[] = [];
  let candidatesCreated = 0;
  let reflected = 0;

  for (const group of groups.slice(0, config.maxGroups)) {
    try {
      const insightCandidate = await reflectGroup(group, chain, candidatesRepo, options, clock);
      groupReports.push({ groupKey: group.key, memberCount: group.members.length, insightCandidateId: insightCandidate?.id ?? null });
      if (insightCandidate !== null) {
        candidatesCreated += 1;
        reflected += 1;
      }
    } catch (error) {
      errors.push(`reflect group ${group.key} failed: ${error instanceof Error ? error.message : String(error)}`);
      groupReports.push({ groupKey: group.key, memberCount: group.members.length, insightCandidateId: null });
    }
  }
  database.close();

  const report: ReflectReport = {
    mode: 'on',
    groupsConsidered: groups.length,
    groupsReflected: reflected,
    candidates: candidatesCreated,
    groups: groupReports,
    errors,
  };
  try {
    await options.audit?.append({
      eventType: 'reflect.completed',
      actor: 'daemon',
      subjectType: 'reflect',
      subjectId: `reflect-${now.toISOString()}`,
      occurredAt: now.toISOString(),
      reason: 'reflect run completed',
      payload: {
        groupsConsidered: report.groupsConsidered,
        groupsReflected: report.groupsReflected,
        candidates: report.candidates,
        ...(errors.length === 0 ? {} : { errors }),
      },
    });
  } catch {
    // audit failures must never break a reflect run
  }
  return report;
}

interface MemoryGroup {
  readonly key: string;
  readonly members: readonly Memory[];
}

function groupMemories(memories: readonly Memory[], minGroupSize: number, project: string | undefined): readonly MemoryGroup[] {
  const eligible = memories.filter((memory) => project === undefined || memory.projectId === project);
  const groups = new Map<string, Memory[]>();
  for (const memory of eligible) {
    const key = `${memory.type}:${memory.scope.kind}:${memory.scope.kind === 'global' ? '*' : memory.scope.id}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(memory);
    groups.set(key, bucket);
  }
  return [...groups.entries()]
    .filter(([, bucket]) => bucket.length >= minGroupSize)
    .sort((left, right) => right[1].length - left[1].length)
    .map(([key, bucket]) => ({ key, members: bucket }));
}

async function reflectGroup(
  group: MemoryGroup,
  chain: ReturnType<typeof buildDistillerChain>,
  candidatesRepo: DatabaseCandidateRepository,
  options: ReflectRunOptions,
  clock: () => Date,
): Promise<{ id: string } | null> {
  const membersText = group.members
    .map((memory, index) => `[${index + 1}] (${memory.type}, confidence ${memory.confidence.toFixed(2)}, useful ${memory.usefulCount}) ${memory.title} — ${memory.summary}`)
    .join('\n');
  const raw = [
    `以下 ${group.members.length} 条既有记忆同属 ${group.key}，来自近期活跃记忆。请提炼一条更高层的洞察（insight）：这些记忆共同指向什么规律、约束或最佳实践？`,
    membersText,
    '洞察必须是可跨会话复用的事实，不要复述任何单条记忆，也不要编造成员中没有的细节。',
  ].join('\n\n');
  const hash = createHash('sha256').update(raw, 'utf8').digest('hex');
  const normalized = normalizeEvidence({
    id: `evidence-reflect-${hash}`,
    source: 'watcher',
    raw,
    occurredAt: clock().toISOString(),
    capturedAt: clock().toISOString(),
    refs: group.members.map((memory) => ({ kind: 'file' as const, locator: `mem:${memory.id}` })),
    parserVersion: 'reflect-v1',
  });
  if (normalized.event.sensitivity === 'blocked') return null;
  const observation = parseObservation({
    id: `observation-reflect-${hash}`,
    evidenceIds: [normalized.event.id],
    kind: 'exploration',
    summary: `Reflect insight over ${group.members.length} ${group.key} memories`,
    novelty: 0.7,
    reuse: 0.7,
    evidenceQuality: 0.85,
    sensitivityRisk: 0,
    createdAt: clock().toISOString(),
  });
  const candidate = await chain.distill({
    observation,
    evidence: [normalized.event],
    verified: true,
  });
  candidatesRepo.save(candidate);
  void options.audit?.append({
    eventType: 'reflect.group',
    actor: 'daemon',
    subjectType: 'reflect',
    subjectId: candidate.id,
    occurredAt: clock().toISOString(),
    reason: 'reflect insight candidate created',
    payload: { groupKey: group.key, memberIds: group.members.map((memory) => memory.id) },
  }).catch(() => undefined);
  return { id: candidate.id };
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.length === 0) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && Number.isInteger(parsed) ? parsed : fallback;
}

