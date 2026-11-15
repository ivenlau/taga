import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { LiteMcpServer, type McpResponse } from '../apps/mcp/src/index.js';
import { contentHash, writeMarkdownDocument } from '../packages/storage/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';
import type { Memory } from '../packages/domain/src/index.js';

async function call(server: LiteMcpServer, request: unknown): Promise<McpResponse> {
  const response = await server.handle(request);
  if (response === null) throw new Error('unexpected notification response');
  return response;
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
