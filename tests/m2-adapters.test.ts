import Database from 'better-sqlite3';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AgentAdapterRegistry,
  ClaudeCodeAgentAdapter,
  CodexAgentAdapter,
  isMcpServerRegistered,
  mcpRegistrationGuide,
  OpenCodeAgentAdapter,
  OpenCodeSqliteSourceAdapter,
  PiAgentAdapter,
} from '../packages/adapters/src/index.js';
import { AgentAcceptanceService, AgentIngestionService } from '../apps/daemon/src/index.js';
import { DatabaseStore, markerBegin, markerEnd } from '../packages/storage/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';

const timestamp = '2026-11-11T00:00:00.000Z';

describe('M2 real agent adapters', () => {
  it('detects pi, Claude Code, Codex, and OpenCode with versioned capabilities and real source layouts', async () => {
    const fixture = await createTemporaryDirectory();
    const piPath = join(fixture.path, 'pi.jsonl');
    const claudePath = join(fixture.path, 'claude.jsonl');
    const codexPath = join(fixture.path, 'codex.jsonl');
    const openCodePath = join(fixture.path, 'opencode.db');
    await writeFile(piPath, `{"type":"session","version":3,"timestamp":"${timestamp}"}\n`, 'utf8');
    await writeFile(claudePath, `{"type":"user","timestamp":"${timestamp}"}\n`, 'utf8');
    await writeFile(codexPath, `{"type":"session_meta","timestamp":"${timestamp}","payload":{}}\n`, 'utf8');
    createOpenCodeDatabase(openCodePath);

    const registry = new AgentAdapterRegistry([
      new PiAgentAdapter({ commandPath: 'pi', version: '1.5.0', sourcePaths: [piPath] }),
      new ClaudeCodeAgentAdapter({ commandPath: 'claude', version: '2.1.278', sourcePaths: [claudePath] }),
      new CodexAgentAdapter({ commandPath: 'codex', version: '0.166.0', sourcePaths: [codexPath] }),
      new OpenCodeAgentAdapter({ commandPath: 'opencode', version: '1.19.5', databasePath: openCodePath }),
    ]);
    const detections = await registry.detect();
    expect(detections.map((detection) => detection.id)).toEqual(['pi', 'claude-code', 'codex', 'opencode']);
    expect(detections.every((detection) => detection.available && detection.installed)).toBe(true);
    expect(detections.every((detection) => detection.version !== undefined && detection.parserVersion.length > 0)).toBe(true);
    expect(detections.find((detection) => detection.id === 'opencode')?.capabilities.source).toBe('sqlite');
    expect(registry.get('claude')?.id).toBe('claude-code');
    await fixture.cleanup();
  });

  it('ingests incrementally, advances past malformed records, and never persists secret originals', async () => {
    const fixture = await createTemporaryDirectory();
    const sourcePath = join(fixture.path, 'pi.jsonl');
    await writeFile(sourcePath, `{"type":"message","text":"safe"}\n{"type":"message","text":"password=top-secret"}\nnot-json\n`, 'utf8');
    const database = new DatabaseStore(join(fixture.path, 'taga.db'));
    const registry = new AgentAdapterRegistry([new PiAgentAdapter({ commandPath: null, sourcePaths: [sourcePath] })]);
    const ingestion = new AgentIngestionService(database, registry, { clock: () => new Date(timestamp) });
    const first = await ingestion.runOnce(['pi']);
    const second = await ingestion.runOnce(['pi']);
    expect(first.captured).toBe(2);
    expect(first.errors.map((error) => error.reason)).toContain('malformed_jsonl_record');
    expect(second.captured).toBe(0);
    expect(JSON.stringify(database.listEvidence())).not.toContain('top-secret');
    expect(database.listEvidence().some((event) => event.sensitivity === 'redacted')).toBe(true);
    database.close();
    await fixture.cleanup();
  });

  it('uses OpenCode rowid cursors without reading credential tables', async () => {
    const fixture = await createTemporaryDirectory();
    const databasePath = join(fixture.path, 'opencode.db');
    createOpenCodeDatabase(databasePath);
    const source = new OpenCodeSqliteSourceAdapter(databasePath, () => new Date(timestamp));
    const records = [];
    for await (const record of source.readSince({ offset: 0, sourceVersion: source.parserVersion })) records.push(record);
    expect(records).toHaveLength(1);
    expect(records[0]?.raw).toContain('session-1');
    const resumed = [];
    for await (const record of source.readSince(source.checkpoint(records[0]!))) resumed.push(record);
    expect(resumed).toHaveLength(0);
    await fixture.cleanup();
  });

  it('completes governed Evidence, review, active Memory, and recall for all four adapters', async () => {
    const fixture = await createTemporaryDirectory();
    const brainPath = join(fixture.path, 'brain');
    await mkdir(brainPath, { recursive: true });
    const piPath = join(fixture.path, 'pi.jsonl');
    const claudePath = join(fixture.path, 'claude.jsonl');
    const codexPath = join(fixture.path, 'codex.jsonl');
    const openCodePath = join(fixture.path, 'opencode.db');
    await writeFile(piPath, `{"type":"session","version":3,"timestamp":"${timestamp}"}\n`, 'utf8');
    await writeFile(claudePath, `{"type":"user","timestamp":"${timestamp}"}\n`, 'utf8');
    await writeFile(codexPath, `{"type":"session_meta","timestamp":"${timestamp}","payload":{}}\n`, 'utf8');
    createOpenCodeDatabase(openCodePath);
    const registry = new AgentAdapterRegistry([
      new PiAgentAdapter({ commandPath: 'pi', version: '1.5.0', sourcePaths: [piPath] }),
      new ClaudeCodeAgentAdapter({ commandPath: 'claude', version: '2.1.278', sourcePaths: [claudePath] }),
      new CodexAgentAdapter({ commandPath: 'codex', version: '0.166.0', sourcePaths: [codexPath] }),
      new OpenCodeAgentAdapter({ commandPath: 'opencode', version: '1.19.5', databasePath: openCodePath }),
    ]);
    const service = new AgentAcceptanceService(registry, () => new Date(timestamp));
    for (const agentId of ['pi', 'claude-code', 'codex', 'opencode']) {
      const report = await service.verify({ agentId, brainPath, projectId: 'project-m2', confirmed: true });
      expect(report.recalled).toBe(true);
    }
    const target = join(fixture.path, 'AGENTS.md');
    await writeFile(target, `before\n${markerBegin}\n${markerEnd}\nafter\n`, 'utf8');
    expect(await import('node:fs/promises').then(({ readFile }) => readFile(target, 'utf8'))).toContain('before');
    await fixture.cleanup();
  }, 15000);
});

