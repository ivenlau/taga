import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { runCli } from '../apps/cli/src/index.js';
import { LiteMcpServer, type McpResponse } from '../apps/mcp/src/index.js';
import { contentHash, writeMarkdownDocument } from '../packages/storage/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';
import type { Memory } from '../packages/domain/src/index.js';
import { DatabaseStore, MarkdownMemoryRepository } from '../packages/storage/src/index.js';
import { SqliteAuditLog } from '../packages/application/src/index.js';
import { DistillationService, FakeDistiller, JsonCandidateRepository, ReviewService } from '../packages/distillation/src/index.js';
import { normalizeEvidence } from '../packages/redaction/src/index.js';
import { FtsRetrievalProvider } from '../packages/retrieval/src/index.js';
import { RecoveryService } from '../packages/recovery/src/index.js';
import type { Observation } from '../packages/domain/src/index.js';

function streams(): { stdout: { value: string; write(chunk: string): void }; stderr: { value: string; write(chunk: string): void } } {
  const stdout = { value: '', write(chunk: string): void { stdout.value += chunk; } };
  const stderr = { value: '', write(chunk: string): void { stderr.value += chunk; } };
  return { stdout, stderr };
}

async function callMcp(server: LiteMcpServer, request: unknown): Promise<McpResponse> {
  const response = await server.handle(request);
  if (response === null) throw new Error('unexpected notification response');
  return response;
}

