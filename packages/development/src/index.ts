import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  parseObservation,
  type Candidate,
  type EvidenceEvent,
  type Observation,
  type Scope,
  type SourceRef,
} from '../../domain/src/index.js';
import { normalizeEvidence } from '../../redaction/src/index.js';
import type { DatabaseStore } from '../../storage/src/index.js';

const execFileAsync = promisify(execFile);

export interface DevelopmentEvidenceInput {
  readonly kind: 'git' | 'test' | 'hook' | 'probe';
  readonly raw: string;
  readonly projectId?: string;
  readonly taskId?: string;
  readonly sessionId?: string;
  readonly occurredAt?: string;
  readonly refs?: readonly SourceRef[];
}

export interface CaptureReport {
  readonly event: EvidenceEvent;
  readonly saved: boolean;
  readonly sensitivity: EvidenceEvent['sensitivity'];
}

export interface SourceHealth {
  readonly source: DevelopmentEvidenceInput['kind'];
  readonly available: boolean;
  readonly degraded: boolean;
  readonly reason?: string;
}

export interface ProbeReport {
  readonly capture: CaptureReport;
  readonly candidate: Candidate;
  readonly health: readonly SourceHealth[];
}

export interface DevelopmentEvidenceOptions {
  readonly clock?: () => Date;
  readonly command?: (command: string, args: readonly string[], cwd: string) => Promise<string>;
}

export class DevelopmentEvidenceService {
  private readonly clock: () => Date;
  private readonly command: (command: string, args: readonly string[], cwd: string) => Promise<string>;

  constructor(
    private readonly database: DatabaseStore,
    options: DevelopmentEvidenceOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.command = options.command ?? defaultCommand;
  }

  capture(input: DevelopmentEvidenceInput): CaptureReport {
    const occurredAt = input.occurredAt ?? this.clock().toISOString();
    const id = stableId(input.kind, input.projectId, input.taskId, input.raw);
    const normalized = normalizeEvidence({
      id,
      source: input.kind === 'test' ? 'ci' : input.kind,
      raw: input.raw,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      occurredAt,
      capturedAt: this.clock().toISOString(),
      refs: input.refs ?? [],
      parserVersion: 'development-v1',
    });
    const saved = this.database.saveEvidence(normalized.event);
    return { event: normalized.event, saved, sensitivity: normalized.event.sensitivity };
  }

  recordGitAction(input: {
    readonly action: 'commit' | 'fix' | 'revert';
    readonly projectId: string;
    readonly projectPath: string;
    readonly commit?: string;
    readonly summary: string;
    readonly taskId?: string;
    readonly occurredAt?: string;
  }): CaptureReport {
    const raw = JSON.stringify({
      kind: 'git',
      action: input.action,
      commit: input.commit,
      summary: input.summary,
      projectPath: input.projectPath,
    });
    return this.capture({
      kind: 'git',
      raw,
      projectId: input.projectId,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
      refs: [{ kind: 'commit', locator: input.commit ?? 'working-tree', label: input.action }],
    });
  }

  recordTestResult(input: {
    readonly projectId: string;
    readonly testCommand: string;
    readonly outcome: 'failed' | 'passed';
    readonly output: string;
    readonly sequence?: number;
    readonly taskId?: string;
    readonly occurredAt?: string;
  }): CaptureReport {
    const raw = JSON.stringify({
      kind: 'test',
      command: input.testCommand,
      outcome: input.outcome,
      sequence: input.sequence,
      output: input.output,
    });
    return this.capture({
      kind: 'test',
      raw,
      projectId: input.projectId,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
      refs: [{ kind: 'test', locator: input.testCommand, label: input.outcome }],
    });
  }

  recordHook(input: {
    readonly projectId: string;
    readonly hook: string;
    readonly payload: string;
    readonly taskId?: string;
    readonly occurredAt?: string;
  }): CaptureReport {
    return this.capture({
      kind: 'hook',
      raw: JSON.stringify({ kind: 'hook', hook: input.hook, payload: input.payload }),
      projectId: input.projectId,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
      refs: [{ kind: 'tool_call', locator: input.hook }],
    });
  }

  async collectGit(projectPath: string, projectId: string): Promise<{ report: CaptureReport | null; health: SourceHealth }> {
    try {
      const output = await this.command('git', ['log', '-1', '--format=%H%n%s'], projectPath);
      const [commit, ...summaryParts] = output.trim().split(/\r?\n/u);
      return {
        report: this.recordGitAction({
          action: 'commit',
          projectId,
          projectPath,
          commit: commit ?? 'unknown',
          summary: summaryParts.join(' '),
        }),
        health: { source: 'git', available: true, degraded: false },
      };
    } catch (error) {
      return {
        report: null,
        health: { source: 'git', available: false, degraded: true, reason: errorMessage(error) },
      };
    }
  }

  async probeEnvironment(projectPath: string, projectId: string): Promise<ProbeReport> {
    const checks = [
      ['node', ['--version']],
      ['pnpm', ['--version']],
      ['git', ['--version']],
    ] as const;
    const values: Record<string, string> = {};
    const health: SourceHealth[] = [];
    for (const [command, args] of checks) {
      try {
        values[command] = (await this.command(command, args, projectPath)).trim();
        health.push({ source: 'probe', available: true, degraded: false });
      } catch (error) {
        health.push({ source: 'probe', available: false, degraded: true, reason: `${command}: ${errorMessage(error)}` });
      }
    }
    const capture = this.capture({
      kind: 'probe',
      projectId,
      raw: JSON.stringify({ projectPath, tools: values }),
      refs: [{ kind: 'tool_call', locator: 'environment-probe' }],
    });
    const observation: Observation = parseObservation({
      id: `observation-${capture.event.id}`,
      evidenceIds: [capture.event.id],
      projectId,
      kind: 'environment',
      summary: 'Local development environment probe',
      novelty: 0.4,
      reuse: 0.5,
      evidenceQuality: capture.sensitivity === 'none' ? 0.9 : 0.5,
      sensitivityRisk: capture.sensitivity === 'blocked' ? 0.8 : 0.05,
      createdAt: this.clock().toISOString(),
    });
    this.database.saveObservation(observation);
    const scope: Scope = { kind: 'project', id: projectId };
    const candidate: Candidate = {
      id: `candidate-${capture.event.id}`,
      observationId: observation.id,
      projectId,
      memoryType: 'environment',
      title: 'Local development environment',
      summary: 'Tool versions observed by a local, redacted probe',
      body: JSON.stringify(values),
      scopeSuggestion: scope,
      worthLearning: Object.keys(values).length > 0,
      evidenceIds: [capture.event.id],
      anchors: capture.event.refs,
      confidence: 0.6,
      createdAt: this.clock().toISOString(),
      decision: 'pending',
    };
    this.database.saveCandidate(candidate);
    return { capture, candidate, health };
  }
}

async function defaultCommand(command: string, args: readonly string[], cwd: string): Promise<string> {
  const result = await execFileAsync(command, [...args], { cwd, timeout: 10_000, maxBuffer: 64_000 });
  return result.stdout;
}

function stableId(kind: string, projectId: string | undefined, taskId: string | undefined, raw: string): string {
  const digest = createHash('sha256')
    .update([kind, projectId ?? '', taskId ?? '', raw].join('\n'))
    .digest('hex');
  return `dev-${digest}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

