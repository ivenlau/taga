import { z } from 'zod';
import type { StructuredCompletionProvider } from '../../../packages/distillation/src/index.js';

const mergeDecisionSchema = z.object({
  action: z.enum(['merge', 'keep']),
  reason: z.string().default(''),
  merged_text: z.string().min(1).optional(),
});

export interface MergeJudgeInput {
  readonly draftTitle: string;
  readonly draftBody: string;
  readonly existingTitle: string;
  readonly existingBody: string;
}

export interface MergeJudgeDecision {
  readonly action: 'merge' | 'keep';
  readonly reason: string;
  readonly mergedText?: string;
}

const MERGE_SYSTEM_PROMPT = [
  'You are a memory consolidation judge for a personal knowledge base.',
  'You will be shown a DRAFT memory and an EXISTING ACTIVE memory.',
  'Decide whether the draft adds enough new information to justify becoming a separate memory,',
  'or whether it mostly restates the existing memory.',
  'Respond with a single JSON object and nothing else:',
  '{"action":"merge|keep","reason":"short explanation","merged_text":"only when action is merge: a single merged memory text combining the durable information of both, in the language of the originals"}',
  'Choose "keep" when the draft contains meaningful new facts, corrections, or context.',
  'Choose "merge" only when the two texts describe the same fact with no meaningful new information.',
].join('\n');

export class LlmMergeJudge {
  constructor(
    private readonly provider: StructuredCompletionProvider,
    private readonly model: string,
    private readonly timeoutMs: number,
  ) {}

  async judge(input: MergeJudgeInput): Promise<MergeJudgeDecision> {
    const user = [
      `DRAFT TITLE: ${input.draftTitle}`,
      `DRAFT TEXT:\n${clip(input.draftBody)}`,
      `EXISTING TITLE: ${input.existingTitle}`,
      `EXISTING TEXT:\n${clip(input.existingBody)}`,
    ].join('\n\n');
    const response = await this.provider.complete({
      system: MERGE_SYSTEM_PROMPT,
      user,
      model: this.model,
      timeoutMs: this.timeoutMs,
    });
    const parsed = mergeDecisionSchema.safeParse(parseJsonObject(response.text));
    if (!parsed.success) throw new Error('llm merge judge returned an invalid decision');
    return {
      action: parsed.data.action,
      reason: parsed.data.reason,
      ...(parsed.data.merged_text === undefined ? {} : { mergedText: parsed.data.merged_text }),
    };
  }
}

function clip(text: string): string {
  return text.length <= 4_000 ? text : `${text.slice(0, 4_000)}…`;
}

function parseJsonObject(text: string): unknown {
  const trimmed = text
    .replace(/<think>[\s\S]*?<\/think>/giu, '')
    .trim()
    .replace(/^```(?:json)?\s*/iu, '')
    .replace(/\s*```$/u, '')
    .trim();
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    throw new Error('llm merge judge returned non-JSON output');
  }
}