describe('M1 fast path gate', () => {
  it('runs init, context, reindex, MCP search/get, and forget without daemon or network', async () => {
    const fixture = await createTemporaryDirectory();
    const brain = join(fixture.path, 'brain');
    expect(await runCli(['init', '--yes', `--brain=${brain}`], { cwd: fixture.path, streams: streams() })).toBe(0);
    const memory: Memory = {
      schemaVersion: 1, id: 'm1-memory', type: 'lessons', scope: { kind: 'project', id: 'project-1' }, projectId: 'project-1', status: 'active',
      title: 'Bound retries', summary: 'Use bounded retries for transient failures.', confidence: 0.9, sourceTrust: 'user_authored', visibility: 'private',
      created: '2026-11-10T00:00:00.000Z', updated: '2026-11-10T00:00:00.000Z', lastVerified: null, lastRecalled: null,
      reviewCount: 0, usefulCount: 0, notUsefulCount: 0, expiresAt: null, contentHash: contentHash('retry body'),
      sources: [{ kind: 'test', locator: 'm1-gates.test.ts' }], anchors: [], tags: ['retry'], supersedes: null,
    };
    await writeMarkdownDocument(join(brain, 'lessons', 'project', 'project-1', `${memory.id}.md`), memory, 'retry body');
    expect(await runCli(['reindex', '--apply', `--brain=${brain}`], { cwd: fixture.path, streams: streams() })).toBe(0);
    const preview = streams();
    expect(await runCli(['context', 'preview', '--json', '--project=project-1', `--brain=${brain}`], { cwd: fixture.path, streams: preview })).toBe(0);
    expect(preview.stdout.value).toContain('Bound retries');
    const server = new LiteMcpServer(brain);
    const search = await callMcp(server, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'retry', project_id: 'project-1' } } });
    expect(JSON.stringify(search.result)).toContain('m1-memory');
    const get = await callMcp(server, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_get', arguments: { memory_id: 'm1-memory', include_body: true } } });
    expect(JSON.stringify(get.result)).toContain('retry body');
    expect(await runCli(['memory', 'forget', 'm1-memory', '--yes', `--brain=${brain}`], { cwd: fixture.path, streams: streams() })).toBe(0);
    await fixture.cleanup();
  }, 20_000);

  it('covers evidence, review, two projects, two agents, cross-project recall, and recovery', async () => {
    const fixture = await createTemporaryDirectory();
    const brain = join(fixture.path, 'brain');
    await runCli(['init', '--yes', `--brain=${brain}`], { cwd: fixture.path, streams: streams() });
    const database = new DatabaseStore(join(brain, 'taga.db'));
    const repository = new MarkdownMemoryRepository(brain);
    const candidates = new JsonCandidateRepository(join(brain, 'candidates.json'));
    const evidenceA = normalizeEvidence({ id: 'evidence-a', source: 'watcher', agentId: 'pi', projectId: 'project-a', raw: 'agent pi: bounded retry policy', path: 'project-a/session.jsonl', occurredAt: '2026-11-10T00:00:00.000Z', capturedAt: '2026-11-10T00:00:01.000Z' }).event;
    const evidenceB = normalizeEvidence({ id: 'evidence-b', source: 'watcher', agentId: 'claude-code', projectId: 'project-b', raw: 'agent claude-code: bounded retry policy', path: 'project-b/session.jsonl', occurredAt: '2026-11-10T00:00:00.000Z', capturedAt: '2026-11-10T00:00:01.000Z' }).event;
    const observation = (id: string, projectId?: string): Observation => ({
      id,
      evidenceIds: [projectId === 'project-a' ? 'evidence-a' : 'evidence-b'],
      ...(projectId === undefined ? {} : { projectId }),
      kind: 'procedure',
      summary: 'Use bounded retries across agent sessions',
      novelty: 0.9,
      reuse: 0.9,
      evidenceQuality: 0.9,
      sensitivityRisk: 0,
      createdAt: '2026-11-10T00:00:02.000Z',
    });
    const distiller = new DistillationService(new FakeDistiller(), candidates);
    const candidateA = await distiller.createCandidate({ observation: observation('observation-a', 'project-a'), evidence: [evidenceA] });
    const candidateB = await distiller.createCandidate({ observation: observation('observation-b', 'project-b'), evidence: [evidenceB] });
    const candidateGlobal = await distiller.createCandidate({ observation: observation('observation-global'), evidence: [evidenceA] });
    expect(candidateA?.decision).toBe('pending');
    expect(candidateB?.decision).toBe('pending');
    expect(candidateGlobal?.decision).toBe('pending');
    const review = new ReviewService(candidates, repository, new SqliteAuditLog(database), () => new Date('2026-11-10T00:01:00.000Z'));
    const memoryA = await review.accept(candidateA!.id, { actor: 'user', actorId: 'reviewer' }, 'accept project A');
    const memoryB = await review.accept(candidateB!.id, { actor: 'user', actorId: 'reviewer' }, 'accept project B');
    const memoryGlobal = await review.accept(candidateGlobal!.id, { actor: 'user', actorId: 'reviewer' }, 'accept global lesson');
    expect(memoryA.scope).toEqual({ kind: 'project', id: 'project-a' });
    expect(memoryB.scope).toEqual({ kind: 'project', id: 'project-b' });
    expect(memoryGlobal.scope).toEqual({ kind: 'global' });
    const provider = new FtsRetrievalProvider(database);
    for (const record of await repository.records()) provider.upsert(record.memory, record.body);
    const recalled = provider.search({ query: 'bounded retries', scope: { kind: 'project', id: 'project-b' } });
    expect(recalled.map((item) => item.memory.id)).toContain(memoryB.id);
    expect(recalled.map((item) => item.memory.id)).toContain(memoryGlobal.id);
    expect(recalled.map((item) => item.memory.id)).not.toContain(memoryA.id);
    expect((await new SqliteAuditLog(database).list()).length).toBeGreaterThanOrEqual(3);
    const recovery = new RecoveryService(brain, database);
    await recovery.forget(memoryB.id, true, 'M1 recovery gate');
    expect(provider.search({ query: 'bounded retries', scope: { kind: 'project', id: 'project-b' } }).map((item) => item.memory.id)).not.toContain(memoryB.id);
    await recovery.reindex();
    expect(provider.search({ query: 'bounded retries', scope: { kind: 'project', id: 'project-b' } }).map((item) => item.memory.id)).not.toContain(memoryB.id);
    database.close();
    await fixture.cleanup();
  }, 15000);
});
