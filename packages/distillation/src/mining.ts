import { randomUUID } from 'node:crypto';
import {
  parseCandidate,
  type Candidate,
  type EvidenceEvent,
  type MemoryType,
  type Observation,
} from '../../domain/src/index.js';
import type { DistillationInput, Distiller } from './index.js';

/**
 * L0 mining layer: deterministic signal classification, fact extraction and
 * template drafts. No LLM is ever called from this module — mined knowledge is
 * assembled by code and only later upgraded by the quality (LLM) passes.
 */

export type EvidenceSignalKind = 'noise' | 'instruction' | 'outcome' | 'fact';

export interface EvidenceSignal {
  readonly kind: EvidenceSignalKind;
  readonly flags: readonly string[];
}

const NOISE_TYPE_RE = /"type"\s*:\s*"(?:token_usage_record|event_msg|file-history-snapshot|system|progress|heartbeat|queue-operation|queue_state|turn-context|telemetry)"/iu;

const FLAG_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['test-ref', /\b(?:tests?|vitest|pytest|jest|lint|build)\b[^{}\n]{0,80}\b(?:pass(?:ed)?|ok|succeed(?:ed)?|✓|green)\b/iu],
  ['error', /\b(?:error|failed?|exception|traceback|EPERM|ENOENT|EACCES|ENOTEMPTY|EEXIST|ETIMEDOUT|ECONNREFUSED|ERR_[A-Z_]+|HTTP\s*[45]\d\d)\b/iu],
  ['fix', /\b(?:fix(?:ed)?|resolv(?:ed|e)|workaround|solved?|修(?:复|好)|搞(?:定|好了))\b/iu],
  ['user-correction', /(?:不对|应该是|下次|以后|别再|不要再|应该用|wrong|don'?t|instead|from now on|should(?:n'?t)?\s+(?:use|do|run))/iu],
  ['decision', /\b(?:decid(?:ed|e)|going with|settled on|let'?s use|采用|选用|决定|就用|定为)\b/iu],
  ['env-fact', /(?:[A-Za-z]:\\|\/(?:home|usr|opt|var|mnt|Users)\/|\b(?:nvm|node|python|java|jdk|pnpm|npm)\s*v?\d+(?:\.\d+)*\b|\bv?\d+\.\d+\.\d+\b|version|版本|环境|路径)/iu],
  ['command', /\b(?:pnpm|npm|npx|yarn|bun|git|cargo|go|python3?|pip3?|docker|kubectl|tsc|vitest|eslint|powershell|bash)\b[^\s"'{}\\]*/iu],
];

const PURE_PATH_RE = /^(?:[A-Za-z]:\\[^\s"'{}]+|\/(?:home|usr|opt|var|mnt|Users)\/[^\s"'{}]+)$/u;
const PURE_COMMAND_RE = /^(?:pnpm|npm|npx|yarn|bun|git|cargo|go|python3?|pip3?|docker|kubectl|tsc|vitest|eslint|powershell|bash|cd)\s/u;
const PURE_VERSION_RE = /^v?\d+(?:\.\d+){1,3}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface RecordShape {
  /** Authoring role of the record content: user/assistant prose vs tool plumbing vs unknown. */
  readonly role: 'user' | 'assistant' | 'tool' | 'other';
  /** Tool-call plumbing (invocations, tool outputs, telemetry) — never worth a draft. */
  readonly plumbing: boolean;
}

/** Format-tolerant shape probe for agent transcript JSONL (claude-code and codex rollouts). */
function recordShape(text: string): RecordShape {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return { role: 'user', plumbing: false };
  let value: unknown;
  try {
    value = JSON.parse(trimmed) as unknown;
  } catch {
    return { role: 'other', plumbing: true };
  }
  if (!isRecord(value)) return { role: 'other', plumbing: true };
  const payload = isRecord(value.payload) ? value.payload : undefined;
  const innerType = typeof payload?.type === 'string' ? payload.type : typeof value.type === 'string' ? value.type : '';
  if (innerType === 'function_call' || innerType === 'function_call_output' || innerType === 'tool_use' || innerType === 'tool_result') {
    return { role: 'tool', plumbing: true };
  }
  const roleOf = (raw: unknown): RecordShape => {
    const role = typeof raw === 'string' && raw === 'user' ? 'user' : typeof raw === 'string' && raw === 'assistant' ? 'assistant' : 'other';
    return { role, plumbing: false };
  };
  if (innerType === 'message') return roleOf(payload?.role ?? value.role);
  const topType = typeof value.type === 'string' ? value.type : '';
  const message = isRecord(value.message) ? value.message : undefined;
  if (topType === 'user' || topType === 'assistant') {
    const content = message?.content;
    const blocks = Array.isArray(content) ? content : [];
    const hasToolBlock = blocks.some((block) => isRecord(block) && (block.type === 'tool_result' || block.type === 'tool_use'));
    const hasText = typeof content === 'string' ? content.length > 0 : blocks.some((block) => isRecord(block) && block.type === 'text');
    if (hasToolBlock && !hasText) return { role: 'tool', plumbing: true };
    return { role: topType, plumbing: hasToolBlock };
  }
  if (topType === 'system' || topType === 'file-history-snapshot') return { role: 'other', plumbing: true };
  return { role: 'other', plumbing: false };
}

/**
 * Prose used for flag detection: drops envelope noise values (bare paths, bare
 * commands, bare version strings) so transcript bookkeeping fields cannot fake
 * an environment fact. Sentences that merely mention a path/command still count.
 */
function flagProse(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return text;
  try {
    const values: string[] = [];
    collectStrings(JSON.parse(trimmed) as unknown, values, 0);
    return values
      .filter((value) => !PURE_PATH_RE.test(value) && !PURE_COMMAND_RE.test(value) && !PURE_VERSION_RE.test(value))
      .join('\n');
  } catch {
    return text;
  }
}

/** Longest readable string values when the line is JSON; the text itself otherwise. */
export function proseOf(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return text;
  try {
    const values: string[] = [];
    collectStrings(JSON.parse(trimmed) as unknown, values, 0);
    return values.join('\n');
  } catch {
    return text;
  }
}

function collectStrings(value: unknown, out: string[], depth: number): void {
  if (depth > 6) return;
  if (typeof value === 'string') {
    if (value.trim().length > 0) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) collectStrings(item, out, depth + 1);
  }
}

/**
 * First readable fragment of a segment. Plain text keeps the historical
 * first-line behaviour verbatim; JSON lines yield their most content-bearing
 * string value so a raw transcript line never becomes a memory summary.
 */
export function extractProseSummary(text: string): string {
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    const trimmed = line.trim();
    const fragment = trimmed.startsWith('{') || trimmed.startsWith('[')
      ? bestJsonFragment(trimmed)
      : trimmed;
    if (fragment !== undefined && fragment.length > 0 && !fragment.trimStart().startsWith('{') && !fragment.trimStart().startsWith('[')) {
      return fragment.slice(0, 240);
    }
  }
  return 'Observed development session outcome';
}

function bestJsonFragment(line: string): string | undefined {
  try {
    const values: string[] = [];
    collectStrings(JSON.parse(line) as unknown, values, 0);
    // String values may themselves carry JSON (tool results embedding JSON) — expand one more level.
    const expanded = values.flatMap((value) => {
      const inner = value.trim();
      if (!inner.startsWith('{') && !inner.startsWith('[')) return [value];
      try {
        const nested: string[] = [];
        collectStrings(JSON.parse(inner) as unknown, nested, 0);
        return nested.length > 0 ? nested : [value];
      } catch {
        return [value];
      }
    });
    const prose = expanded.filter((value) =>
      (/\s/u.test(value) || /\P{ASCII}/u.test(value))
      && !/^\d{4}-\d{2}-\d{2}/u.test(value)
      && !/^[0-9a-fA-F-]{16,}$/u.test(value)
      && !value.trimStart().startsWith('{')
      && !value.trimStart().startsWith('['));
    prose.sort((left, right) => right.length - left.length);
    return prose[0];
  } catch {
    return undefined;
  }
}

export function classifyEvidenceSignal(text: string): EvidenceSignal {
  const shape = recordShape(text);
  const prose = flagProse(text);
  let flags = FLAG_PATTERNS.filter(([, pattern]) => pattern.test(prose)).map(([name]) => name);
  // A "correction" only counts when the user authored it; assistant advice is not a correction.
  if (flags.includes('user-correction') && shape.role !== 'user') {
    flags = flags.filter((name) => name !== 'user-correction');
  }
  const has = (name: string): boolean => flags.includes(name);
  if (has('test-ref') || has('user-correction') || has('decision') || (has('error') && has('fix'))) {
    return { kind: 'outcome', flags };
  }
  if (NOISE_TYPE_RE.test(text) || shape.plumbing) return { kind: 'noise', flags };
  if ((has('env-fact') || has('command')) && (shape.role === 'user' || shape.role === 'assistant')) {
    return { kind: 'fact', flags };
  }
  return { kind: 'instruction', flags };
}

const KIND_RANK: Readonly<Record<EvidenceSignalKind, number>> = { noise: 0, instruction: 1, fact: 2, outcome: 3 };

export function classifySegment(events: readonly Pick<EvidenceEvent, 'payload'>[]): EvidenceSignal {
  let best: EvidenceSignal = { kind: 'noise', flags: [] };
  const flags = new Set<string>();
  for (const event of events) {
    const signal = classifyEvidenceSignal(event.payload.text ?? event.payload.summary);
    for (const flag of signal.flags) flags.add(flag);
    if (KIND_RANK[signal.kind] > KIND_RANK[best.kind]) best = signal;
  }
  return { kind: best.kind, flags: [...flags].sort() };
}

export interface DraftFact {
  readonly text: string;
  readonly evidenceIds: readonly string[];
}

export interface MiningDraft {
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly facts: readonly DraftFact[];
}

const ERROR_CODE_RE = /\b(?:EPERM|ENOENT|EACCES|ENOTEMPTY|EEXIST|ETIMEDOUT|ECONNREFUSED|ERR_[A-Z_]+|HTTP\s*[45]\d\d)\b/gu;
const COMMAND_RE = /\b(?:pnpm|npm|npx|yarn|bun|git|cargo|go|python3?|pip3?|docker|tsc|vitest|eslint|powershell|bash)\s+[^\s"'{}\\]+(?:\s+[^\s"'{}\\]+){0,4}/gu;
const PATH_RE = /(?:[A-Za-z]:\\[^\s"'{}]+|\/(?:home|usr|opt|var|mnt|Users)\/[^\s"'{}]+)/gu;

function extractDraftFacts(evidence: readonly EvidenceEvent[]): DraftFact[] {
  const byText = new Map<string, Set<string>>();
  const push = (label: string, value: string, evidenceId: string): void => {
    const text = `${label}${value.trim()}`;
    const ids = byText.get(text) ?? new Set<string>();
    ids.add(evidenceId);
    byText.set(text, ids);
  };
  for (const event of evidence) {
    const prose = proseOf(event.payload.text ?? event.payload.summary);
    for (const match of prose.match(ERROR_CODE_RE) ?? []) push('错误码：', match, event.id);
    for (const match of prose.match(COMMAND_RE) ?? []) push('命令：', match.replace(/\s+/gu, ' '), event.id);
    for (const match of prose.match(PATH_RE) ?? []) push('路径：', match, event.id);
  }
  return [...byText.entries()].slice(0, 6).map(([text, ids]) => ({ text, evidenceIds: [...ids] }));
}

/** Clips at a semantic boundary (space or CJK/latin punctuation) so titles never end mid-token. */
function clipTitle(value: string, max: number): string {
  if (value.length <= max) return value;
  const head = value.slice(0, max);
  const boundaries = [' ', '，', '。', '；', '、', ',', ';', ':', '：'];
  let cut = -1;
  for (const mark of boundaries) cut = Math.max(cut, head.lastIndexOf(mark));
  return (cut > max * 0.5 ? head.slice(0, cut) : head).trim();
}

export function buildMiningDraft(observation: Observation, evidence: readonly EvidenceEvent[]): MiningDraft {
  const text = evidence.map((event) => event.payload.text ?? event.payload.summary).join('\n');
  const signal = classifySegment(evidence);
  const fragment = extractProseSummary(text);
  const facts = extractDraftFacts(evidence);
  const errorFact = facts.find((fact) => fact.text.startsWith('错误码'));
  const has = (name: string): boolean => signal.flags.includes(name);
  const title = (has('test-ref') && (errorFact !== undefined || has('fix')))
    ? `修复验证：${errorFact === undefined ? clipTitle(fragment, 48) : errorFact.text.slice('错误码：'.length)}`
    : has('decision')
      ? `决策：${clipTitle(fragment, 48)}`
      : has('user-correction')
        ? `用户纠偏：${clipTitle(fragment, 48)}`
        : errorFact !== undefined
          ? `问题修复：${errorFact.text.slice('错误码：'.length)}`
          : `环境/操作事实：${clipTitle(fragment, 48)}`;
  const summary = fragment;
  const body = [summary, ...facts.map((fact) => fact.text)].join('\n').slice(0, 800);
  return { title, summary, body, facts };
}

export function memoryTypeForObservation(kind: Observation['kind']): MemoryType {
  switch (kind) {
    case 'preference': return 'preferences';
    case 'environment': return 'environment';
    case 'procedure': return 'procedures';
    case 'problem': return 'lessons';
    case 'decision': return 'projects';
    case 'exploration': return 'lessons';
  }
}

/** Deterministic template distiller for mined segments; never touches an LLM. */
export class MiningDraftDistiller implements Distiller {
  distill(input: DistillationInput): Promise<Candidate> {
    const first = input.evidence[0];
    if (first === undefined) throw new Error('evidence is required');
    const draft = buildMiningDraft(input.observation, input.evidence);
    const signal = classifySegment(input.evidence);
    const confidence = Math.min(0.9, 0.6 + (signal.flags.includes('test-ref') ? 0.1 : 0) + (signal.flags.includes('fix') ? 0.1 : 0));
    return Promise.resolve(parseCandidate({
      id: `candidate-${randomUUID()}`,
      observationId: input.observation.id,
      ...(first.agentId === undefined ? {} : { agentId: first.agentId }),
      ...(first.projectId === undefined ? {} : { projectId: first.projectId }),
      ...(first.sessionId === undefined ? {} : { sessionId: first.sessionId }),
      ...(first.taskId === undefined ? {} : { taskId: first.taskId }),
      memoryType: memoryTypeForObservation(input.observation.kind),
      title: draft.title,
      summary: draft.summary,
      body: draft.body,
      scopeSuggestion: input.observation.projectId === undefined
        ? { kind: 'global' as const }
        : { kind: 'project' as const, id: input.observation.projectId },
      worthLearning: true,
      evidenceIds: input.evidence.map((event) => event.id),
      anchors: uniqueEvidenceRefs(input.evidence),
      confidence,
      facts: draft.facts.map((fact) => ({ ...fact, confidence })),
      createdAt: input.observation.createdAt,
      decision: 'pending' as const,
      model: {
        provider: 'mining-template',
        model: 'l0-v1',
        mode: 'deterministic' as const,
        promptVersion: 'mining-v1',
        schemaVersion: 'candidate-v2',
        inputEvidenceIds: input.evidence.map((event) => event.id),
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 0,
      },
    }));
  }
}

function uniqueEvidenceRefs(evidence: readonly EvidenceEvent[]) {
  return evidence
    .flatMap((event) => event.refs)
    .filter((ref, index, refs) => refs.findIndex((item) => item.kind === ref.kind && item.locator === ref.locator) === index);
}
