import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';
import { startWebServer } from '../apps/web/src/server.js';

interface ApiResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly code?: string;
  readonly message?: string;
  readonly data?: Record<string, unknown>;
}

describe('web workbench API', () => {
  let fixture: Awaited<ReturnType<typeof createTemporaryDirectory>>;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    fixture = await createTemporaryDirectory();
    const started = await startWebServer({ brainPath: join(fixture.path, 'brain'), port: 0 });
    server = started.server;
    base = started.url;
  });

  afterEach(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    await fixture.cleanup();
  });

  async function call(path: string, init?: RequestInit): Promise<ApiResponse> {
    const response = await fetch(base + path, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
    const payload = await response.json() as { ok: boolean; code?: string; message?: string; data?: Record<string, unknown> };
    return { status: response.status, ...payload };
  }

  async function createDraft(): Promise<Record<string, unknown>> {
    const created = await call('/api/memories', {
      method: 'POST',
      body: JSON.stringify({
        type: 'lessons',
        scope: { kind: 'global' },
        title: 'SQLite WAL concurrency lesson',
        summary: 'Enable WAL and busy_timeout for multi-process access',
        body: 'Turn on WAL mode and busy_timeout when several processes share the sqlite database.',
      }),
    });
    expect(created.status, JSON.stringify(created)).toBe(200);
    return (created.data as { memory: Record<string, unknown> }).memory;
  }

  it('serves eight themes with morandi as the default', async () => {
    const response = await call('/api/themes');
    expect(response.status).toBe(200);
    const data = response.data as { themes: unknown[]; default: string };
    expect(data.themes).toHaveLength(8);
    expect(data.default).toBe('morandi');
    const ids = data.themes.map((theme) => (theme as { id: string }).id);
    expect(ids).toEqual(expect.arrayContaining(['macaron', 'morandi', 'maillard', 'forest', 'ocean', 'terracotta', 'lavender', 'graphite']));
  });

  it('keeps draft memories out of default recall and flags them under include_draft', async () => {
    const memory = await createDraft();
    const excluded = await call('/api/search?q=sqlite');
    expect(excluded.status).toBe(200);
    expect((excluded.data as { items: unknown[] }).items).toHaveLength(0);
    const included = await call('/api/search?q=sqlite&includeDraft=true');
    const items = (included.data as { items: { id: string; score: number }[] }).items;
    expect(items.map((item) => item.id)).toContain(memory.id);
  });

  it('promotes a draft into recall and records auditable lifecycle events', async () => {
    const memory = await createDraft();
    const id = memory.id as string;
    const promoted = await call(`/api/memories/${id}/transition`, {
      method: 'POST',
      body: JSON.stringify({ type: 'activate', reason: 'promote in test' }),
    });
    expect(promoted.status).toBe(200);
    expect((promoted.data as { memory: { status: string } }).memory.status).toBe('active');

    const recalled = await call('/api/search?q=sqlite');
    expect((recalled.data as { items: { id: string }[] }).items.map((item) => item.id)).toContain(id);

    const audit = await call('/api/audit');
    const events = (audit.data as { items: { eventType: string; actor: string; actorId?: string; subjectId: string }[] }).items;
    const forMemory = events.filter((event) => event.subjectId === id);
    expect(forMemory.some((event) => event.eventType === 'memory.created')).toBe(true);
    expect(forMemory.every((event) => event.actor === 'user' && event.actorId === 'web')).toBe(true);
  });

  it('rejects forget without explicit confirmation and executes it with confirmation', async () => {
    const memory = await createDraft();
    const id = memory.id as string;
    const rejected = await call(`/api/memories/${id}/transition`, {
      method: 'POST',
      body: JSON.stringify({ type: 'forget' }),
    });
    expect(rejected.status).toBe(409);
    expect(rejected.code).toBe('CONFIRM_REQUIRED');

    const confirmed = await call(`/api/memories/${id}/transition`, {
      method: 'POST',
      body: JSON.stringify({ type: 'forget', confirm: true, reason: 'forget in test' }),
    });
    expect(confirmed.status).toBe(200);
    expect((confirmed.data as { memory: { status: string } }).memory.status).toBe('forgotten');

    const detail = await call(`/api/memories/${id}`);
    const audit = (detail.data as { audit: { eventType: string }[] }).audit;
    expect(audit.some((event) => event.eventType.includes('forget'))).toBe(true);
  });

  it('requires confirmation before rewriting an active memory and supersedes it afterwards', async () => {
    const memory = await createDraft();
    const id = memory.id as string;
    await call(`/api/memories/${id}/transition`, { method: 'POST', body: JSON.stringify({ type: 'activate' }) });

    const unconfirmed = await call(`/api/memories/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ title: 'Updated title', body: 'updated body' }),
    });
    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.code).toBe('CONFIRM_REQUIRED');

    const confirmed = await call(`/api/memories/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ title: 'Updated title', body: 'updated body', confirm: true, reason: 'rewrite in test' }),
    });
    expect(confirmed.status).toBe(200);
    const result = confirmed.data as { memory: { id: string; status: string }; superseded: string };
    expect(result.superseded).toBe(id);
    expect(result.memory.status).toBe('draft');
    expect(result.memory.id).not.toBe(id);
  });

  it('records feedback through governance and keeps the audit trail intact', async () => {
    const memory = await createDraft();
    const id = memory.id as string;
    const feedback = await call(`/api/memories/${id}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'useful', note: 'helpful in test' }),
    });
    expect(feedback.status).toBe(200);
    expect((feedback.data as { memory: { usefulCount: number } }).memory.usefulCount).toBeGreaterThan(0);
  });

  it('requires confirmation for reindex', async () => {
    const rejected = await call('/api/system/reindex', { method: 'POST', body: '{}' });
    expect(rejected.status).toBe(409);
    const confirmed = await call('/api/system/reindex', { method: 'POST', body: JSON.stringify({ confirm: true }) });
    expect(confirmed.status).toBe(200);
    expect(confirmed.data).toHaveProperty('report');
  });

  it('previews a context pack with decisions and writes context.build audit', async () => {
    const memory = await createDraft();
    const memoryId = memory.id as string;
    await call(`/api/memories/${memoryId}/transition`, { method: 'POST', body: JSON.stringify({ type: 'activate' }) });
    const preview = await call('/api/context/preview', {
      method: 'POST',
      body: JSON.stringify({ agentId: 'codex', task: 'sqlite concurrency', tokenBudget: 800 }),
    });
    expect(preview.status).toBe(200);
    const data = preview.data as { pack: { id: string; decisions: unknown[]; sections: unknown[] }; stats: { included: number }; trace: { packId: string } };
    expect(data.pack.id).toBeTruthy();
    expect(data.stats.included).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(data.pack.decisions)).toBe(true);
    expect(data.trace.packId).toBe(data.pack.id);
    const audit = await call('/api/audit');
    const events = (audit.data as { items: { eventType: string }[] }).items;
    expect(events.some((event) => event.eventType === 'context.build')).toBe(true);
  });

  it('degrades semantic search gracefully when no model is configured', async () => {
    await createDraft();
    const result = await call('/api/search?q=sqlite&semantic=on&includeDraft=true');
    expect(result.status).toBe(200);
    const data = result.data as { semanticMode: string; semanticAvailable: boolean; note: string };
    expect(data.semanticMode).toBe('on');
    expect(data.semanticAvailable).toBe(false);
    expect(data.note).toContain('降级');
  });

  it('exposes session observations and cursors', async () => {
    const result = await call('/api/sessions');
    expect(result.status).toBe(200);
    const data = result.data as { observations: unknown[]; sessionIds: unknown[]; cursors: unknown[] };
    expect(Array.isArray(data.observations)).toBe(true);
    expect(Array.isArray(data.sessionIds)).toBe(true);
    expect(Array.isArray(data.cursors)).toBe(true);
  });

  it('lists domain packs and records enable/disable in the audit trail', async () => {
    const list = await call('/api/packs');
    expect(list.status).toBe(200);
    const items = (list.data as { items: { id: string; enabled: boolean }[] }).items;
    expect(items.length).toBeGreaterThan(0);
    const first = items[0]!;
    const toggled = await call(`/api/packs/${first.id}/toggle`, {
      method: 'POST',
      body: JSON.stringify({ enabled: !first.enabled }),
    });
    expect(toggled.status).toBe(200);
    const audit = await call('/api/audit?eventType=pack');
    expect((audit.data as { items: unknown[] }).items.length).toBeGreaterThan(0);
  });

  it('returns related memories on detail', async () => {
    const memory = await createDraft();
    const detail = await call(`/api/memories/${memory.id as string}`);
    expect(detail.status).toBe(200);
    expect(Array.isArray((detail.data as { related: unknown[] }).related)).toBe(true);
  });

  it('retries failed jobs into a fresh queued job', async () => {
    const { DatabaseStore } = await import('../packages/storage/src/index.js');
    const database = new DatabaseStore(join(fixture.path, 'brain', 'taga.db'));
    database.enqueueJob({ id: 'job_retry_src', kind: 'test.retry', payload: '{}' });
    database.enqueueJob({ id: 'job_queued_src', kind: 'test.retry', payload: '{}' });
    const acquired = database.acquireJob('job_retry_src', 'worker-1', 1000);
    expect(acquired).not.toBeNull();
    database.failJob('job_retry_src', 'worker-1', 'boom', new Date(Date.now() + 60_000).toISOString());
    database.close();
    const rejected = await call('/api/jobs/job_queued_src/retry', { method: 'POST', body: '{}' });
    expect(rejected.status).toBe(409);
    const failed = await call('/api/jobs');
    const failedJobs = (failed.data as { items: { id: string; status: string }[] }).items.filter((job) => job.status === 'failed');
    expect(failedJobs.map((job) => job.id)).toContain('job_retry_src');
    const retried = await call('/api/jobs/job_retry_src/retry', { method: 'POST', body: '{}' });
    expect(retried.status).toBe(200);
    expect((retried.data as { nextId: string }).nextId).toBeTruthy();
  });

  it('requires confirmation for vector rebuild and records it', async () => {
    const rejected = await call('/api/system/vector-rebuild', { method: 'POST', body: '{}' });
    expect(rejected.status).toBe(409);
    const confirmed = await call('/api/system/vector-rebuild', { method: 'POST', body: JSON.stringify({ confirm: true }) });
    expect(confirmed.status).toBe(200);
    const audit = await call('/api/audit?eventType=maintenance');
    expect((audit.data as { items: unknown[] }).items.length).toBeGreaterThan(0);
  });

  it('paginates memory and audit listings with correct totals', async () => {
    await createDraft();
    await createDraft();
    await createDraft();
    const first = await call('/api/memories?limit=2&offset=0');
    const firstData = first.data as { items: unknown[]; total: number; offset: number };
    expect(firstData.items).toHaveLength(2);
    expect(firstData.total).toBe(3);
    expect(firstData.offset).toBe(0);
    const second = await call('/api/memories?limit=2&offset=2');
    expect((second.data as { items: unknown[] }).items).toHaveLength(1);
    const audit = await call('/api/audit?limit=2&offset=1');
    const auditData = audit.data as { items: unknown[]; total: number };
    expect(auditData.items.length).toBeLessThanOrEqual(2);
    expect(auditData.total).toBeGreaterThan(2);
  });

  it('ingests markdown knowledge as drafts and blocks sensitive content', async () => {
    const ingest = await call('/api/knowledge/ingest', {
      method: 'POST',
      body: JSON.stringify({
        type: 'lessons',
        text: '## 发布流程\n发布前执行 release:smoke。\n\n---\n\n## 路径归一化\nWindows 路径比较前先归一化分隔符。',
      }),
    });
    expect(ingest.status).toBe(200);
    const created = (ingest.data as { created: { id: string }[]; count: number });
    expect(created.count).toBe(2);
    const list = await call('/api/memories?status=draft&limit=50');
    expect((list.data as { items: { id: string }[] }).items.map((item) => item.id)).toEqual(expect.arrayContaining(created.created.map((item) => item.id)));

    const blocked = await call('/api/knowledge/ingest', {
      method: 'POST',
      body: JSON.stringify({ text: '## 泄密条目\nconst token = "sk-abcdefghijkl"' }),
    });
    expect(blocked.status).toBe(400);
    expect(blocked.code).toBe('SENSITIVE_BLOCKED');
  });

  it('injects a context pack into an agent instruction file with confirmation and audit', async () => {
    const { readFile } = await import('node:fs/promises');
    const targetPath = join(fixture.path, 'AGENTS.md');
    const rejected = await call('/api/context/inject', {
      method: 'POST',
      body: JSON.stringify({ targetPath, agentId: 'codex' }),
    });
    expect(rejected.status).toBe(409);
    const injected = await call('/api/context/inject', {
      method: 'POST',
      body: JSON.stringify({ confirm: true, targetPath, agentId: 'codex' }),
    });
    expect(injected.status, JSON.stringify(injected)).toBe(200);
    const written = await readFile(targetPath, 'utf8');
    expect(written).toContain('taga:instructions');
    const audit = await call('/api/audit?eventType=context.inject');
    expect((audit.data as { items: unknown[] }).items.length).toBeGreaterThan(0);
  });

  it('filters audit events by subject', async () => {
    const memory = await createDraft();
    const memoryId = memory.id as string;
    await call(`/api/memories/${memoryId}/feedback`, { method: 'POST', body: JSON.stringify({ kind: 'useful', note: 'x' }) });
    const scoped = await call(`/api/audit?subject=${memoryId}`);
    const items = (scoped.data as { items: { subjectId: string }[] }).items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.subjectId === memoryId)).toBe(true);
  });

  it('reports semantic model status on the system endpoint', async () => {
    const sys = await call('/api/system');
    const semantic = (sys.data as { semantic: { mode: string; modelPath: string | null; modelAvailable: boolean } }).semantic;
    expect(semantic.mode).toBe('off');
    expect(semantic.modelAvailable).toBe(false);
  });

  it('enriches garden proposals with memory content and llm verdict fields', async () => {
    const result = await call('/api/garden');
    expect(result.status).toBe(200);
    const proposals = (result.data as { proposals: Record<string, unknown>[] }).proposals;
    expect(Array.isArray(proposals)).toBe(true);
    for (const proposal of proposals) {
      expect(proposal.memories !== undefined || proposal.affectedIds !== undefined).toBe(true);
    }
  });

  it('manages knowledge candidates: create, accept into draft, and reject', async () => {
    const created = await call('/api/candidates', {
      method: 'POST',
      body: JSON.stringify({
        id: 'candidate-distill-test1',
        observationId: 'observation-test1',
        memoryType: 'lessons',
        title: '测试候选：构建脚本需显式执行策略',
        summary: 'PowerShell 环境下构建脚本需要显式设置执行策略。',
        body: 'PowerShell 环境下构建脚本需要显式设置执行策略，否则 CI 会失败。',
        scopeSuggestion: { kind: 'global' },
        worthLearning: true,
        evidenceIds: ['evidence-1'],
        facts: [{ text: '构建脚本依赖执行策略', evidenceIds: ['evidence-1'], confidence: 0.8 }],
      }),
    });
    expect(created.status, JSON.stringify(created)).toBe(200);
    const candidate = (created.data as { candidate: { id: string; decision: string } }).candidate;
    expect(candidate.id).toBe('candidate-distill-test1');
    expect(candidate.decision).toBe('pending');

    const list = await call('/api/candidates?decision=pending');
    expect((list.data as { items: { id: string }[] }).items.map((item) => item.id)).toContain('candidate-distill-test1');

    const accepted = await call('/api/candidates/candidate-distill-test1/accept', {
      method: 'POST',
      body: JSON.stringify({ reason: 'test accept' }),
    });
    expect(accepted.status).toBe(200);
    const memory = (accepted.data as { memory: { id: string; status: string } }).memory;
    expect(memory.status).toBe('draft');
    const detail = await call(`/api/memories/${memory.id}`);
    expect(detail.status).toBe(200);

    const again = await call('/api/candidates/candidate-distill-test1/accept', { method: 'POST', body: '{}' });
    expect(again.status).toBe(409);

    await call('/api/candidates', {
      method: 'POST',
      body: JSON.stringify({
        id: 'candidate-reflect-test2',
        observationId: 'observation-test2',
        memoryType: 'lessons',
        title: '测试洞见',
        summary: '一组记忆指向同一规律。',
        body: '一组记忆指向同一规律。',
        scopeSuggestion: { kind: 'global' },
        worthLearning: false,
        evidenceIds: ['evidence-2'],
      }),
    });
    const rejected = await call('/api/candidates/candidate-reflect-test2/reject', { method: 'POST', body: '{}' });
    expect(rejected.status).toBe(200);
    expect((rejected.data as { candidate: { decision: string } }).candidate.decision).toBe('rejected');
  });

  it('lists memories with filters and returns overview counters', async () => {
    await createDraft();
    const list = await call('/api/memories?status=draft');
    expect((list.data as { items: unknown[] }).items).toHaveLength(1);
    const overview = await call('/api/overview');
    const data = overview.data as { reviewBacklogCount: number; index: { memories: number } };
    expect(data.reviewBacklogCount).toBe(1);
    expect(data.index.memories).toBe(1);
  });

  it('serves the frontend ES module graph with javascript MIME', async () => {
    const modules = ['app.js'];
    const walk = (dir: string, prefix: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}/`);
        else if (entry.name.endsWith('.js')) modules.push(`${prefix}${entry.name}`);
      }
    };
    walk(join(process.cwd(), 'apps', 'web', 'public', 'js'), 'js/');
    expect(modules.length).toBeGreaterThan(1);
    for (const file of modules) {
      const response = await fetch(`${base}/${file}`);
      expect(response.status, file).toBe(200);
      expect(response.headers.get('content-type') ?? '', file).toContain('javascript');
      expect((await response.text()).length, file).toBeGreaterThan(0);
    }
    const index = await (await fetch(`${base}/`)).text();
    expect(index).toContain('<script type="module" src="/app.js"></script>');
  });
});
