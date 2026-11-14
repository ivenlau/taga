import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../apps/cli/src/index.js';
import { parseCandidate, type Memory, type MemoryType } from '../packages/domain/src/index.js';
import { GardenService } from '../packages/garden/src/index.js';
import { MetricsService } from '../packages/metrics/src/index.js';
import { ProcedureService } from '../packages/procedures/src/index.js';
import { M3AcceptanceService, ReleaseGateService } from '../packages/release/src/index.js';
import { FtsRetrievalProvider } from '../packages/retrieval/src/index.js';
import { DatabaseStore, writeMarkdownDocument } from '../packages/storage/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';

const now = '2026-11-11T12:00:00.000Z';

function memory(id: string, type: MemoryType, contentHash: string, title = id, expiresAt: string | null = null): Memory {
  return {
    schemaVersion: 1,
    id,
    type,
    scope: { kind: 'global' },
    projectId: null,
    status: 'active',
    title,
    summary: `${title} summary`,
    confidence: 0.9,
    sourceTrust: 'user_authored',
    visibility: 'private',
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-11-11T00:00:00.000Z',
    lastVerified: null,
    lastRecalled: null,
    reviewCount: 0,
    usefulCount: 0,
    notUsefulCount: 0,
    expiresAt,
    contentHash,
    sources: [{ kind: 'test', locator: 'release.test.ts' }],
    anchors: [],
    tags: [],
    supersedes: null,
  };
}

describe('M2-09 release gates', () => {
  it('audits all required gates without making Gemini a dependency', async () => {
    const fixture = await createTemporaryDirectory();
    const brain = join(fixture.path, 'brain');
    await mkdir(brain, { recursive: true });
    const database = new DatabaseStore(join(brain, 'taga.db'), { now: () => new Date(now) });
    const memories = [
      memory('preference-a', 'preferences', 'sha256:duplicate'),
      memory('preference-b', 'preferences', 'sha256:duplicate'),
      memory('environment-a', 'environment', 'sha256:environment-a', 'Runtime version'),
      memory('environment-b', 'environment', 'sha256:environment-b', 'Runtime version'),
      memory('procedure-a', 'procedures', 'sha256:procedure', 'Release procedure', '2026-01-02T00:00:00.000Z'),
      memory('lesson-a', 'lessons', 'sha256:lesson'),
      memory('project-a', 'projects', 'sha256:project'),
    ];
    for (const item of memories) await writeMarkdownDocument(join(brain, item.type, 'global', `${item.id}.md`), item, `${item.title} body`);
    new GardenService(database, { clock: () => new Date(now) }).scan(memories);
    const procedures = new ProcedureService(database, () => new Date(now));
    procedures.recordReuse({ procedureId: 'procedure-a', kind: 'recall', occurredAt: now });
    procedures.recordReuse({ procedureId: 'procedure-a', kind: 'useful', occurredAt: now });
    procedures.recordReuse({ procedureId: 'procedure-a', kind: 'verified', occurredAt: now });
    for (const agent of ['pi', 'claude-code', 'codex', 'opencode']) database.upsertMetadata(`release:agent:${agent}`, JSON.stringify({ agentId: agent, recalled: true }));
    const service = new ReleaseGateService(brain, database, () => new Date(now));
    for (const gateId of ['resilience-daemon-restart', 'resilience-fast-path', 'resilience-cursor-jobs', 'resilience-forget-replay', 'resilience-reindex', 'platform-windows', 'platform-linux', 'security-no-secret-leakage', 'performance-budgets']) {
      service.recordEvidence({ gateId, status: 'passed', artifact: 'automated suite', details: `password=not-persisted ${gateId} passed`, recordedAt: now });
    }
    const audit = await service.check();
    expect(audit.passed).toBe(true);
    expect(audit.blockers).toEqual([]);
    expect(audit.excludedAgents).toEqual(['gemini']);
    expect(audit.gates.find((gate) => gate.id === 'gemini-excluded')?.status).toBe('not_required');
    expect(JSON.stringify(service.evidence())).not.toContain('not-persisted');
    database.close();
    await fixture.cleanup();
  });
});

