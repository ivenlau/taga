export {
  compareScope,
  DEFAULT_FEEDBACK_POLICY,
  GovernanceService,
  InMemoryAuditLog,
  InMemoryMemoryRepository,
  isDefaultRecallEligible,
  scopeWeight,
} from './governance.js';
export { SqliteAuditLog } from './sqlite-audit.js';
export {
  CONSOLIDATION_JOB_KIND,
  consolidationConfigFromEnv,
  consolidationPolicy,
  enqueueConsolidationScan,
  enqueueScheduledConsolidationScan,
} from './consolidation.js';
export type { ConsolidationConfig, ConsolidationLlmConfig } from './consolidation.js';
export {
  DEFAULT_PROACTIVE_POLICY,
  ProactivePolicyService,
  evaluateProactivePolicy,
  normalizePolicy,
  proactivePolicyFrom,
} from './policy.js';
export type {
  AuditInput,
  AuditLog,
  AuditRecord,
  FeedbackPolicy,
  LifecycleActor,
  MemoryFeedbackKind,
  MemoryCreateInput,
  MemoryEdit,
  MemoryRepository,
} from './governance.js';
export type {
  DedupVerdict,
  PolicyDecision,
  ProactiveAction,
  ProactiveEvent,
  ProactiveLevel,
  ProactivePolicy,
} from './policy.js';
