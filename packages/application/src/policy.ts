import {
  policySchema,
  type MemoryType,
  type Policy,
  type Scope,
} from '../../domain/src/index.js';
import type { AuditLog, LifecycleActor } from './governance.js';

export type ProactiveLevel = 'L0' | 'L1' | 'L2' | 'L3';
export type ProactiveAction = 'collect' | 'distill' | 'notify' | 'remind' | 'activate' | 'external';
export type DedupVerdict = 'novel' | 'keep' | 'merge' | 'duplicate' | 'skipped';

export interface ProactivePolicy {
  readonly enabled: boolean;
  readonly policyVersion: string;
  readonly autoCollect: boolean;
  readonly autoDistill: boolean;
  readonly allowL1Notifications: boolean;
  readonly allowL2Reminders: boolean;
  readonly autoActivateLessons: boolean;
  readonly autoActivateFeedback: boolean;
  readonly autoActivateMinUsefulCount: number;
  readonly quietHours?: { readonly start: string; readonly end: string };
  readonly dailyNotificationLimit: number;
}

export interface ProactiveEvent {
  readonly action: ProactiveAction;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly scope?: Scope;
  readonly memoryType?: MemoryType;
  readonly confidence?: number;
  readonly evidenceGatePassed?: boolean;
  readonly usefulCount?: number;
  readonly dedupVerdict?: DedupVerdict;
  readonly explicitApproval?: boolean;
  readonly timedOut?: boolean;
  readonly currentNotificationCount?: number;
  readonly now?: string;
}

export interface PolicyDecision {
  readonly level: ProactiveLevel;
  readonly allowed: boolean;
  readonly outcome: 'allowed' | 'review_required' | 'denied';
  readonly reason: string;
  readonly policyVersion: string;
  readonly scope?: Scope;
}

export const DEFAULT_PROACTIVE_POLICY: ProactivePolicy = {
  enabled: true,
  policyVersion: 'm3-v1',
  autoCollect: true,
  autoDistill: true,
  allowL1Notifications: true,
  allowL2Reminders: false,
  autoActivateLessons: false,
  autoActivateFeedback: false,
  autoActivateMinUsefulCount: 2,
  dailyNotificationLimit: 20,
};

export function proactivePolicyFrom(input?: Policy | Partial<ProactivePolicy>): ProactivePolicy {
  const configured = input === undefined
    ? {}
    : 'proactive' in input
      ? input.proactive ?? {}
      : input;
  const values = configured as Partial<ProactivePolicy>;
  const base = {
    ...DEFAULT_PROACTIVE_POLICY,
    enabled: values.enabled ?? DEFAULT_PROACTIVE_POLICY.enabled,
    policyVersion: values.policyVersion ?? DEFAULT_PROACTIVE_POLICY.policyVersion,
    autoCollect: values.autoCollect ?? DEFAULT_PROACTIVE_POLICY.autoCollect,
    autoDistill: values.autoDistill ?? DEFAULT_PROACTIVE_POLICY.autoDistill,
    allowL1Notifications: values.allowL1Notifications ?? DEFAULT_PROACTIVE_POLICY.allowL1Notifications,
    allowL2Reminders: values.allowL2Reminders ?? DEFAULT_PROACTIVE_POLICY.allowL2Reminders,
    autoActivateLessons: values.autoActivateLessons ?? DEFAULT_PROACTIVE_POLICY.autoActivateLessons,
    autoActivateFeedback: values.autoActivateFeedback ?? DEFAULT_PROACTIVE_POLICY.autoActivateFeedback,
    autoActivateMinUsefulCount: values.autoActivateMinUsefulCount ?? DEFAULT_PROACTIVE_POLICY.autoActivateMinUsefulCount,
    dailyNotificationLimit: values.dailyNotificationLimit ?? DEFAULT_PROACTIVE_POLICY.dailyNotificationLimit,
  };
  return values.quietHours === undefined ? base : { ...base, quietHours: values.quietHours };
}

export function normalizePolicy(input: Policy): Policy {
  return policySchema.parse({
    ...input,
    proactive: proactivePolicyFrom(input),
  });
}

