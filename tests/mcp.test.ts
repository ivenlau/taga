import { describe, expect, it } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { LiteMcpServer, type McpResponse } from '../apps/mcp/src/index.js';
import { createDefaultConfig } from '../packages/config/src/index.js';
import { FtsRetrievalProvider } from '../packages/retrieval/src/index.js';
import { contentHash, DatabaseStore, writeMarkdownDocument } from '../packages/storage/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';
import type { Memory } from '../packages/domain/src/index.js';

async function call(server: LiteMcpServer, request: unknown): Promise<McpResponse> {
  const response = await server.handle(request);
  if (response === null) throw new Error('unexpected notification response');
  return response;
}

interface Envelope {
  ok: boolean;
  data: Record<string, unknown>;
  degraded: boolean;
  warnings: readonly string[];
  next_actions: ReadonlyArray<Record<string, unknown>>;
  error?: { code: string; message: string; hint?: string };
}

function toolResult(response: McpResponse): { isError: boolean; payload: Envelope } {
  const result = response.result as { isError?: boolean; structuredContent: Envelope };
  return { isError: result.isError === true, payload: result.structuredContent };
}

/** Active memories written to Markdown and indexed for lexical recall, without a daemon or a CLI round trip. */
async function seed(brain: string, items: ReadonlyArray<{ readonly memory: Memory; readonly body: string }>): Promise<void> {
  const database = new DatabaseStore(join(brain, 'taga.db'));
  try {
    const provider = new FtsRetrievalProvider(database);
    for (const item of items) {
      await writeMarkdownDocument(join(brain, item.memory.type, 'global', `${item.memory.id}.md`), item.memory, item.body);
      provider.upsert(item.memory, item.body);
    }
  } finally {
    database.close();
  }
}

function semanticConfigured(brain: string): ReturnType<typeof createDefaultConfig> {
  const base = createDefaultConfig(process.cwd(), brain);
  // No daemon holds the model in tests, so semantic retrieval is configured but cannot take part.
  return { ...base, retrieval: { ...base.retrieval, semantic: { ...base.retrieval.semantic, mode: 'on', modelPath: '/nonexistent/bge-m3' } } };
}

function memory(): Memory {
  return {
    schemaVersion: 1,
    id: 'mem-mcp',
    type: 'lessons',
    scope: { kind: 'global' },
    projectId: null,
    status: 'active',
    title: 'Use bounded retries',
    summary: 'Retry transient failures with a bounded delay.',
    confidence: 0.9,
    sourceTrust: 'user_authored',
    visibility: 'private',
    created: '2026-11-10T00:00:00.000Z',
    updated: '2026-11-10T00:00:00.000Z',
    lastVerified: null,
    lastRecalled: null,
    reviewCount: 0,
    usefulCount: 0,
    notUsefulCount: 0,
    expiresAt: null,
    contentHash: contentHash('retry body'),
    sources: [{ kind: 'test', locator: 'mcp.test.ts' }],
    anchors: [],
    tags: ['retry'],
    supersedes: null,
  };
}

