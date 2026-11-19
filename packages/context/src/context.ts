import { writeManagedBlock } from '../../storage/src/index.js';
import type {
  ContextBuildInput,
  ContextDecision,
  ContextPack,
  ContextSection,
  Memory,
  Policy,
} from '../../domain/src/index.js';

export interface ContextCandidate {
  readonly memory: Memory;
  readonly body: string;
  readonly score?: number;
}

export interface DomainContextContribution {
  readonly title: string;
  readonly content: string;
  readonly candidateIds: readonly string[];
}

export interface ContextTrace {
  readonly packId: string;
  readonly decisions: readonly ContextDecision[];
  readonly nextQueryHint: string;
}

export interface ContextBuildRequest extends ContextBuildInput {
  readonly candidates: readonly ContextCandidate[];
  readonly domainContributions?: readonly DomainContextContribution[];
}

export interface PackStats {
  readonly included: number;
  readonly truncated: number;
  readonly excluded: number;
  readonly tokenEstimate: number;
  readonly buckets: Readonly<Record<string, { readonly included: number; readonly truncated: number }>>;
}

const defaultPolicy: Policy = {
  defaultScope: { kind: 'global' },
  allowDraftRecall: false,
  staticTokenBudget: 1300,
  dailyNotificationLimit: 0,
  remoteModelAllowed: false,
  proactive: {
    enabled: true,
    policyVersion: 'm3-v1',
    autoCollect: true,
    autoDistill: true,
    allowL1Notifications: true,
    allowL2Reminders: false,
    autoActivateLessons: false,
    dailyNotificationLimit: 20,
  },
};

const FAMILY_INCLUDE_LIMIT = 2;
const BUCKET_SHARE_LIMIT = 0.6;
const FRESHNESS_WINDOW_DAYS = 90;
const cjkPattern = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff01-\uff60\uac00-\ud7af]/gu;