export function evaluateProactivePolicy(
  event: ProactiveEvent,
  configured?: Policy | Partial<ProactivePolicy>,
): PolicyDecision {
  const policy = proactivePolicyFrom(configured);
  const common = { policyVersion: policy.policyVersion, ...(event.scope === undefined ? {} : { scope: event.scope }) };
  if (!policy.enabled) return { level: 'L0', allowed: false, outcome: 'denied', reason: 'policy-disabled', ...common };
  if (event.timedOut === true) return { level: 'L3', allowed: false, outcome: 'denied', reason: 'approval-timeout', ...common };

  if (event.action === 'collect') {
    return { level: 'L0', allowed: policy.autoCollect, outcome: policy.autoCollect ? 'allowed' : 'denied', reason: policy.autoCollect ? 'automatic-collection-enabled' : 'automatic-collection-disabled', ...common };
  }
  if (event.action === 'distill') {
    return { level: 'L0', allowed: policy.autoDistill, outcome: policy.autoDistill ? 'allowed' : 'denied', reason: policy.autoDistill ? 'automatic-distillation-enabled' : 'automatic-distillation-disabled', ...common };
  }
  if (event.action === 'notify') {
    const withinLimit = (event.currentNotificationCount ?? 0) < policy.dailyNotificationLimit;
    const quiet = isQuietHour(event.now, policy.quietHours);
    const allowed = policy.allowL1Notifications && withinLimit && !quiet;
    return { level: 'L1', allowed, outcome: allowed ? 'allowed' : 'denied', reason: !policy.allowL1Notifications ? 'l1-notifications-disabled' : quiet ? 'quiet-hours' : !withinLimit ? 'daily-notification-limit' : 'notification-allowed', ...common };
  }
  if (event.action === 'remind') {
    const withinLimit = (event.currentNotificationCount ?? 0) < policy.dailyNotificationLimit;
    const quiet = isQuietHour(event.now, policy.quietHours);
    const allowed = policy.allowL2Reminders && withinLimit && !quiet;
    return { level: 'L2', allowed, outcome: allowed ? 'allowed' : 'denied', reason: !policy.allowL2Reminders ? 'l2-reminders-disabled' : quiet ? 'quiet-hours' : !withinLimit ? 'daily-notification-limit' : 'reminder-allowed', ...common };
  }
  if (event.action === 'activate') {
    const lessonsEligible = event.memoryType === 'lessons' && event.confidence !== undefined && event.confidence >= 0.9 && event.evidenceGatePassed === true;
    const dedupClean = event.dedupVerdict === undefined || event.dedupVerdict === 'novel' || event.dedupVerdict === 'keep' || event.dedupVerdict === 'skipped';
    const feedbackEligible = dedupClean && event.usefulCount !== undefined && event.usefulCount >= policy.autoActivateMinUsefulCount;
    const lessonsAllowed = policy.autoActivateLessons && lessonsEligible;
    const feedbackAllowed = policy.autoActivateFeedback && feedbackEligible;
    const allowed = lessonsAllowed || feedbackAllowed;
    const reason = allowed
      ? lessonsAllowed ? 'lesson-auto-activation-allowed' : 'feedback-auto-activation-allowed'
      : !dedupClean
        ? 'dedup-flagged-requires-review'
        : !lessonsEligible && !feedbackEligible
          ? 'activation-eligibility-not-met'
          : lessonsEligible
            ? 'lesson-auto-activation-disabled'
            : 'feedback-auto-activation-disabled';
    return { level: 'L2', allowed, outcome: allowed ? 'allowed' : 'review_required', reason, ...common };
  }
  const allowed = event.explicitApproval === true;
  return { level: 'L3', allowed, outcome: allowed ? 'allowed' : 'review_required', reason: allowed ? 'explicit-approval' : 'explicit-approval-required', ...common };
}

export class ProactivePolicyService {
  constructor(
    private readonly audit: AuditLog,
    private readonly policy: Policy | Partial<ProactivePolicy> = DEFAULT_PROACTIVE_POLICY,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  evaluate(event: ProactiveEvent): PolicyDecision {
    return evaluateProactivePolicy(event, this.policy);
  }

  async decide(event: ProactiveEvent, actor: LifecycleActor = { actor: 'daemon' }): Promise<PolicyDecision> {
    const decision = this.evaluate(event);
    await this.audit.append({
      eventType: 'proactive.policy_decision',
      actor: actor.actor,
      ...(actor.actorId === undefined ? {} : { actorId: actor.actorId }),
      subjectType: event.subjectType,
      subjectId: event.subjectId,
      occurredAt: this.clock().toISOString(),
      reason: decision.reason,
      payload: {
        action: event.action,
        level: decision.level,
        outcome: decision.outcome,
        allowed: decision.allowed,
        policyVersion: decision.policyVersion,
        ...(event.scope === undefined ? {} : { scope: event.scope }),
      },
    });
    return decision;
  }
}

function isQuietHour(value: string | undefined, quietHours: ProactivePolicy['quietHours']): boolean {
  if (value === undefined || quietHours === undefined) return false;
  const time = value.slice(11, 16);
  if (!/^\d{2}:\d{2}$/u.test(time)) return false;
  return quietHours.start <= quietHours.end
    ? time >= quietHours.start && time < quietHours.end
    : time >= quietHours.start || time < quietHours.end;
}