describe('Lite MCP contract', () => {
  it('supports search and keeps memory body opt-in', async () => {
    const fixture = await createTemporaryDirectory();
    const item = memory();
    await writeMarkdownDocument(join(fixture.path, 'lessons', 'global', `${item.id}.md`), item, 'retry body');
    const server = new LiteMcpServer(fixture.path);
    const search = await call(server, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'retry' } } });
    expect(search.error).toBeUndefined();
    const get = await call(server, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_get', arguments: { memory_id: item.id } } });
    expect(JSON.stringify(get.result)).not.toContain('retry body');
    const browse = await call(server, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'brain_list', arguments: { type: 'lessons' } } });
    expect(JSON.stringify(browse.result)).toContain('mem-mcp');
    const summary = await call(server, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'brain_summary', arguments: {} } });
    expect(JSON.stringify(summary.result)).toContain('byType');
    await fixture.cleanup();
  }, 20_000);

  it('exposes context traces and durable timeline/get details', async () => {
    const fixture = await createTemporaryDirectory();
    const server = new LiteMcpServer(fixture.path);
    const listed = await call(server, { jsonrpc: '2.0', id: 0, method: 'tools/list' });
    expect(JSON.stringify(listed.result)).toContain('context_trace');
    const record = await call(server, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_record', arguments: {
      type: 'lessons', scope: 'global', title: 'Timeline lesson', body: 'Keep retries bounded.', requested_status: 'draft', actor: 'agent', sources: [{ kind: 'test', locator: 'fixture' }],
    } } });
    const memoryId = (record.result as { structuredContent: { data: { candidate_id: string } } }).structuredContent.data.candidate_id;
    const timeline = await call(server, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_timeline', arguments: { memory_id: memoryId } } });
    expect(JSON.stringify(timeline.result)).toContain('memory.created');
    const detail = await call(server, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory_get', arguments: { memory_id: memoryId, include_evidence: true, include_audit: true, include_versions: true } } });
    const detailText = JSON.stringify(detail.result);
    expect(detailText).toContain('evidence');
    expect(detailText).toContain('audit');
    expect(detailText).toContain('versions');
    const trace = await call(server, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'context_trace', arguments: { agent_id: 'agent-a' } } });
    expect(JSON.stringify(trace.result)).toContain('decisions');
    await fixture.cleanup();
  });

  it('forces agent active records down to draft and records feedback', async () => {
    const fixture = await createTemporaryDirectory();
    const server = new LiteMcpServer(fixture.path);
    const record = await call(server, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_record', arguments: {
      type: 'lessons', scope: 'global', title: 'Observed rule', body: 'Keep retries bounded.', requested_status: 'active', actor: 'agent', sources: [{ kind: 'test', locator: 'fixture' }],
    } } });
    const result = record.result as { structuredContent: { data: { candidate_id: string; status: string } } };
    const data = result.structuredContent.data;
    expect(data.status).toBe('draft');
    const feedback = await call(server, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_feedback', arguments: { memory_id: data.candidate_id, kind: 'useful' } } });
    expect(feedback.error).toBeUndefined();
    await fixture.cleanup();
  });
});

