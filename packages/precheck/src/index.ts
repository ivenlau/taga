import { access, readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import {
  GovernanceService,
  scopeWeight,
  type AuditLog,
  type MemoryRepository,
} from '../../application/src/index.js';
import type { Memory, Scope, SourceRef } from '../../domain/src/index.js';
import type { NotificationService } from '../../notifications/src/index.js';
import type { DatabaseStore } from '../../storage/src/index.js';

export interface PrecheckTarget {
  readonly file?: string;
  readonly line?: number;
  readonly symbol?: string;
  readonly commit?: string;
}

export interface MemoryPrecheckInput {
  readonly target: PrecheckTarget;
  readonly task?: string;
  readonly projectId?: string;
  readonly agentId?: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

export type AnchorState = 'valid' | 'stale' | 'none';

export interface PrecheckItem {
  readonly memoryId: string;
  readonly type: Memory['type'];
  readonly title: string;
  readonly summary: string;
  readonly scope: Scope;
  readonly confidence: number;
  readonly score: number;
  readonly sourceRefs: readonly SourceRef[];
  readonly anchorState: AnchorState;
  readonly matchReason: readonly string[];
  readonly nextAction: string;
}

export interface MemoryPrecheckResult {
  readonly items: readonly PrecheckItem[];
  readonly diagnostics: readonly string[];
  readonly reminderId?: string;
  readonly degraded: boolean;
  readonly timedOut: boolean;
}

export interface AnchorResolution {
  readonly state: AnchorState;
  readonly reason: string;
}

export interface AnchorProvider {
  resolve(anchor: SourceRef, target: PrecheckTarget, cwd: string): Promise<AnchorResolution>;
}

export interface MemoryPrecheckOptions {
  readonly anchorProvider?: AnchorProvider;
  readonly notifications?: NotificationService;
  readonly clock?: () => Date;
  readonly staleThreshold?: number;
  readonly limit?: number;
}

export class MemoryPrecheckService {
  private readonly anchorProvider: AnchorProvider;
  private readonly clock: () => Date;
  private readonly staleThreshold: number;
  private readonly limit: number;

  constructor(
    private readonly database: DatabaseStore,
    private readonly repository: MemoryRepository,
    private readonly audit: AuditLog,
    private readonly options: MemoryPrecheckOptions = {},
  ) {
    this.anchorProvider = options.anchorProvider ?? new FileAnchorProvider();
    this.clock = options.clock ?? (() => new Date());
    this.staleThreshold = options.staleThreshold ?? 3;
    this.limit = options.limit ?? 5;
  }

  async run(input: MemoryPrecheckInput): Promise<MemoryPrecheckResult> {
    const timeoutMs = input.timeoutMs ?? 1500;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<MemoryPrecheckResult>((resolveResult) => {
      timeoutHandle = setTimeout(() => resolveResult({ items: [], diagnostics: ['precheck-timeout-fast-path-continued'], degraded: true, timedOut: true }), timeoutMs);
    });
    try {
      return await Promise.race([this.execute(input), timeout]);
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  }

  private async execute(input: MemoryPrecheckInput): Promise<MemoryPrecheckResult> {
    const cwd = input.cwd ?? process.cwd();
    const memories = (await this.repository.list()).filter((memory) => memory.status === 'active' && memory.visibility !== 'excluded');
    const queryTokens = tokens([input.task, input.target.file, input.target.symbol, input.target.commit].filter((value): value is string => value !== undefined).join(' '));
    const diagnostics: string[] = [];
    const items: PrecheckItem[] = [];
    for (const memory of memories) {
      if (memory.scope.kind === 'project' && (input.projectId === undefined || memory.scope.id !== input.projectId)) continue;
      const anchor = await resolveMemoryAnchors(memory, input.target, cwd, this.anchorProvider);
      if (anchor.state === 'stale') {
        diagnostics.push(`stale-anchor:${memory.id}:${anchor.reason}`);
        await this.recordStaleAnchor(memory);
      }
      const lexical = overlap(queryTokens, tokens(`${memory.title} ${memory.summary} ${memory.tags.join(' ')}`));
      const score = Math.max(0, memory.confidence * 0.35 + scopeWeight(memory.scope) * 0.25 + lexical * 0.25 + (anchor.state === 'valid' ? 0.15 : anchor.state === 'stale' ? -0.2 : 0));
      if (score < 0.25 && anchor.state !== 'valid') continue;
      items.push({
        memoryId: memory.id,
        type: memory.type,
        title: memory.title,
        summary: memory.summary,
        scope: memory.scope,
        confidence: memory.confidence,
        score,
        sourceRefs: memory.sources,
        anchorState: anchor.state,
        matchReason: [`scope:${memory.scope.kind}`, `lexical:${lexical.toFixed(2)}`, `anchor:${anchor.state}`, `confidence:${memory.confidence.toFixed(2)}`],
        nextAction: memory.type === 'procedures' ? `review procedure ${memory.id} before editing` : `open memory ${memory.id}`,
      });
    }
    items.sort((left, right) => right.score - left.score || left.memoryId.localeCompare(right.memoryId));
    const selected = items.slice(0, this.limit);
    let reminderId: string | undefined;
    const top = selected[0];
    if (top !== undefined && top.score >= 0.65 && this.options.notifications !== undefined) {
      const notification = await this.options.notifications.enqueue({
        level: 'L2',
        kind: 'precheck',
        subjectType: 'memory',
        subjectId: top.memoryId,
        title: top.title,
        message: `${top.summary} (${top.nextAction})`,
        source: 'memory_precheck',
        scope: top.scope,
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
        dedupeKey: JSON.stringify({ task: input.task, target: input.target, memoryId: top.memoryId }),
      });
      if (notification.record.status === 'queued') await this.options.notifications.deliverPending('L2');
      if (notification.record.status !== 'suppressed') reminderId = notification.record.id;
    }
    await this.audit.append({
      eventType: 'memory.precheck',
      actor: 'agent',
      subjectType: 'precheck',
      subjectId: precheckId(input),
      occurredAt: this.clock().toISOString(),
      reason: selected.length === 0 ? 'no-relevant-memory' : 'relevant-memory-found',
      payload: { target: input.target, task: input.task, projectId: input.projectId, agentId: input.agentId, memoryIds: selected.map((item) => item.memoryId), diagnostics, reminderId },
    });
    return { items: selected, diagnostics, ...(reminderId === undefined ? {} : { reminderId }), degraded: diagnostics.length > 0, timedOut: false };
  }

  private async recordStaleAnchor(memory: Memory): Promise<void> {
    const key = `precheck-stale:${memory.id}`;
    const count = Number(this.database.getMetadata(key) ?? '0') + 1;
    this.database.upsertMetadata(key, String(count));
    if (count >= this.staleThreshold && memory.status === 'active') {
      await new GovernanceService(this.repository, this.audit, this.clock).transition(memory.id, { type: 'mark_stale' }, { actor: 'system' }, 'repeated stale precheck anchors');
      this.database.upsertMetadata(key, '0');
    }
  }
}

export class FileAnchorProvider implements AnchorProvider {
  async resolve(anchor: SourceRef, target: PrecheckTarget, cwd: string): Promise<AnchorResolution> {
    if (anchor.kind === 'commit') return target.commit === undefined || target.commit === anchor.locator ? { state: 'valid', reason: 'commit-match' } : { state: 'none', reason: 'commit-unrelated' };
    if (anchor.kind === 'symbol') return target.symbol === undefined || target.symbol === anchor.locator || target.symbol === anchor.label ? { state: 'valid', reason: 'symbol-match' } : { state: 'none', reason: 'symbol-unrelated' };
    if (anchor.kind !== 'file' && anchor.kind !== 'line') return { state: 'none', reason: 'anchor-kind-not-editable' };
    const parsed = parseFileLocator(anchor.locator);
    const path = isAbsolute(parsed.path) ? parsed.path : resolve(cwd, parsed.path);
    if (target.file !== undefined) {
      const targetPath = isAbsolute(target.file) ? target.file : resolve(cwd, target.file);
      if (normalizePath(path) !== normalizePath(targetPath)) return { state: 'none', reason: 'file-unrelated' };
    }
    try {
      await access(path);
      if (parsed.line !== undefined) {
        const lines = (await readFile(path, 'utf8')).split(/\r?\n/u);
        if (parsed.line < 1 || parsed.line > lines.length) return { state: 'stale', reason: 'line-out-of-range' };
      }
      if (target.symbol !== undefined) {
        const content = await readFile(path, 'utf8');
        if (!content.includes(target.symbol)) return { state: 'stale', reason: 'symbol-not-found' };
      }
      return { state: 'valid', reason: 'anchor-resolved' };
    } catch {
      return { state: 'stale', reason: 'file-not-found' };
    }
  }
}

async function resolveMemoryAnchors(memory: Memory, target: PrecheckTarget, cwd: string, provider: AnchorProvider): Promise<AnchorResolution> {
  if (memory.anchors.length === 0) return { state: 'none', reason: 'no-anchor' };
  const resolutions = await Promise.all(memory.anchors.map((anchor) => provider.resolve(anchor, target, cwd)));
  return resolutions.find((resolution) => resolution.state === 'valid') ?? resolutions.find((resolution) => resolution.state === 'stale') ?? { state: 'none', reason: 'anchors-unrelated' };
}

function parseFileLocator(locator: string): { path: string; line?: number } {
  const match = /^(.*):(\d+)$/u.exec(locator);
  return match === null ? { path: locator } : { path: match[1] ?? locator, line: Number(match[2]) };
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').toLowerCase();
}

function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((token) => token.length > 1));
}

function overlap(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let matches = 0;
  for (const token of left) if (right.has(token)) matches += 1;
  return matches / left.size;
}

function precheckId(input: MemoryPrecheckInput): string {
  return `precheck-${JSON.stringify({ target: input.target, task: input.task, projectId: input.projectId })}`;
}
