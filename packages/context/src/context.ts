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
}

export interface ContextTrace {
  readonly packId: string;
  readonly decisions: readonly ContextDecision[];
  readonly nextQueryHint: string;
}

export interface ContextBuildRequest extends ContextBuildInput {
  readonly candidates: readonly ContextCandidate[];
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

export class ContextPackBuilder {
  build(input: ContextBuildRequest): ContextPack {
    const policy = input.policy ?? defaultPolicy;
    const tokenBudget = input.tokenBudget ?? policy.staticTokenBudget;
    const sorted = [...input.candidates].sort(compareCandidates);
    const decisions: ContextDecision[] = [];
    const sectionsByKind = new Map<ContextSection['kind'], ContextSection>();
    const titleCounts = new Map<string, number>();
    for (const candidate of sorted) {
      const key = `${candidate.memory.type}:${candidate.memory.title}`;
      titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
    }
    let remaining = tokenBudget;

    for (const candidate of sorted) {
      const memory = candidate.memory;
      if (memory.status !== 'active' || memory.visibility === 'excluded') {
        decisions.push({
          memoryId: memory.id,
          decision: 'excluded',
          reason: ['status-or-visibility-policy'],
        });
        continue;
      }
      if (input.projectId !== undefined && memory.scope.kind === 'project' && memory.scope.id !== input.projectId) {
        decisions.push({
          memoryId: memory.id,
          decision: 'excluded',
          reason: ['project-scope-mismatch'],
        });
        continue;
      }
      const content = `${memory.title}\n${memory.summary}\n${candidate.body}`;
      const tokenEstimate = estimateTokens(content);
      if (tokenEstimate > remaining) {
        decisions.push({
          memoryId: memory.id,
          decision: 'truncated',
          reason: ['token-budget-exhausted', 'use-memory-search-for-full-content'],
          budgetBucket: memory.type,
        });
        continue;
      }
      const sectionKind = sectionKindForMemory(memory.type);
      const existing = sectionsByKind.get(sectionKind);
      sectionsByKind.set(sectionKind, {
        kind: sectionKind,
        title: existing?.title ?? sectionTitle(sectionKind),
        content: existing === undefined ? content : `${existing.content}\n\n${content}`,
        tokenEstimate: (existing?.tokenEstimate ?? 0) + tokenEstimate,
        memoryIds: [...(existing?.memoryIds ?? []), memory.id],
      });
      remaining -= tokenEstimate;
      decisions.push({
        memoryId: memory.id,
        decision: 'included',
        reason: [
          `scope:${memory.scope.kind}`,
          'active',
          'deterministic-priority',
          ...(titleCounts.get(`${memory.type}:${memory.title}`) === 1 ? [] : ['conflict-visible']),
        ],
        score: memory.confidence,
        budgetBucket: memory.type,
      });
    }

    const sections = [...sectionsByKind.values()];
    const nextQueryHint = 'Use memory_search for more knowledge and memory_precheck before editing a file or symbol.';
    const content = renderContent(input, sections, nextQueryHint);
    return {
      id: `pack-${input.agentId}-${input.projectId ?? 'global'}`,
      schemaVersion: 1,
      agentId: input.agentId,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      generatedAt: new Date().toISOString(),
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

function compareCandidates(left: ContextCandidate, right: ContextCandidate): number {
  const scopeDifference = scopeRank(right.memory) - scopeRank(left.memory);
  if (scopeDifference !== 0) {
    return scopeDifference;
  }
  return right.memory.confidence - left.memory.confidence || left.memory.id.localeCompare(right.memory.id);
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
  return Math.ceil(content.length / 4);
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
  ].join('\n');
  return [header, ...sections.map((section) => `### ${section.title}\n${section.content}`), nextQueryHint].join('\n\n');
}
