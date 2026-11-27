import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chunkText, createLocalBgeM3Embedder } from '../../embedding/src/index.js';
import { normalizeEvidence } from '../../redaction/src/index.js';
import { ZvecMemoryIndex } from '../../semantic-index/src/index.js';
import { DatabaseStore } from '../../storage/src/index.js';
import { MarkdownMemoryRepository } from '../../storage/src/index.js';
import { type AuditLog, type LlmConfig } from '../../application/src/index.js';
import { parseObservation, type EvidenceEvent, type MemoryType, type Observation } from '../../domain/src/index.js';
import {
  buildDistillerChain,
  DatabaseCandidateRepository,
  metadataLlmBudgetState,
  type SemanticDuplicateVerdict,
  type StructuredCompletionProvider,
} from '../../distillation/src/index.js';

export type SemanticDuplicateChecker = (text: string) => Promise<SemanticDuplicateVerdict | undefined>;

export interface LearnInput {
  readonly text?: string;
  readonly file?: string;
  readonly dir?: string;
  readonly url?: string;
  readonly include?: string;
  readonly type?: MemoryType;
  readonly project?: string;
  readonly allowNetwork?: boolean;
}

export interface LearnOptions {
  readonly brainPath: string;
  readonly semantic?: { readonly modelPath?: string | undefined } | undefined;
  readonly audit?: AuditLog;
  readonly llm?: LlmConfig;
  readonly provider?: StructuredCompletionProvider;
  readonly maxBlocks?: number;
  readonly maxFileBytes?: number;
  readonly duplicateThreshold?: number;
  readonly clock?: () => Date;
}

export interface LearnReport {
  readonly source: string;
  readonly blocks: number;
  readonly candidates: number;
  readonly duplicates: number;
  readonly skippedRedacted: number;
  readonly errors: readonly string[];
}

const DEFAULT_IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.taga', '.claude', '.codex', '.tmp', '__pycache__', 'venv', 'target',
]);
const DEFAULT_INCLUDE_EXTENSIONS = ['.md', '.txt'];
const DEFAULT_MAX_BLOCKS = 50;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;

export function createSemanticDuplicateChecker(
  brainPath: string,
  options: { readonly threshold?: number; readonly modelPath?: string | undefined } = {},
): SemanticDuplicateChecker | undefined {
  const threshold = options.threshold ?? 0.95;
  const modelPath = options.modelPath ?? process.env.TAGA_BGE_M3_MODEL_PATH;
  if (modelPath === undefined || modelPath.length === 0) return undefined;
  const index = new ZvecMemoryIndex(join(brainPath, '.taga', 'semantic'));
  const embedder = createLocalBgeM3Embedder({ modelPath, batchSize: 4 });
  return async (text: string): Promise<SemanticDuplicateVerdict | undefined> => {
    const integrity = await index.integrity();
    if (integrity.activeGeneration === null) return undefined;
    if (integrity.activeGeneration.embeddingFingerprint !== embedder.metadata.fingerprint || integrity.activeGeneration.dimensions !== embedder.metadata.dimensions) {
      return undefined;
    }
    const probeText = text.slice(0, 1800);
    const vector = (await embedder.embed([{ id: 'learn-dedup-probe', text: probeText }]))[0]?.vector;
    if (vector === undefined || vector.length === 0) return undefined;
    const hits = await index.query({ vector, topK: 3, status: 'active' });
    const top = hits[0];
    if (top === undefined) return undefined;
    return top.score >= threshold
      ? { duplicate: true, duplicateOf: top.memoryId, score: top.score }
      : { duplicate: false, score: top.score };
  };
}

