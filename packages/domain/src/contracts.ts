import { z } from 'zod';
import { errorCodes, TagaError } from './errors.js';

const dateTimeSchema = z.iso.datetime({ offset: true });
const nonEmptyIdSchema = z.string().min(1);
const scoreSchema = z.number().min(0).max(1);

export const memoryTypeSchema = z.enum([
  'preferences',
  'environment',
  'procedures',
  'lessons',
  'projects',
]);
export type MemoryType = z.infer<typeof memoryTypeSchema>;

export const memoryStatusSchema = z.enum([
  'candidate',
  'draft',
  'active',
  'stale',
  'superseded',
  'forgotten',
]);
export type MemoryStatus = z.infer<typeof memoryStatusSchema>;

export const scopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('global') }),
  z.object({ kind: z.literal('domain'), id: nonEmptyIdSchema }),
  z.object({ kind: z.literal('project'), id: nonEmptyIdSchema }),
]);
export type Scope = z.infer<typeof scopeSchema>;

export const sourceTrustSchema = z.enum(['user_authored', 'observed', 'inferred']);
export type SourceTrust = z.infer<typeof sourceTrustSchema>;

export const visibilitySchema = z.enum(['private', 'shareable', 'excluded']);
export type Visibility = z.infer<typeof visibilitySchema>;

export const sourceRefSchema = z.object({
  kind: z.enum(['file', 'line', 'symbol', 'url', 'commit', 'test', 'tool_call']),
  locator: z.string().min(1),
  label: z.string().min(1).optional(),
  hash: z.string().min(1).optional(),
});
export type SourceRef = z.infer<typeof sourceRefSchema>;

export const redactedPayloadSchema = z.object({
  title: z.string().min(1).optional(),
  summary: z.string().min(1),
  text: z.string().optional(),
  structured: z.record(z.string(), z.unknown()).optional(),
});
export type RedactedPayload = z.infer<typeof redactedPayloadSchema>;

const memoryBaseSchema = z.object({
  schemaVersion: z.literal(1),
  id: nonEmptyIdSchema,
  type: memoryTypeSchema,
  scope: scopeSchema,
  projectId: nonEmptyIdSchema.nullable().optional(),
  status: memoryStatusSchema,
  title: z.string().min(1),
  summary: z.string().min(1),
  confidence: scoreSchema,
  sourceTrust: sourceTrustSchema,
  visibility: visibilitySchema,
  created: dateTimeSchema,
  updated: dateTimeSchema,
  lastVerified: dateTimeSchema.nullable().optional(),
  lastRecalled: dateTimeSchema.nullable().optional(),
  reviewCount: z.number().int().nonnegative().default(0),
  usefulCount: z.number().int().nonnegative().default(0),
  notUsefulCount: z.number().int().nonnegative().default(0),
  expiresAt: dateTimeSchema.nullable().optional(),
  contentHash: z.string().min(1),
  sources: z.array(sourceRefSchema),
  anchors: z.array(sourceRefSchema).default([]),
  tags: z.array(z.string().min(1)).default([]),
  supersedes: nonEmptyIdSchema.nullable().optional(),
});

export const memorySchema = memoryBaseSchema.superRefine((memory, context) => {
  if (memory.scope.kind === 'project' && memory.projectId !== memory.scope.id) {
    context.addIssue({
      code: 'custom',
      path: ['projectId'],
      message: 'project scope requires a matching projectId',
    });
  }
  if (memory.status === 'active' && memory.sources.length === 0) {
    context.addIssue({
      code: 'custom',
      path: ['sources'],
      message: 'active memory requires at least one source',
    });
  }
});
export type Memory = z.infer<typeof memorySchema>;

export const evidenceSourceSchema = z.enum(['hook', 'watcher', 'mcp', 'git', 'ci', 'probe']);
export type EvidenceSource = z.infer<typeof evidenceSourceSchema>;

export const evidenceSensitivitySchema = z.enum(['none', 'redacted', 'blocked']);
export type EvidenceSensitivity = z.infer<typeof evidenceSensitivitySchema>;

export const evidenceEventSchema = z.object({
  id: nonEmptyIdSchema,
  schemaVersion: z.literal(1),
  source: evidenceSourceSchema,
  agentId: nonEmptyIdSchema.optional(),
  projectId: nonEmptyIdSchema.optional(),
  sessionId: nonEmptyIdSchema.optional(),
  taskId: nonEmptyIdSchema.optional(),
  occurredAt: dateTimeSchema,
  capturedAt: dateTimeSchema,
  payload: redactedPayloadSchema,
  refs: z.array(sourceRefSchema),
  contentHash: z.string().min(1),
  parserVersion: z.string().min(1).optional(),
  redactionVersion: z.string().min(1),
  sensitivity: evidenceSensitivitySchema,
});
export type EvidenceEvent = z.infer<typeof evidenceEventSchema>;

