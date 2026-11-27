import type { StructuredCompletionProvider } from './index.js';

/**
 * L2 quality pass: suggests how to resolve a conflicting memory pair. One bounded
 * call per conflict proposal; any failure keeps the deterministic garden advice.
 */

export interface AdjudicationInput {
  readonly a: { readonly id: string; readonly title: string; readonly summary: string };
  readonly b: { readonly id: string; readonly title: string; readonly summary: string };
}

export interface AdjudicationResult {
  readonly verdict: 'keep-both' | 'prefer-a' | 'prefer-b' | 'merge';
  readonly reason: string;
  readonly mergedText?: string;
  readonly adjudicated: boolean;
}

const ADJUDICATE_SYSTEM_PROMPT = [
  'You are Taga memory conflict adjudication.',
  'Two active memories conflict. Decide: keep-both (both hold in different applicability),',
  'prefer-a / prefer-b (one supersedes the other), or merge (one combined memory holds).',
  'Never invent facts beyond the two memories. Keep the decision language of the memories.',
  'Return one JSON object {"verdict": "keep-both|prefer-a|prefer-b|merge", "reason": "short explanation", "merged_text": "only when merge"} and nothing else.',
].join(' ');

export class LlmAdjudicator {
  constructor(
    private readonly provider: StructuredCompletionProvider,
    private readonly model: string,
    private readonly timeoutMs: number,
  ) {}

  async adjudicate(input: AdjudicationInput): Promise<AdjudicationResult> {
    try {
      const response = await this.provider.complete({
        system: ADJUDICATE_SYSTEM_PROMPT,
        user: JSON.stringify({
          memory_a: { id: input.a.id, title: input.a.title, summary: input.a.summary },
          memory_b: { id: input.b.id, title: input.b.title, summary: input.b.summary },
        }),
        model: this.model,
        timeoutMs: this.timeoutMs,
      });
      const draft = parseAdjudicationDraft(response.text);
      return {
        verdict: draft.verdict,
        reason: draft.reason.slice(0, 300),
        ...(draft.mergedText === undefined ? {} : { mergedText: draft.mergedText }),
        adjudicated: true,
      };
    } catch {
      return { verdict: 'keep-both', reason: 'adjudication unavailable', adjudicated: false };
    }
  }
}

function parseAdjudicationDraft(text: string): { verdict: AdjudicationResult['verdict']; reason: string; mergedText?: string } {
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
    if (start < 0 || end <= start) throw new Error('adjudication output did not contain a JSON object');
    parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('adjudication output is not an object');
  const record = parsed as Record<string, unknown>;
  const verdict = record.verdict;
  if (verdict !== 'keep-both' && verdict !== 'prefer-a' && verdict !== 'prefer-b' && verdict !== 'merge') {
    throw new Error('adjudication output has an invalid verdict');
  }
  return {
    verdict,
    reason: typeof record.reason === 'string' ? record.reason : '',
    ...(typeof record.merged_text === 'string' ? { mergedText: record.merged_text } : {}),
  };
}
