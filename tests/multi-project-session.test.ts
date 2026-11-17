import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LiteMcpServer, type McpResponse } from '../apps/mcp/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';

async function call(server: LiteMcpServer, id: number, name: string, args: Record<string, unknown>): Promise<McpResponse> {
  const response = await server.handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  if (response === null) throw new Error('unexpected notification response');
  return response;
}

function data<T>(response: McpResponse): T {
  return (response.result as { structuredContent: T }).structuredContent;
}

describe('multi-project MCP sessions', () => {
  it('binds projects to sessions and prevents cross-project recall', async () => {
    const fixture = await createTemporaryDirectory();
    const projectA = join(fixture.path, 'project-a');
    const projectB = join(fixture.path, 'project-b');
    const brain = join(fixture.path, 'brain');
    await mkdir(brain, { recursive: true });
    const server = new LiteMcpServer(brain);

    const startA = data<{ data: { project_id: string } }>(await call(server, 1, 'memory_session_start', { session_id: 'a', cwd: projectA }));
    const startB = data<{ data: { project_id: string } }>(await call(server, 2, 'memory_session_start', { session_id: 'b', cwd: projectB }));
    expect(startA.data.project_id).not.toBe(startB.data.project_id);

    await call(server, 3, 'memory_record', { session_id: 'a', type: 'lessons', scope: 'auto', title: 'Project A retry', body: 'Use project A bounded retry policy.', requested_status: 'active', actor: 'user', sources: [{ kind: 'test', locator: 'project-a' }] });
    await call(server, 4, 'memory_record', { type: 'lessons', scope: 'global', title: 'Global retry', body: 'Use global bounded retry policy.', requested_status: 'active', actor: 'user', sources: [{ kind: 'test', locator: 'global' }] });

    const globalSearch = JSON.stringify(data(await call(server, 5, 'memory_search', { query: 'retry', include_draft: true })));
    expect(globalSearch).toContain('Global retry');
    expect(globalSearch).not.toContain('Project A retry');

    const searchA = JSON.stringify(data(await call(server, 6, 'memory_search', { session_id: 'a', query: 'retry', include_draft: true })));
    expect(searchA).toContain('Project A retry');
    expect(searchA).toContain('Global retry');

    const searchB = JSON.stringify(data(await call(server, 7, 'memory_search', { session_id: 'b', query: 'retry', include_draft: true })));
    expect(searchB).not.toContain('Project A retry');
    expect(searchB).toContain('Global retry');

    const conflict = await call(server, 8, 'memory_search', { session_id: 'a', project_id: startB.data.project_id, query: 'retry' });
    expect(conflict.error?.message).toContain('conflicts with session project');
    server.close();
    await fixture.cleanup();
  }, 20_000);
});