export class ContextPackBuilder {
  build(input: ContextBuildRequest, now: Date = new Date()): ContextPack {
    const policy = input.policy ?? defaultPolicy;
    const tokenBudget = input.tokenBudget ?? policy.staticTokenBudget;
    const nowMs = now.getTime();
    const sorted = [...input.candidates].sort((left, right) => compareCandidates(left, right, nowMs));
    const decisions: ContextDecision[] = [];
    const sectionsByKind = new Map<ContextSection['kind'], ContextSection>();
    const titleCounts = new Map<string, number>();
    for (const candidate of sorted) {
      const key = familyKey(candidate.memory);
      titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
    }
    const domainSections = domainSectionsFor(input, decisions);
    const familyIncluded = new Map<string, number>();
    const bucketUsed = new Map<string, number>();
    const bucketBlocked = new Set<string>();
    const bucketCap = Math.floor(tokenBudget * BUCKET_SHARE_LIMIT);
    let remaining = tokenBudget - domainSections.reduce((sum, section) => sum + section.tokenEstimate, 0);
    const deferred: ContextCandidate[] = [];

    const admit = (candidate: ContextCandidate, enforceCap: boolean): boolean => {
      const memory = candidate.memory;
      if (memory.status !== 'active' || memory.visibility === 'excluded') {
        decisions.push({
          memoryId: memory.id,
          decision: 'excluded',
          reason: ['status-or-visibility-policy'],
        });
        return false;
      }
      if (memory.scope.kind === 'project' && (input.projectId === undefined || memory.scope.id !== input.projectId)) {
        decisions.push({
          memoryId: memory.id,
          decision: 'excluded',
          reason: [input.projectId === undefined ? 'project-context-missing' : 'project-scope-mismatch'],
        });
        return false;
      }
      const family = familyKey(memory);
      if ((familyIncluded.get(family) ?? 0) >= FAMILY_INCLUDE_LIMIT) {
        decisions.push({
          memoryId: memory.id,
          decision: 'excluded',
          reason: ['family-cap-exceeded'],
          budgetBucket: memory.type,
        });
        return false;
      }
      const bucket = memory.type;
      if (enforceCap && bucketBlocked.has(bucket)) {
        return true;
      }
      const content = `${memory.title}\n${memory.summary}\n${candidate.body}`;
      const fullTokens = estimateTokens(content);
      const summaryContent = `${memory.title}\n${memory.summary}`;
      const summaryTokens = estimateTokens(summaryContent);
      const capRoom = enforceCap ? bucketCap - (bucketUsed.get(bucket) ?? 0) : Number.POSITIVE_INFINITY;
      const include = (packed: string, used: number, fullBody: boolean): void => {
        const sectionKind = sectionKindForMemory(memory.type);
        const existing = sectionsByKind.get(sectionKind);
        sectionsByKind.set(sectionKind, {
          kind: sectionKind,
          title: existing?.title ?? sectionTitle(sectionKind),
          content: existing === undefined ? packed : `${existing.content}\n\n${packed}`,
          tokenEstimate: (existing?.tokenEstimate ?? 0) + used,
          memoryIds: [...(existing?.memoryIds ?? []), memory.id],
        });
        remaining -= used;
        bucketUsed.set(bucket, (bucketUsed.get(bucket) ?? 0) + used);
        familyIncluded.set(family, (familyIncluded.get(family) ?? 0) + 1);
        decisions.push({
          memoryId: memory.id,
          decision: 'included',
          reason: [
            `scope:${memory.scope.kind}`,
            'active',
            'deterministic-priority',
            ...(titleCounts.get(family) === 1 ? [] : ['conflict-visible']),
            ...(fullBody ? [] : ['body-omitted-token-budget']),
          ],
          score: memory.confidence,
          budgetBucket: bucket,
        });
      };
      if (fullTokens <= remaining && fullTokens <= capRoom) {
        include(content, fullTokens, true);
        return false;
      }
      if (summaryTokens <= remaining) {
        if (enforceCap) {
          // The bucket cap is binding: hold the item back for the uncapped
          // second pass instead of letting smaller items jump ahead of it.
          bucketBlocked.add(bucket);
          return true;
        }
        include(summaryContent, summaryTokens, false);
        return false;
      }
      decisions.push({
        memoryId: memory.id,
        decision: 'truncated',
        reason: ['token-budget-exhausted', 'use-memory-search-for-full-content'],
        budgetBucket: bucket,
      });
      return false;
    };

    for (const candidate of sorted) {
      if (admit(candidate, true)) {
        deferred.push(candidate);
      }
    }
    for (const candidate of deferred) {
      admit(candidate, false);
    }

    const sections = [...sectionsByKind.values(), ...domainSections];
    const nextQueryHint = 'Use memory_search for more knowledge and memory_precheck before editing a file or symbol.';
    const content = renderContent(input, sections, nextQueryHint);
    return {
      id: `pack-${input.agentId}-${input.projectId ?? 'global'}`,
      schemaVersion: 1,
      agentId: input.agentId,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      generatedAt: now.toISOString(),
      content,
      sections,
      tokenEstimate: estimateTokens(content),
      truncated: decisions.some((decision) => decision.decision === 'truncated'),
      decisions,
      degraded: false,
    };
  }

  explain(pack: ContextPack): readonly ContextDecision[] {
    return pack.decisions;
  }

  trace(pack: ContextPack): ContextTrace {
    return {
      packId: pack.id,
      decisions: pack.decisions,
      nextQueryHint: 'Use memory_search for more knowledge and memory_precheck before editing a file or symbol.',
    };
  }

  async inject(path: string, pack: ContextPack, expectedHash?: string): Promise<string> {
    return writeManagedBlock(path, pack.content, expectedHash);
  }
}