export const observationKindSchema = z.enum([
  'problem',
  'decision',
  'procedure',
  'preference',
  'environment',
  'exploration',
]);
export const observationSchema = z.object({
  id: nonEmptyIdSchema,
  evidenceIds: z.array(nonEmptyIdSchema).min(1),
  projectId: nonEmptyIdSchema.optional(),
  sessionId: nonEmptyIdSchema.optional(),
  taskId: nonEmptyIdSchema.optional(),
  kind: observationKindSchema,
  summary: z.string().min(1),
  novelty: scoreSchema,
  reuse: scoreSchema,
  evidenceQuality: scoreSchema,
  sensitivityRisk: scoreSchema,
  createdAt: dateTimeSchema,
});
export type Observation = z.infer<typeof observationSchema>;

export const modelTraceSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  mode: z.enum(['deterministic', 'llm', 'shadow']).default('deterministic'),
  promptVersion: z.string().min(1),
  schemaVersion: z.string().min(1),
  inputEvidenceIds: z.array(nonEmptyIdSchema),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  latencyMs: z.number().nonnegative(),
  cost: z.number().nonnegative().optional(),
  fallbackReason: z.string().min(1).optional(),
});
export type ModelTrace = z.infer<typeof modelTraceSchema>;

export const atomicFactSchema = z.object({
  text: z.string().min(1),
  evidenceIds: z.array(nonEmptyIdSchema).min(1),
  confidence: scoreSchema.default(0.7),
});
export type AtomicFact = z.infer<typeof atomicFactSchema>;

export const extractedEntitySchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1).optional(),
  evidenceIds: z.array(nonEmptyIdSchema).min(1),
});
export type ExtractedEntity = z.infer<typeof extractedEntitySchema>;

export const temporalFactSchema = z.object({
  text: z.string().min(1),
  occurredStart: dateTimeSchema.optional(),
  occurredEnd: dateTimeSchema.optional(),
  evidenceIds: z.array(nonEmptyIdSchema).min(1),
});
export type TemporalFact = z.infer<typeof temporalFactSchema>;

export const causalLinkSchema = z.object({
  fromFact: nonEmptyIdSchema,
  toFact: nonEmptyIdSchema,
  relation: z.enum(['causes', 'enables', 'prevents', 'contradicts']),
  evidenceIds: z.array(nonEmptyIdSchema).min(1),
});
export type CausalLink = z.infer<typeof causalLinkSchema>;

export const applicabilitySchema = z.object({
  conditions: z.array(z.string().min(1)).default([]),
  exclusions: z.array(z.string().min(1)).default([]),
});
export type Applicability = z.infer<typeof applicabilitySchema>;

export const candidateDecisionSchema = z.enum(['pending', 'accepted', 'rejected', 'merged']);
export const candidateSchema = z.object({
  id: nonEmptyIdSchema,
  observationId: nonEmptyIdSchema,
  agentId: nonEmptyIdSchema.optional(),
  projectId: nonEmptyIdSchema.optional(),
  sessionId: nonEmptyIdSchema.optional(),
  taskId: nonEmptyIdSchema.optional(),
  memoryType: memoryTypeSchema,
  title: z.string().min(1),
  summary: z.string().min(1),
  body: z.string(),
  scopeSuggestion: scopeSchema,
  worthLearning: z.boolean(),
  evidenceIds: z.array(nonEmptyIdSchema).min(1),
  anchors: z.array(sourceRefSchema).default([]),
  confidence: scoreSchema.default(0.7),
  packId: z.string().min(1).optional(),
  applicability: z.object({
    status: z.enum(['applicable', 'unavailable']),
    reason: z.string().min(1),
  }).optional(),
  sensitivity: evidenceSensitivitySchema.optional(),
  createdAt: dateTimeSchema.optional(),
  decidedAt: dateTimeSchema.optional(),
  decision: candidateDecisionSchema,
  decisionReason: z.string().min(1).optional(),
  duplicateOf: nonEmptyIdSchema.optional(),
  facts: z.array(atomicFactSchema).optional(),
  entities: z.array(extractedEntitySchema).optional(),
  temporalFacts: z.array(temporalFactSchema).optional(),
  causalLinks: z.array(causalLinkSchema).optional(),
  applicabilityDetails: applicabilitySchema.optional(),
  model: modelTraceSchema.optional(),
});
export type Candidate = z.infer<typeof candidateSchema>;

export const policySchema = z.object({
  defaultScope: scopeSchema,
  allowDraftRecall: z.boolean(),
  staticTokenBudget: z.number().int().positive(),
  dailyNotificationLimit: z.number().int().nonnegative(),
  quietHours: z
    .object({ start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) })
    .optional(),
  remoteModelAllowed: z.boolean(),
  proactive: z.object({
    enabled: z.boolean(),
    policyVersion: z.string().min(1),
    autoCollect: z.boolean(),
    autoDistill: z.boolean(),
    allowL1Notifications: z.boolean(),
    allowL2Reminders: z.boolean(),
    autoActivateLessons: z.boolean(),
    autoActivateFeedback: z.boolean().optional(),
    autoActivateMinUsefulCount: z.number().int().nonnegative().optional(),
    quietHours: z
      .object({ start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) })
      .optional(),
    dailyNotificationLimit: z.number().int().nonnegative(),
  }).optional(),
});
export type Policy = z.infer<typeof policySchema>;