export async function runLearn(input: LearnInput, options: LearnOptions): Promise<LearnReport> {
  const clock = options.clock ?? (() => new Date());
  const maxBlocks = options.maxBlocks ?? DEFAULT_MAX_BLOCKS;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const errors: string[] = [];
  const state: { blocks: LearnBlock[]; truncated: boolean } = { blocks: [], truncated: false };
  const push = (block: LearnBlock): void => {
    if (state.blocks.length >= maxBlocks) {
      state.truncated = true;
      return;
    }
    state.blocks.push(block);
  };
  await collectBlocks(input, { maxFileBytes, errors }, push, state);
  const source = input.text !== undefined
    ? 'text'
    : input.file !== undefined
      ? `file:${input.file}`
      : input.dir !== undefined
        ? `dir:${input.dir}`
        : input.url !== undefined
          ? `url:${input.url}`
          : 'none';
  if (state.blocks.length === 0 && errors.length === 0) errors.push('no readable content found for the given source');
  if (state.truncated) errors.push(`block cap ${maxBlocks} reached; narrow the source or raise the limit`);

  const database = new DatabaseStore(join(options.brainPath, 'taga.db'));
  const checker = createSemanticDuplicateChecker(options.brainPath, { threshold: options.duplicateThreshold ?? 0.95, modelPath: options.semantic?.modelPath });
  const chain = buildDistillerChain({
    ...(options.audit === undefined ? {} : { audit: options.audit }),
    ...(options.llm === undefined ? {} : { llm: options.llm }),
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    consumer: 'learn',
    budgetState: metadataLlmBudgetState(database),
  });
  const candidatesRepo = new DatabaseCandidateRepository(database);
  const kind = kindFromType(input.type);
  const processed = new Set(database.listObservations().map((item) => item.id));
  let candidates = 0;
  let duplicates = 0;
  let skippedRedacted = 0;
  try {
    for (const block of state.blocks) {
      for (const chunk of chunkText(block.text)) {
        const hash = createHash('sha256').update(chunk.text, 'utf8').digest('hex');
        const normalized = normalizeEvidence({
          id: `evidence-learn-${hash}`,
          source: 'watcher',
          raw: chunk.text,
          ...(input.project === undefined ? {} : { projectId: input.project }),
          occurredAt: clock().toISOString(),
          capturedAt: clock().toISOString(),
          refs: [{ kind: block.refKind, locator: block.locator }],
          parserVersion: 'learn-v1',
        });
        if (normalized.event.sensitivity === 'blocked') {
          skippedRedacted += 1;
          continue;
        }
        database.saveEvidence(normalized.event);
        const observation = buildLearnObservation(normalized.event, kind, input.project, clock);
        if (processed.has(observation.id)) {
          duplicates += 1;
          continue;
        }
        if (checker !== undefined) {
          const verdict = await checker(chunk.text);
          if (verdict !== undefined && verdict.duplicate) {
            duplicates += 1;
            continue;
          }
        }
        const candidate = await chain.distill({ observation, evidence: [normalized.event], verified: true });
        candidatesRepo.save(candidate);
        database.saveObservation(observation);
        processed.add(observation.id);
        candidates += 1;
      }
    }
  } finally {
    database.close();
  }
  const report: LearnReport = {
    source,
    blocks: state.blocks.length,
    candidates,
    duplicates,
    skippedRedacted,
    errors,
  };
  try {
    await options.audit?.append({
      eventType: 'learn.completed',
      actor: 'user',
      subjectType: 'learn',
      subjectId: source,
      occurredAt: clock().toISOString(),
      reason: 'learn run completed',
      payload: { ...report },
    });
  } catch {
    // audit failures must never break a learn run
  }
  return report;
}

interface LearnBlock {
  readonly text: string;
  readonly refKind: 'file' | 'url' | 'tool_call';
  readonly locator: string;
}