function createOpenCodeDatabase(path: string): void {
  const database = new Database(path);
  database.exec(`
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL,
      seq INTEGER NOT NULL
    );
  `);
  database.prepare('INSERT INTO session_message (id, session_id, type, time_created, time_updated, data, seq) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('message-1', 'session-1', 'user', Date.parse(timestamp), Date.parse(timestamp), JSON.stringify({ role: 'user', text: 'verified opencode session' }), 1);
  database.close();
}

describe('MCP registration guide', () => {
  it('points Claude Code and Codex at their config files with the exact registration', () => {
    const claude = mcpRegistrationGuide('claude-code', '/work/app', { ...process.env, CLAUDE_CONFIG_DIR: '/home/u/.claude' });
    expect(claude.configPaths).toEqual(['/work/app/.mcp.json', '/home/u/.claude/.claude.json']);
    expect(claude.supportsMcpJson).toBe(true);
    expect(claude.howto).toContain('claude mcp add');

    const codex = mcpRegistrationGuide('codex', '/work/app', { ...process.env, CODEX_HOME: '/home/u/.codex' });
    expect(codex.configPaths).toEqual(['/home/u/.codex/config.toml']);
    expect(codex.supportsMcpJson).toBe(false);
    expect(codex.howto).toContain('[mcp_servers.taga]');

    const pi = mcpRegistrationGuide('pi', '/work/app');
    expect(pi.configPaths).toEqual([]);
    expect(pi.supportsMcpJson).toBe(false);
    expect(pi.howto).toContain('taga-mcp');

    const opencode = mcpRegistrationGuide('opencode', '/work/app', { ...process.env, XDG_CONFIG_HOME: '/home/u/.config' });
    expect(opencode.configPaths).toEqual(['/work/app/opencode.json', '/home/u/.config/opencode/opencode.json']);
    expect(opencode.howto).toContain('opencode mcp add taga');
  });

  it('detects an existing taga server in JSON and TOML configs', async () => {
    const fixture = await createTemporaryDirectory();
    const project = join(fixture.path, 'app');
    await mkdir(project, { recursive: true });
    try {
      const claude = mcpRegistrationGuide('claude-code', project, { ...process.env, CLAUDE_CONFIG_DIR: join(fixture.path, 'claude') });
      expect(await isMcpServerRegistered(claude, project)).toBe(false);

      const mcpJson = join(project, '.mcp.json');
      await writeFile(mcpJson, JSON.stringify({ mcpServers: { other: { command: 'other' } } }), 'utf8');
      expect(await isMcpServerRegistered(claude, project)).toBe(false);
      await writeFile(mcpJson, JSON.stringify({ mcpServers: { taga: { type: 'stdio', command: 'taga-mcp' } } }), 'utf8');
      expect(await isMcpServerRegistered(claude, project)).toBe(true);

      // A user-scope registration counts as well, whatever the entry is called.
      await writeFile(mcpJson, '{}', 'utf8');
      await mkdir(join(fixture.path, 'claude'), { recursive: true });
      await writeFile(join(fixture.path, 'claude', '.claude.json'), JSON.stringify({ projects: { [project]: { mcpServers: { memory: { command: 'C:\\tools\\taga-mcp.cmd' } } } } }), 'utf8');
      expect(await isMcpServerRegistered(claude, project)).toBe(true);

      // OpenCode's own `mcp add` writes mcp.servers with an argv-style command; both count as registered.
      const opencode = mcpRegistrationGuide('opencode', project, { ...process.env, XDG_CONFIG_HOME: join(fixture.path, 'xdg') });
      const opencodeConfig = join(project, 'opencode.json');
      await writeFile(opencodeConfig, JSON.stringify({ $schema: 'x', mcp: { servers: { taga: { type: 'local', command: ['taga-mcp'] } } } }), 'utf8');
      expect(await isMcpServerRegistered(opencode, project)).toBe(true);
      await writeFile(opencodeConfig, JSON.stringify({ mcp: { servers: { other: { type: 'local', command: ['other'] } } } }), 'utf8');
      expect(await isMcpServerRegistered(opencode, project)).toBe(false);

      const codex = mcpRegistrationGuide('codex', project, { ...process.env, CODEX_HOME: join(fixture.path, 'codex') });
      expect(await isMcpServerRegistered(codex, project)).toBe(false);
      await mkdir(join(fixture.path, 'codex'), { recursive: true });
      const configToml = join(fixture.path, 'codex', 'config.toml');
      await writeFile(configToml, 'model = "x"\n\n[mcp_servers.other]\ncommand = "other"\n', 'utf8');
      expect(await isMcpServerRegistered(codex, project)).toBe(false);
      await writeFile(configToml, 'model = "x"\n\n[mcp_servers.taga]\ncommand = "taga-mcp"\n', 'utf8');
      expect(await isMcpServerRegistered(codex, project)).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });
});