describe('M3-09 release gates', () => {
  it('passes measured proactive, cross-agent, platform, privacy, and resilience gates', async () => {
    const fixture = await createTemporaryDirectory();
    const brain = join(fixture.path, 'brain');
    await mkdir(brain, { recursive: true });
    const database = new DatabaseStore(join(brain, 'taga.db'), { now: () => new Date(now) });
    const lesson = memory('lesson-cross-agent', 'lessons', 'sha256:cross-agent', 'Cross-agent retry lesson');
    await writeMarkdownDocument(join(brain, 'lessons', 'global', `${lesson.id}.md`), lesson, 'Use bounded retries and verify the result.');
    new FtsRetrievalProvider(database).upsert(lesson, 'Use bounded retries and verify the result.');
    database.saveCandidate(parseCandidate({
      id: 'candidate-release-accepted',
      observationId: 'observation-release-accepted',
      agentId: 'codex',
      projectId: 'project-release',
      memoryType: 'lessons',
      title: 'Release accepted',
      summary: 'Release accepted',
      body: 'Release accepted',
      scopeSuggestion: { kind: 'project', id: 'project-release' },
      worthLearning: true,
      evidenceIds: ['evidence-release'],
      confidence: 0.9,
      createdAt: now,
      decidedAt: now,
      decision: 'accepted',
    }));
    const metrics = new MetricsService(database, () => new Date(now));
    metrics.record({ kind: 'reminder_delivered', subjectType: 'notification', subjectId: 'notification-release', occurredAt: now });
    metrics.record({ kind: 'open', subjectType: 'notification', subjectId: 'notification-release', occurredAt: now });
    metrics.recordTokenComparison({ baselineTokens: 1000, contextTokens: 600, source: 'm3-release-fixture', occurredAt: now });
    new M3AcceptanceService(database, () => new Date(now)).recordCrossAgentReuse({
      sourceAgentId: 'codex',
      consumingAgentId: 'claude-code',
      evidenceId: 'evidence-release',
      memoryId: lesson.id,
      contextArtifact: 'CLAUDE.md',
      recordedAt: now,
    });
    const service = new ReleaseGateService(brain, database, () => new Date(now));
    for (const gateId of [
      'agent-static-distribution',
      'proactive-policy',
      'platform-windows-m3',
      'platform-linux-m3',
      'platform-macos-m3',
      'platform-launchd-fallback',
      'security-sensitive-data',
      'resilience-forget-tombstone',
      'resilience-stale-anchor',
      'resilience-daemon-restart-m3',
      'resilience-source-replay',
      'resilience-fast-path-m3',
    ]) {
      service.recordEvidence({ gateId, status: 'passed', artifact: 'm3 automated suite', details: `password=not-persisted ${gateId} passed`, recordedAt: now });
    }
    const audit = await service.check('M3');
    expect(audit.passed).toBe(true);
    expect(audit.blockers).toEqual([]);
    expect(audit.deferredScope.map((item) => item.id)).toContain('l3-automatic-execution');
    expect(audit.gates.find((gate) => gate.id === 'metric-distillation-precision')?.status).toBe('passed');
    expect(audit.gates.find((gate) => gate.id === 'metric-proactive-false-positive')?.detail).toContain('denominator=1');
    expect(JSON.stringify(service.evidence())).not.toContain('not-persisted');
    database.close();

    const output = streams();
    expect(await runCli(['release', 'check', '--json', `--brain=${brain}`], { cwd: fixture.path, streams: output })).toBe(0);
    expect((JSON.parse(output.stdout.value) as { code: string }).code).toBe('M3_RELEASE_READY');
    await fixture.cleanup();
  });
});

function streams(): { readonly stdout: { value: string; write(chunk: string): void }; readonly stderr: { value: string; write(chunk: string): void } } {
  const output = { value: '', write(chunk: string) { this.value += chunk; } };
  const error = { value: '', write(chunk: string) { this.value += chunk; } };
  return { stdout: output, stderr: error };
}