async function collectBlocks(
  input: LearnInput,
  limits: { readonly maxFileBytes: number; readonly errors: string[] },
  push: (block: LearnBlock) => void,
  state: { truncated: boolean },
): Promise<void> {
  if (input.text !== undefined) {
    push({ text: input.text, refKind: 'tool_call', locator: `learn:text:${sha256(input.text)}` });
    return;
  }
  if (input.file !== undefined) {
    const content = await readBoundedTextFile(input.file, limits.maxFileBytes, limits.errors);
    if (content !== null) push({ text: content, refKind: 'file', locator: input.file });
    return;
  }
  if (input.dir !== undefined) {
    const extensions = parseExtensions(input.include);
    await walkDirectory(input.dir, extensions, limits, push, state, 0);
    return;
  }
  if (input.url !== undefined) {
    if (input.allowNetwork !== true) {
      limits.errors.push('network fetch is disabled; set TAGA_LEARN_ALLOW_NETWORK=1 to allow URL learning');
      return;
    }
    try {
      const text = await fetchUrlText(input.url);
      push({ text, refKind: 'url', locator: input.url });
    } catch (error) {
      limits.errors.push(`url fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function walkDirectory(
  dir: string,
  extensions: readonly string[],
  limits: { readonly maxFileBytes: number; readonly errors: string[] },
  push: (block: LearnBlock) => void,
  state: { truncated: boolean },
  depth: number,
): Promise<void> {
  if (state.truncated || depth > 8) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    limits.errors.push(`dir read failed: ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  for (const entry of entries) {
    if (state.truncated) return;
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (DEFAULT_IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      await walkDirectory(entryPath, extensions, limits, push, state, depth + 1);
      continue;
    }
    if (!entry.isFile() || !extensions.includes(extname(entry.name).toLowerCase())) continue;
    const content = await readBoundedTextFile(entryPath, limits.maxFileBytes, limits.errors);
    if (content !== null) push({ text: content, refKind: 'file', locator: entryPath });
  }
}

async function readBoundedTextFile(path: string, maxFileBytes: number, errors: string[]): Promise<string | null> {
  try {
    const info = await stat(path);
    if (info.size > maxFileBytes) {
      errors.push(`file skipped (larger than ${maxFileBytes} bytes): ${path}`);
      return null;
    }
    const content = await readFile(path, 'utf8');
    if (content.includes('\u0000')) {
      errors.push(`file skipped (binary content): ${path}`);
      return null;
    }
    return content;
  } catch (error) {
    errors.push(`file read failed: ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function parseExtensions(include?: string): readonly string[] {
  if (include === undefined || include.trim().length === 0) return DEFAULT_INCLUDE_EXTENSIONS;
  const parsed = include.split(',').map((item) => item.trim().toLowerCase()).filter((item) => item.length > 0)
    .map((item) => item.startsWith('.') ? item : `.${item}`);
  return parsed.length === 0 ? DEFAULT_INCLUDE_EXTENSIONS : parsed;
}

async function fetchUrlText(url: string): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(20_000),
    headers: { 'user-agent': 'taga-learn/0.1' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/') && !contentType.includes('json')) {
    throw new Error(`refused non-text content: ${contentType}`);
  }
  return htmlToText(await response.text());
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style[\s\S]*?<\/style>/giu, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/giu, '\n')
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gu, ' ')
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#0?39;/gu, "'")
    .replace(/[ \t]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function buildLearnObservation(
  event: EvidenceEvent,
  kind: Observation['kind'],
  project: string | undefined,
  clock: () => Date,
): Observation {
  return parseObservation({
    id: `observation-learn-${createHash('sha256').update(event.id, 'utf8').digest('hex')}`,
    evidenceIds: [event.id],
    ...(project === undefined ? {} : { projectId: project }),
    kind,
    summary: (event.payload.text ?? event.payload.summary).slice(0, 120),
    novelty: 0.8,
    reuse: 0.9,
    evidenceQuality: 1,
    sensitivityRisk: event.sensitivity === 'redacted' ? 0.4 : 0,
    createdAt: clock().toISOString(),
  });
}

function kindFromType(type?: MemoryType): Observation['kind'] {
  switch (type) {
    case 'preferences': return 'preference';
    case 'environment': return 'environment';
    case 'procedures': return 'procedure';
    case 'projects': return 'decision';
    default: return 'exploration';
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

export interface CorrectionLearnInput {
  readonly memoryId: string;
  readonly note?: string;
  readonly project?: string;
}

export function enqueueLearnCorrection(
  database: DatabaseStore,
  input: CorrectionLearnInput,
  clock: () => Date = () => new Date(),
): boolean {
  return database.enqueueJobIfAbsent({
    id: `learn-correction-${createHash('sha256').update(`${input.memoryId}:${input.note ?? ''}:${clock().toISOString().slice(0, 10)}`).digest('hex')}`,
    kind: LEARN_CORRECTION_JOB_KIND,
    payload: JSON.stringify({
      memoryId: input.memoryId,
      ...(input.note === undefined ? {} : { note: input.note }),
      ...(input.project === undefined ? {} : { project: input.project }),
    }),
  });
}

export const LEARN_CORRECTION_JOB_KIND = 'learn.correction';
export const LEARN_DISTILL_JOB_KIND = 'learn.distill';

export async function runCorrectionLearn(
  input: CorrectionLearnInput,
  options: LearnOptions,
): Promise<LearnReport> {
  const repository = new MarkdownMemoryRepository(options.brainPath);
  const memory = await repository.get(input.memoryId);
  if (memory === null) throw new Error(`correction learn: memory not found: ${input.memoryId}`);
  const text = [
    '一条既有记忆被用户标记为与实际行为冲突，需要修正学习。',
    `冲突记忆标题：${memory.title}`,
    `冲突记忆摘要：${memory.summary}`,
    `用户纠正说明：${input.note ?? '（未提供具体说明，仅标记冲突）'}`,
    '请提炼一条修正后的经验教训：说明原记忆为何不可靠、正确的行为或事实是什么、今后如何避免同样误判。',
  ].join('\n');
  return runLearn(
    { text, type: 'lessons', ...(input.project === undefined ? {} : { project: input.project }) },
    options,
  );
}


export interface LearnWatchOptions extends LearnOptions {
  readonly intervalMs?: number;
  readonly signal?: AbortSignal;
  readonly maxCycles?: number;
}

const watchDelay = (milliseconds: number, signal?: AbortSignal): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, milliseconds);
  signal?.addEventListener('abort', () => {
    clearTimeout(timer);
    resolve();
  }, { once: true });
});

export async function runLearnWatch(
  input: LearnInput & { readonly dir: string },
  options: LearnWatchOptions,
): Promise<LearnReport[]> {
  const intervalMs = options.intervalMs ?? 30_000;
  const reports: LearnReport[] = [];
  let cycles = 0;
  const signal = options.signal;
  const isAborted = (): boolean => signal?.aborted === true;
  const database = new DatabaseStore(join(options.brainPath, 'taga.db'));
  const stateKey = `learn:watch:${sha256(input.dir)}`;
  try {
    while (!isAborted() && (options.maxCycles === undefined || cycles < options.maxCycles)) {
      const report = await learnWatchCycle(input, options, database, stateKey);
      if (report !== null) reports.push(report);
      cycles += 1;
      if (isAborted() || (options.maxCycles !== undefined && cycles >= options.maxCycles)) break;
      await watchDelay(intervalMs, signal);
    }
  } finally {
    database.close();
  }
  return reports;
}

async function learnWatchCycle(
  input: LearnInput & { readonly dir: string },
  options: LearnOptions,
  database: DatabaseStore,
  stateKey: string,
): Promise<LearnReport | null> {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const extensions = parseExtensions(input.include);
  const state = parseWatchState(database.getMetadata(stateKey));
  const files = await listWatchFiles(input.dir, extensions, maxFileBytes, state);
  if (files.changed.length === 0) return null;
  let candidates = 0;
  let duplicates = 0;
  let skippedRedacted = 0;
  const errors: string[] = [];
  for (const file of files.changed) {
    const report = await runLearn(
      { file: file.path, ...(input.type === undefined ? {} : { type: input.type }), ...(input.project === undefined ? {} : { project: input.project }) },
      options,
    );
    candidates += report.candidates;
    duplicates += report.duplicates;
    skippedRedacted += report.skippedRedacted;
    errors.push(...report.errors);
  }
  database.upsertMetadata(stateKey, JSON.stringify({ schemaVersion: 1, dir: input.dir, hashes: files.hashes, updatedAt: new Date().toISOString() }));
  return { source: `watch:${input.dir}`, blocks: files.changed.length, candidates, duplicates, skippedRedacted, errors };
}

function parseWatchState(raw: string | null): Record<string, string> {
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw) as { hashes?: Record<string, string> };
    return typeof parsed.hashes === 'object' && parsed.hashes !== null ? parsed.hashes : {};
  } catch {
    return {};
  }
}

async function listWatchFiles(
  dir: string,
  extensions: readonly string[],
  maxFileBytes: number,
  state: Record<string, string>,
): Promise<{ changed: readonly { readonly path: string; readonly text: string }[]; hashes: Record<string, string> }> {
  const hashes: Record<string, string> = {};
  const changed: { path: string; text: string }[] = [];
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > 8) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = join(current, entry.name);
      if (entry.isDirectory()) {
        if (DEFAULT_IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        await walk(entryPath, depth + 1);
        continue;
      }
      if (!entry.isFile() || !extensions.includes(extname(entry.name).toLowerCase())) continue;
      try {
        const content = await readFile(entryPath, 'utf8');
        const hash = sha256(content);
        hashes[entryPath] = hash;
        if (state[entryPath] !== hash) changed.push({ path: entryPath, text: content });
      } catch {
        // unreadable files are skipped this cycle
      }
    }
  };
  await walk(dir, 0);
  return { changed, hashes };
}

export {
  REFLECT_JOB_KIND,
  enqueueScheduledReflectScan,
  reflectConfigFromEnv,
  resolveReflectConfig,
  runReflect,
} from './reflect.js';
export type { ReflectConfig, ReflectFileSection, ReflectGroupReport, ReflectInput, ReflectReport, ReflectRunOptions } from './reflect.js';
