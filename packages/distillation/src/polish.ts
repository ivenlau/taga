import type { Candidate } from '../../domain/src/index.js';
import type { StructuredCompletionProvider } from './index.js';

/**
 * L2 quality pass: rewrites an accepted deterministic draft into a generalized
 * memory. One bounded call per acceptance; any failure silently keeps the draft.
 */

export interface PolishResult {
  readonly title: string;
  readonly summary: string;
  readonly confidence?: number;
  readonly polished: boolean;
}

export interface CandidatePolisher {
  polish(candidate: Candidate): Promise<PolishResult>;
}

const POLISH_SYSTEM_PROMPT = [
  'You are Taga memory polishing.',
  'Rewrite the draft memory into one durable, reusable lesson: keep every fact faithful to the draft (never invent),',
  'state applicability boundaries (when the lesson does and does not hold), and remove session-specific noise.',
  'Title: at most 60 characters, a generalized lesson statement.',
  'Summary: 1-3 sentences carrying the lesson and its applicability; keep the draft language.',
  'Return one JSON object {"title": "...", "summary": "...", "confidence": 0..1} and nothing else.',
].join(' ');

export class PolishService implements CandidatePolisher {
  constructor(
    private readonly provider: StructuredCompletionProvider,
    private readonly model: string,
    private readonly timeoutMs: number,
  ) {}

  async polish(candidate: Candidate): Promise<PolishResult> {
    const fallback: PolishResult = { title: candidate.title, summary: candidate.summary, polished: false };
    try {
      const response = await this.provider.complete({
        system: POLISH_SYSTEM_PROMPT,
        user: JSON.stringify({
          memoryType: candidate.memoryType,
          draft: { title: candidate.title, summary: candidate.summary, body: candidate.body },
          outputSchema: { title: 'string (<=60 chars)', summary: 'string (1-3 sentences)', confidence: 'number 0..1' },
        }),
        model: this.model,
        timeoutMs: this.timeoutMs,
      });
      const draft = parsePolishDraft(response.text);
      const title = draft.title.trim().slice(0, 120);
      const summary = draft.summary.trim();
      if (title.length === 0 || summary.length === 0) return fallback;
      return {
        title,
        summary,
        ...(typeof draft.confidence === 'number' ? { confidence: Math.min(0.95, Math.max(0.5, draft.confidence)) } : {}),
        polished: true,
      };
    } catch {
      return fallback;
    }
  }
}

function parsePolishDraft(text: string): { title: string; summary: string; confidence?: number } {
  const trimmed = text
    .replace(/<think>[\s\S]*?<\/think>/giu, '')
    .trim()
    .replace(/^```(?:json)?\s*/iu, '')
    .replace(/\s*```$/u, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('polish output did not contain a JSON object');
    parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('polish output is not an object');
  const record = parsed as Record<string, unknown>;
  if (typeof record.title !== 'string' || typeof record.summary !== 'string') throw new Error('polish output is missing title/summary');
  return {
    title: record.title,
    summary: record.summary,
    ...(typeof record.confidence === 'number' ? { confidence: record.confidence } : {}),
  };
}