describe('MCP agent-facing contract', () => {
  it('describes every parameter, annotates every tool, and follows the retrieval mode', async () => {
    const fixture = await createTemporaryDirectory();
    const server = new LiteMcpServer(fixture.path);
    const listed = await call(server, { jsonrpc: '2.0', id: 0, method: 'tools/list' });
    interface ListedTool {
      readonly name: string;
      readonly title: string;
      readonly description: string;
      readonly annotations: { readOnlyHint?: boolean };
      readonly inputSchema: { properties?: Record<string, { description?: string }> };
    }
    const tools = (listed.result as { tools: readonly ListedTool[] }).tools;
    expect(tools).toHaveLength(15);
    for (const tool of tools) {
      expect(tool.title.length, tool.name).toBeGreaterThan(0);
      expect(tool.annotations, tool.name).toBeDefined();
      for (const [key, property] of Object.entries(tool.inputSchema.properties ?? {})) {
        expect(property.description, `${tool.name}.${key}`).toBeDefined();
      }
    }
    expect(tools.find((tool) => tool.name === 'memory_search')?.annotations.readOnlyHint).toBe(true);
    expect(tools.find((tool) => tool.name === 'memory_record')?.annotations.readOnlyHint).toBeUndefined();
    expect(tools.find((tool) => tool.name === 'memory_search')?.description).toContain('lexical only');

    const hybrid = new LiteMcpServer(fixture.path, () => new Date(), semanticConfigured(fixture.path));
    try {
      const hybridListed = await call(hybrid, { jsonrpc: '2.0', id: 0, method: 'tools/list' });
      const description = (hybridListed.result as { tools: readonly ListedTool[] }).tools.find((tool) => tool.name === 'memory_search')?.description;
      expect(description).toContain('Hybrid retrieval is enabled');
      expect(description).toContain('natural-language sentence');
    } finally {
      hybrid.close();
    }
    await fixture.cleanup();
  }, 20_000);

  it('returns the start of each body with search hits and follows up only on cut-off results', async () => {
    const fixture = await createTemporaryDirectory();
    const short = memory();
    const long: Memory = { ...memory(), id: 'mem-long', title: 'Long retry runbook', summary: 'A long runbook.' };
    await seed(fixture.path, [{ memory: short, body: 'retry body' }, { memory: long, body: 'retry body '.repeat(60) }]);
    const server = new LiteMcpServer(fixture.path);
    const { isError, payload } = toolResult(await call(server, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'retry' } } }));
    expect(isError).toBe(false);
    expect(payload.data.retrieval).toBe('lexical (FTS5)');
    expect(payload.data.scope).toBe('global, domain');
    const results = payload.data.results as Array<Record<string, unknown>>;
    expect(results.find((result) => result.id === 'mem-mcp')?.body).toBe('retry body');
    expect(results.find((result) => result.id === 'mem-mcp')?.summary).toBe('Retry transient failures with a bounded delay.');
    const cutOff = results.find((result) => result.id === 'mem-long');
    expect(cutOff?.body_truncated).toBe(true);
    expect((cutOff?.body as string).length).toBeLessThan(720);
    for (const result of results) expect(result.suggested_action).toBeUndefined();
    // A timeline holds audit events, not the body, so it is never the suggested follow-up.
    expect(payload.next_actions).toEqual([{ tool: 'memory_get', memory_id: 'mem-long', include_body: true }]);
    await fixture.cleanup();
  }, 20_000);

  it('explains an empty search that had no project context', async () => {
    const fixture = await createTemporaryDirectory();
    await seed(fixture.path, [{ memory: memory(), body: 'retry body' }]);
    const server = new LiteMcpServer(fixture.path);
    const { payload } = toolResult(await call(server, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'quantum zebra' } } }));
    expect(payload.data.results).toEqual([]);
    expect(payload.data.hint).toContain('include_draft=true');
    expect(payload.warnings).toContain('no project context: only global and domain memories were searched; call memory_session_start or pass project_id to include project memories');
    const found = toolResult(await call(server, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'retry' } } }));
    expect(found.payload.warnings).toEqual([]);
    expect(found.payload.data.hint).toBeUndefined();
    await fixture.cleanup();
  }, 20_000);

  it('reports failures as tool results that say how to recover', async () => {
    const fixture = await createTemporaryDirectory();
    const server = new LiteMcpServer(fixture.path);
    const unbound = toolResult(await call(server, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'retry', session_id: 'never-started' } } }));
    expect(unbound.isError).toBe(true);
    expect(unbound.payload.ok).toBe(false);
    expect(unbound.payload.error?.code).toBe('UNKNOWN_SESSION');
    expect(unbound.payload.error?.hint).toContain('memory_session_start');

    const missing = toolResult(await call(server, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_get', arguments: { memory_id: 'mem-nope' } } }));
    expect(missing.payload.error?.code).toBe('NOT_FOUND');

    const invalid = toolResult(await call(server, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory_precheck', arguments: {} } }));
    expect(invalid.payload.error?.code).toBe('INVALID_ARGUMENTS');
    expect(invalid.payload.error?.message).toContain('file, symbol, or commit is required');

    const malformed = toolResult(await call(server, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'memory_record', arguments: { type: 'lessons', title: 'x', body: 'y', sources: [] } } }));
    expect(malformed.payload.error?.message).toContain('sources:');
    // An unknown tool is a protocol problem, not a tool failure.
    const unknown = await call(server, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'memory_teleport', arguments: {} } });
    expect(unknown.error?.code).toBe(-32602);
    await fixture.cleanup();
  }, 20_000);

  it('records drafts by default and says what is not active yet', async () => {
    const fixture = await createTemporaryDirectory();
    const server = new LiteMcpServer(fixture.path);
    const base = { type: 'lessons', title: 'Observed rule', body: 'Keep retries bounded.', sources: [{ kind: 'test', locator: 'fixture' }] };
    const byDefault = toolResult(await call(server, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_record', arguments: base } }));
    expect(byDefault.payload.data.status).toBe('draft');
    expect(byDefault.payload.data.hint).toContain('taga review');
    expect(byDefault.payload.next_actions).toEqual([]);
    expect(byDefault.payload.warnings).toEqual([]);

    const forced = toolResult(await call(server, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_record', arguments: { ...base, requested_status: 'active' } } }));
    expect(forced.payload.data.status).toBe('draft');
    expect(forced.payload.warnings).toEqual(["'active' is not available through memory_record; recorded as draft for review"]);

    const feedback = toolResult(await call(server, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory_feedback', arguments: { memory_id: byDefault.payload.data.memory_id, kind: 'useful' } } }));
    expect(feedback.payload.data.status).toBe('draft');
    expect(feedback.payload.data.useful_count).toBe(1);
    expect(feedback.payload.data.hint).toContain('not recalled yet');
    await fixture.cleanup();
  }, 20_000);

  it('flags a lexical-only context pack when semantic retrieval is configured but unavailable', async () => {
    const fixture = await createTemporaryDirectory();
    const brain = join(fixture.path, 'brain');
    await mkdir(brain, { recursive: true });
    await seed(brain, [{ memory: memory(), body: 'retry body' }]);
    const server = new LiteMcpServer(brain, () => new Date(), semanticConfigured(brain));
    try {
      const { payload } = toolResult(await call(server, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_session_start', arguments: { session_id: 's1', cwd: fixture.path, task: 'retry the request' } } }));
      expect(payload.degraded).toBe(true);
      expect(payload.warnings).toContain('semantic retrieval unavailable; the context pack was selected by lexical search only');
      expect(payload.data.source).toBe('fts5');
      // Sections list what `content` already rendered, so the text itself is not sent twice.
      const sections = payload.data.sections as Array<{ kind: string; title: string; memory_ids: readonly string[]; token_estimate: number }>;
      expect(sections).toHaveLength(1);
      expect(sections[0]).toMatchObject({ kind: 'lessons', title: 'Lessons', memory_ids: ['mem-mcp'] });
      expect(typeof sections[0]?.token_estimate).toBe('number');
      expect(payload.next_actions).toEqual([]);

      const { payload: search } = toolResult(await call(server, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'retry', session_id: 's1' } } }));
      expect(search.degraded).toBe(true);
      expect(search.data.retrieval).toBe('lexical (FTS5)');
      expect(search.warnings).toContain('semantic retrieval degraded; FTS5 results returned');
    } finally {
      server.close();
    }
    await fixture.cleanup();
  }, 20_000);

  it('warns when knowledge_ingest is queued without a running daemon', async () => {
    const fixture = await createTemporaryDirectory();
    const server = new LiteMcpServer(fixture.path);
    const { payload } = toolResult(await call(server, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'knowledge_ingest', arguments: { content: 'Run the tests before deploying.' } } }));
    expect(payload.data.queued).toBe(true);
    expect(payload.warnings).toEqual(['taga daemon is not running; run `taga daemon start` so queued jobs are processed']);
    expect(payload.next_actions).toEqual([]);
    await fixture.cleanup();
  }, 20_000);

  it('explains an uninitialized Brain instead of failing with a database error', async () => {
    const fixture = await createTemporaryDirectory();
    const server = new LiteMcpServer(join(fixture.path, 'missing'));
    const { isError, payload } = toolResult(await call(server, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'retry' } } }));
    expect(isError).toBe(true);
    expect(payload.error?.code).toBe('BRAIN_UNAVAILABLE');
    expect(payload.error?.hint).toContain('taga init');
    await fixture.cleanup();
  }, 20_000);
});