export function summarizePack(pack: ContextPack): PackStats {
  const buckets: Record<string, { included: number; truncated: number }> = {};
  let included = 0;
  let truncated = 0;
  let excluded = 0;
  for (const decision of pack.decisions) {
    if (decision.decision === 'included') included += 1;
    else if (decision.decision === 'truncated') truncated += 1;
    else excluded += 1;
    const bucket = decision.budgetBucket;
    if (bucket !== undefined && decision.decision !== 'excluded') {
      const entry = buckets[bucket] ??= { included: 0, truncated: 0 };
      if (decision.decision === 'included') entry.included += 1;
      else entry.truncated += 1;
    }
  }
  return { included, truncated, excluded, tokenEstimate: pack.tokenEstimate, buckets };
}

function domainSectionsFor(input: ContextBuildRequest, decisions: ContextDecision[]): ContextSection[] {
  const contributions = input.domainContributions ?? [];
  if (input.channel === 'static') {
    // Unconfirmed candidates must never reach a statically injected Context Pack.
    for (const contribution of contributions) {
      decisions.push({ decision: 'excluded', reason: ['static-channel-policy'], source: `domain-pack:${contribution.title}` });
    }
    return [];
  }
  return contributions.map((contribution) => {
    decisions.push({ decision: 'included', reason: ['domain-pack-advisory', 'pending-candidates'], source: `domain-pack:${contribution.title}` });
    return {
      kind: 'domain' as const,
      title: contribution.title,
      content: contribution.content,
      tokenEstimate: estimateTokens(contribution.content),
      memoryIds: [],
    };
  });
}

function compareCandidates(left: ContextCandidate, right: ContextCandidate, nowMs: number): number {
  const scopeDifference = scopeRank(right.memory) - scopeRank(left.memory);
  if (scopeDifference !== 0) {
    return scopeDifference;
  }
  return rankingScore(right, nowMs) - rankingScore(left, nowMs) || left.memory.id.localeCompare(right.memory.id);
}

function rankingScore(candidate: ContextCandidate, nowMs: number): number {
  return (candidate.score ?? 0) * 0.5 + freshness(candidate.memory.updated, nowMs) * 0.25 + candidate.memory.confidence * 0.25;
}

function freshness(updated: string, nowMs: number): number {
  const ageDays = (nowMs - Date.parse(updated)) / 86_400_000;
  if (!Number.isFinite(ageDays)) return 0;
  return Math.max(0, 1 - ageDays / FRESHNESS_WINDOW_DAYS);
}

function scopeRank(candidate: ContextCandidate['memory']): number {
  switch (candidate.scope.kind) {
    case 'project':
      return 3;
    case 'domain':
      return 2;
    case 'global':
      return 1;
  }
}

function familyKey(memory: Memory): string {
  return `${memory.type}:${memory.title}`;
}

function sectionKindForMemory(type: Memory['type']): ContextSection['kind'] {
  switch (type) {
    case 'preferences':
      return 'habits';
    case 'environment':
      return 'environment';
    case 'projects':
      return 'project';
    case 'procedures':
    case 'lessons':
      return 'lessons';
  }
}

function sectionTitle(kind: ContextSection['kind']): string {
  return kind.slice(0, 1).toUpperCase() + kind.slice(1);
}

function estimateTokens(content: string): number {
  const cjk = content.match(cjkPattern)?.length ?? 0;
  return Math.ceil(cjk + (content.length - cjk) / 4);
}

function renderContent(
  input: ContextBuildRequest,
  sections: readonly ContextSection[],
  nextQueryHint: string,
): string {
  const header = [
    '## taga Context',
    `Agent: ${input.agentId}`,
    ...(input.projectId === undefined ? [] : [`Project: ${input.projectId}`]),
    ...(input.task === undefined ? [] : [`Task: ${input.task}`]),
    ...(input.cwd === undefined ? [] : [`Cwd: ${input.cwd}`]),
  ].join('\n');
  return [header, ...sections.map((section) => `### ${section.title}\n${section.content}`), nextQueryHint].join('\n\n');
}
