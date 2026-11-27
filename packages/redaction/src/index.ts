import { createHash } from 'node:crypto';
import {
  parseEvidenceEvent,
  type EvidenceEvent,
  type EvidenceSource,
  type SourceRef,
} from '../../domain/src/index.js';

export type RedactionAction = 'none' | 'replace' | 'block';

export interface RedactionFinding {
  readonly kind: string;
  readonly action: RedactionAction;
  readonly count: number;
}

export interface RedactionResult {
  readonly text: string;
  readonly action: RedactionAction;
  readonly findings: readonly RedactionFinding[];
  readonly redactionVersion: string;
}

export interface NormalizeEvidenceInput {
  readonly id: string;
  readonly source: EvidenceSource;
  readonly raw: string;
  readonly path?: string;
  readonly agentId?: string;
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly taskId?: string;
  readonly parserVersion?: string;
  readonly occurredAt: string;
  readonly capturedAt: string;
  readonly refs?: readonly SourceRef[];
  readonly maxBytes?: number;
  readonly structured?: Record<string, unknown>;
}

export interface NormalizedEvidence {
  readonly event: EvidenceEvent;
  readonly report: RedactionResult;
}

const detectors: readonly { kind: string; pattern: RegExp; action: RedactionAction }[] = [
  { kind: 'private_key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gu, action: 'block' },
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, action: 'replace' },
  { kind: 'bearer_token', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/giu, action: 'replace' },
  { kind: 'api_key', pattern: /\b(?:sk|pk|api|key)[-_][A-Za-z0-9_-]{12,}\b/giu, action: 'replace' },
  { kind: 'password', pattern: /\b(?:password|passwd|pwd)\s*[:=]\s*[^\s,;]+/giu, action: 'replace' },
  { kind: 'cookie', pattern: /\b(?:cookie|set-cookie)\s*[:=]\s*[^\r\n]+/giu, action: 'replace' },
  { kind: 'cloud_credential', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, action: 'replace' },
  { kind: 'api_key_assignment', pattern: /\b(?:api[_-]?key|access[_-]?token)\s*[:=]\s*[^\r\n]+/giu, action: 'replace' },
  { kind: 'env_secret', pattern: /\b(?:AWS_SECRET_ACCESS_KEY|DATABASE_URL|TOKEN|SECRET|PRIVATE_KEY)\s*=\s*[^\r\n]+/giu, action: 'replace' },
];

export function redactText(input: string): RedactionResult {
  let text = input;
  let action: RedactionAction = 'none';
  const findings: RedactionFinding[] = [];
  for (const detector of detectors) {
    const matches = text.match(detector.pattern);
    if (matches === null) continue;
    findings.push({ kind: detector.kind, action: detector.action, count: matches.length });
    if (detector.action === 'block') {
      action = 'block';
      continue;
    }
    if (action !== 'block') action = 'replace';
    text = text.replace(detector.pattern, `[REDACTED:${detector.kind}]`);
  }
  return { text: action === 'block' ? '' : text, action, findings, redactionVersion: 'rules-v1' };
}

export function normalizeEvidence(input: NormalizeEvidenceInput): NormalizedEvidence {
  const maxBytes = input.maxBytes ?? 256_000;
  const rawHash = `sha256:${createHash('sha256').update(input.raw, 'utf8').digest('hex')}`;
  const blockedByPath = input.path !== undefined && /(?:^|[\\/])(?:\.env|.*\.(?:pem|key))$/iu.test(input.path);
  const binary = input.raw.includes('\u0000');
  const oversized = Buffer.byteLength(input.raw, 'utf8') > maxBytes;
  const redacted = blockedByPath || binary || oversized ? {
    text: '',
    action: 'block' as const,
    findings: [{ kind: blockedByPath ? 'sensitive_path' : binary ? 'binary_input' : 'oversized_input', action: 'block' as const, count: 1 }],
    redactionVersion: 'rules-v1',
  } : redactText(input.raw);
  const payload = redacted.action === 'block'
    ? { summary: `blocked evidence (${redacted.findings.map((finding) => finding.kind).join(', ')})`, ...(input.structured === undefined ? {} : { structured: input.structured }) }
    : { summary: redacted.text.slice(0, 500), text: redacted.text, ...(input.structured === undefined ? {} : { structured: input.structured }) };
  const event = parseEvidenceEvent({
    id: input.id,
    schemaVersion: 1,
    source: input.source,
    ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input.parserVersion === undefined ? {} : { parserVersion: input.parserVersion }),
    occurredAt: input.occurredAt,
    capturedAt: input.capturedAt,
    payload,
    refs: input.refs ?? [],
    contentHash: rawHash,
    redactionVersion: redacted.redactionVersion,
    sensitivity: redacted.action === 'block' ? 'blocked' : redacted.action === 'replace' ? 'redacted' : 'none',
  });
  return { event, report: redacted };
}