export const contextBuildInputSchema = z.object({
  agentId: nonEmptyIdSchema,
  projectId: nonEmptyIdSchema.optional(),
  cwd: z.string().min(1).optional(),
  task: z.string().min(1).optional(),
  channel: z.enum(['static', 'mcp', 'preview']),
  tokenBudget: z.number().int().positive().optional(),
  policy: policySchema.optional(),
});
export type ContextBuildInput = z.infer<typeof contextBuildInputSchema>;

export const contextSectionSchema = z.object({
  kind: z.enum(['header', 'habits', 'environment', 'project', 'lessons']),
  title: z.string().min(1),
  content: z.string(),
  tokenEstimate: z.number().int().nonnegative(),
  memoryIds: z.array(nonEmptyIdSchema),
});
export type ContextSection = z.infer<typeof contextSectionSchema>;

export const contextDecisionSchema = z.object({
  memoryId: nonEmptyIdSchema.optional(),
  decision: z.enum(['included', 'excluded', 'truncated']),
  reason: z.array(z.string().min(1)).min(1),
  score: z.number().optional(),
  source: z.string().min(1).optional(),
  budgetBucket: z.string().min(1).optional(),
});
export type ContextDecision = z.infer<typeof contextDecisionSchema>;

export const contextPackSchema = z.object({
  id: nonEmptyIdSchema,
  schemaVersion: z.literal(1),
  agentId: nonEmptyIdSchema,
  projectId: nonEmptyIdSchema.optional(),
  generatedAt: dateTimeSchema,
  content: z.string(),
  sections: z.array(contextSectionSchema),
  tokenEstimate: z.number().int().nonnegative(),
  truncated: z.boolean(),
  decisions: z.array(contextDecisionSchema),
  degraded: z.boolean(),
});
export type ContextPack = z.infer<typeof contextPackSchema>;

export const auditEventSchema = z.object({
  id: nonEmptyIdSchema,
  eventType: z.string().min(1),
  actor: z.enum(['user', 'agent', 'system', 'daemon']),
  actorId: nonEmptyIdSchema.optional(),
  subjectType: z.string().min(1),
  subjectId: nonEmptyIdSchema,
  occurredAt: dateTimeSchema,
  requestId: nonEmptyIdSchema.optional(),
  payload: z.record(z.string(), z.unknown()),
  prevHash: z.string().min(1).optional(),
  eventHash: z.string().min(1),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

export const memoryCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('activate') }),
  z.object({ type: z.literal('refresh') }),
  z.object({ type: z.literal('mark_stale') }),
  z.object({ type: z.literal('supersede'), replacementId: nonEmptyIdSchema }),
  z.object({ type: z.literal('forget'), confirmed: z.literal(true) }),
]);
export type MemoryCommand = z.infer<typeof memoryCommandSchema>;

const allowedTransitions: Record<MemoryStatus, Partial<Record<MemoryCommand['type'], MemoryStatus>>> = {
  candidate: {},
  draft: { activate: 'active', supersede: 'superseded', forget: 'forgotten' },
  active: { mark_stale: 'stale', supersede: 'superseded', forget: 'forgotten' },
  stale: { refresh: 'active', supersede: 'superseded', forget: 'forgotten' },
  superseded: { forget: 'forgotten' },
  forgotten: {},
};

export function transitionMemory(memory: Memory, command: MemoryCommand): Memory {
  const nextStatus = allowedTransitions[memory.status][command.type];
  if (nextStatus === undefined) {
    throw new TagaError(errorCodes.conflict, 'illegal memory state transition', {
      from: memory.status,
      command: command.type,
    });
  }
  if (command.type === 'supersede' && command.replacementId === memory.id) {
    throw new TagaError(errorCodes.validationFailed, 'memory cannot supersede itself');
  }
  return memorySchema.parse({
    ...memory,
    status: nextStatus,
    updated: new Date().toISOString(),
  });
}

export function parseMemory(input: unknown): Memory {
  return parseContract(memorySchema, input, 'memory');
}

export function parseEvidenceEvent(input: unknown): EvidenceEvent {
  return parseContract(evidenceEventSchema, input, 'evidence event');
}

export function parseObservation(input: unknown): Observation {
  return parseContract(observationSchema, input, 'observation');
}

export function parseCandidate(input: unknown): Candidate {
  return parseContract(candidateSchema, input, 'candidate');
}

function parseContract<T>(schema: z.ZodType<T>, input: unknown, subject: string): T {
  const result = schema.safeParse(input);
  if (result.success) {
    return result.data;
  }
  throw new TagaError(errorCodes.validationFailed, `${subject} validation failed`, {
    issueCount: result.error.issues.length,
  });
}
