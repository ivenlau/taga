import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';

const execFileAsync = promisify(execFile);

export const DEFAULT_AGENT_INSTRUCTIONS = [
  '## Taga 长期记忆（taga-mcp）',
  '',
  '本会话接入了 Taga 本地记忆库（MCP 服务器 `taga`，工具以 `memory_` / `brain_` / `context_` 开头）。**仅当本会话实际能调用这些工具时**才执行以下约定，否则忽略本节。参数细节见各工具说明。',
  '',
  '1. **开始任务**：调用 `memory_session_start`，传入当前工作目录 `cwd` 和一句话 `task`（用户这次要做什么，它是召回的检索词）。`session_id` 自拟一个唯一值（如 `日期-项目-随机后缀`），之后的调用沿用。',
  '2. **需要过去的经验时先查**：`memory_search` 的 `query` 先写一句自然描述；零结果或只有词法结果时，换成空格分隔的关键词、原文里的标识符（命令、错误码、路径）或 `alternates`（最多 6 个同义或中英变体）。换 2 种写法仍无结果，才可以说"没有记录"。一次性的小改动不必查。修改文件或符号之前，先用 `memory_precheck` 传入 `file` / `symbol`，优先看 `anchor_state` 为 valid 的条目。',
  '3. **产生可复用的经验时记**：先 `memory_search` 确认没有相近记忆，再调用 `memory_record`（`requested_status` 传 `"draft"`，`actor` 传 `"agent"`，传当前 `session_id`，`scope` 用 `"auto"`）；已有相近记忆就改用 `memory_feedback`（kind=conflict 或 not_useful）。`title` 写成自包含的一句话，`body` 带具体标识符，`sources` 至少一条；涉及具体文件或符号时给出 `anchors`（`memory_precheck` 靠它召回）。类型在 `preferences`（偏好）、`environment`（环境）、`procedures`（步骤）、`lessons`（踩坑，拿不准选它）、`projects`（决策）中选。',
  '4. **宁缺毋滥**：只记可复用的事实，不记一次性细节、中间过程和猜测；机密信息一律不进记忆。新记忆是 draft，经 `taga review` 审核后才进入召回，对用户说"已记录待审核"。用户口述的大段材料改用 `knowledge_ingest` 入队蒸馏。',
  '5. **任务收尾时反馈**：对确实帮到你的记忆调用 `memory_feedback`（kind=useful），过时或有误的用 conflict 或 not_useful。工具返回 `warnings` 或 `degraded` 时如实转达用户。',
].join('\n');

export const MCP_SERVER_NAME = 'taga';
export const MCP_SERVER_COMMAND = 'taga-mcp';

/** Where an agent reads its stdio MCP server configuration, and how to register taga-mcp there. */
export interface McpRegistrationGuide {
  readonly agentId: string;
  /** Config files that can hold a stdio MCP server entry, best effort. */
  readonly configPaths: readonly string[];
  /** The agent reads the project-root `.mcp.json` standard. */
  readonly supportsMcpJson: boolean;
  readonly howto: string;
}

const GENERIC_MCP_HOWTO: Readonly<Record<string, string>> = {
  pi: 'Pi: add a stdio MCP server named "taga" running the command "taga-mcp" (see the Pi MCP documentation for the config location).',
  opencode: 'OpenCode: run `opencode mcp add taga -- taga-mcp` (add --global for every project), or add a local MCP server named "taga" with command ["taga-mcp"] to opencode.json.',
  cursor: 'Cursor: add a stdio server named "taga" with command "taga-mcp" to .cursor/mcp.json.',
  windsurf: 'Windsurf: add a stdio server named "taga" with command "taga-mcp" to your mcp_config.json.',
  cline: 'Cline: add a stdio MCP server named "taga" with command "taga-mcp" in the Cline MCP settings.',
  roo: 'Roo Code: add a stdio MCP server named "taga" with command "taga-mcp" in the Roo Code MCP settings.',
  local: 'Add a stdio MCP server named "taga" with command "taga-mcp" to your agent\'s MCP configuration.',
};

export function mcpRegistrationGuide(agentId: string, projectRoot: string, env: NodeJS.ProcessEnv = process.env): McpRegistrationGuide {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  if (agentId === 'claude-code') {
    const claudeHome = env.CLAUDE_CONFIG_DIR ?? env.CLAUDE_HOME ?? join(home, '.claude');
    return {
      agentId,
      configPaths: [join(projectRoot, '.mcp.json'), join(claudeHome, '.claude.json')],
      supportsMcpJson: true,
      howto: 'Claude Code: run `claude mcp add --scope user taga -- taga-mcp`, or rerun with --register-mcp to write .mcp.json for this project (Claude Code asks once before loading it).',
    };
  }
  if (agentId === 'codex') {
    // On Windows the npm shim is a .cmd file, which the Codex process can only start through cmd.
    const windows = process.platform === 'win32';
    return {
      agentId,
      configPaths: [join(env.CODEX_HOME ?? join(home, '.codex'), 'config.toml')],
      supportsMcpJson: false,
      howto: [
        'Codex: run `codex mcp add taga -- taga-mcp`, or add to config.toml:',
        '  [mcp_servers.taga]',
        windows ? '  command = "cmd"\n  args = ["/c", "taga-mcp"]' : '  command = "taga-mcp"',
      ].join('\n'),
    };
  }
  if (agentId === 'opencode') {
    const configRoot = env.XDG_CONFIG_HOME ?? join(home, '.config');
    return {
      agentId,
      configPaths: [join(projectRoot, 'opencode.json'), join(configRoot, 'opencode', 'opencode.json')],
      supportsMcpJson: false,
      howto: GENERIC_MCP_HOWTO[agentId] ?? '',
    };
  }
  return {
    agentId,
    configPaths: [],
    supportsMcpJson: false,
    howto: GENERIC_MCP_HOWTO[agentId] ?? `Add a stdio MCP server named "${MCP_SERVER_NAME}" with command "${MCP_SERVER_COMMAND}" to your agent's MCP configuration.`,
  };
}

/** Whether a config file already starts a stdio MCP server that runs the taga-mcp command. */
export async function isMcpServerRegistered(guide: McpRegistrationGuide, projectRoot: string): Promise<boolean> {
  for (const path of guide.configPaths) {
    const content = await readFileOrEmpty(path);
    if (content.length === 0) continue;
    if (path.endsWith('.toml')) {
      if (/\[mcp_servers\.[^\]]+\][^\]]*?command\s*=\s*"([^"]*taga-mcp)"/u.test(content)) return true;
      continue;
    }
    if (jsonStartsMcpCommand(content, projectRoot)) return true;
  }
  return false;
}

function jsonStartsMcpCommand(content: string, projectRoot: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null) return false;
  const root = parsed as Record<string, unknown>;
  const project = root.projects;
  const projectServers = typeof project === 'object' && project !== null
    ? (project as Record<string, unknown>)[projectRoot]
    : undefined;
  // .mcp.json uses mcpServers, OpenCode uses mcp.servers, Claude user config nests under projects.<root>.
  const servers = [
    root.mcpServers,
    typeof root.mcp === 'object' && root.mcp !== null ? (root.mcp as Record<string, unknown>).servers : undefined,
    typeof projectServers === 'object' && projectServers !== null ? (projectServers as Record<string, unknown>).mcpServers : undefined,
  ];
  return servers.some((entries) => typeof entries === 'object' && entries !== null
    && Object.entries(entries).some(([name, entry]) => runsTagaMcp(name, entry)));
}

/** Matches the command shapes agents use: a string ("taga-mcp"), an argv array (["taga-mcp"]), or a { command } entry. */
function runsTagaMcp(name: string, entry: unknown): boolean {
  const head = (value: unknown): unknown => Array.isArray(value) ? (value as readonly unknown[])[0] : value;
  const command = head(typeof entry === 'string' || Array.isArray(entry)
    ? entry
    : typeof entry === 'object' && entry !== null
      ? (entry as Record<string, unknown>).command
      : undefined);
  const basename = typeof command === 'string'
    ? command.replaceAll('\\', '/').split('/').at(-1)?.replace(/\.(cmd|exe|ps1|bat)$/u, '')
    : undefined;
  return name === MCP_SERVER_NAME || basename === MCP_SERVER_COMMAND;
}

async function readFileOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

export interface SourceCursor {
  readonly offset: number;
  readonly sourceVersion: string;
}

export interface SourceRecord {
  readonly id: string;
  readonly source: 'hook' | 'watcher' | 'mcp' | 'git' | 'ci' | 'probe';
  readonly payload: unknown;
  readonly raw: string;
  readonly path: string;
  readonly cursor: SourceCursor;
  readonly occurredAt: string;
}

export interface SourceDetection {
  readonly available: boolean;
  readonly path: string;
  readonly reason?: string;
}

export interface AdapterError {
  readonly path: string;
  readonly offset: number;
  readonly reason: string;
}

export interface SourceAdapter {
  readonly id: string;
  readonly sourcePath: string;
  readonly parserVersion: string;
  detect(): Promise<SourceDetection>;
  readSince(cursor: SourceCursor): AsyncIterable<SourceRecord>;
  checkpoint(record: SourceRecord): SourceCursor;
  latestCursor(): SourceCursor | null;
  errors(): readonly AdapterError[];
}

export interface AgentCapabilities {
  readonly staticInjection: boolean;
  readonly mcp: 'stdio' | 'http' | 'none';
  readonly sessionLog: 'jsonl' | 'text' | 'none';
  readonly source: 'jsonl' | 'sqlite' | 'none';
  readonly hook: boolean;
  readonly reliability: 'high' | 'medium' | 'low';
}

export interface AgentDetection {
  readonly id: string;
  readonly available: boolean;
  readonly installed: boolean;
  readonly capabilities: AgentCapabilities;
  readonly parserVersion: string;
  readonly commandPath?: string;
  readonly version?: string;
  readonly configPaths: readonly string[];
  readonly sourceRoots: readonly string[];
  readonly sourceCount: number;
  readonly latestSourcePath?: string;
  readonly degradedReasons: readonly string[];
  readonly reason?: string;
}

export interface AgentAdapter {
  readonly id: string;
  detect(options?: AgentDetectionOptions): Promise<AgentDetection>;
  staticTargets(projectPath: string): readonly string[];
  sessionSources(): Promise<readonly SourceAdapter[]>;
  capabilities(): AgentCapabilities;
}

export interface AgentDetectionOptions {
  readonly includeVersion?: boolean;
  readonly includeSourceScan?: boolean;
  readonly includeCommandLookup?: boolean;
}

export interface SourceExclusionPolicy {
  readonly excludedPaths?: readonly RegExp[];
  readonly excludedExtensions?: readonly string[];
  readonly excludedKeywords?: readonly RegExp[];
}

export interface AgentAdapterOptions {
  readonly homeDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly commandPath?: string | null;
  readonly version?: string;
  readonly sourcePaths?: readonly string[];
  readonly sourceRoots?: readonly string[];
  readonly databasePath?: string;
  readonly maxSources?: number;
  readonly clock?: () => Date;
}

type RecordValidator = (payload: unknown) => boolean;

export class JsonlSourceAdapter implements SourceAdapter {
  private readonly parseErrors: AdapterError[] = [];
  private currentCursor: SourceCursor | null = null;

  constructor(
    readonly id: string,
    readonly sourcePath: string,
    private readonly source: SourceRecord['source'] = 'watcher',
    private readonly clock: () => Date = () => new Date(),
    private readonly policy: SourceExclusionPolicy = {},
    readonly parserVersion = 'jsonl-v1',
    private readonly validateRecord: RecordValidator = isObjectRecord,
  ) {}

  async detect(): Promise<SourceDetection> {
    try {
      await access(this.sourcePath, constants.R_OK);
      return { available: true, path: this.sourcePath };
    } catch {
      return { available: false, path: this.sourcePath, reason: 'source_not_readable' };
    }
  }

  async *readSince(cursor: SourceCursor): AsyncIterable<SourceRecord> {
    this.parseErrors.length = 0;
    this.currentCursor = cursor;
    const content = await import('node:fs/promises').then(({ readFile }) => readFile(this.sourcePath));
    const start = Math.max(0, Math.min(cursor.offset, content.length));
    let offset = start;
    for (const line of completeLines(content, start)) {
      const end = offset + line.byteLength;
      const text = line.toString('utf8');
      offset = end;
      this.currentCursor = { offset: end, sourceVersion: this.parserVersion };
      const trimmed = text.trim();
      if (trimmed.length === 0 || this.isExcluded(trimmed)) continue;
      let payload: unknown;
      try {
        payload = JSON.parse(trimmed) as unknown;
      } catch {
        this.parseErrors.push({ path: this.sourcePath, offset: end - line.length, reason: 'malformed_jsonl_record' });
        continue;
      }
      if (!this.validateRecord(payload)) {
        this.parseErrors.push({ path: this.sourcePath, offset: end - line.length, reason: 'unsupported_record_schema' });
        continue;
      }
      const id = sourceRecordId(this.id, trimmed);
      yield {
        id,
        source: this.source,
        payload,
        raw: trimmed,
        path: this.sourcePath,
        cursor: { offset: end, sourceVersion: this.parserVersion },
        occurredAt: timestampFromPayload(payload) ?? this.clock().toISOString(),
      };
    }
  }

  checkpoint(record: SourceRecord): SourceCursor {
    return record.cursor;
  }

  latestCursor(): SourceCursor | null {
    return this.currentCursor;
  }

  errors(): readonly AdapterError[] {
    return [...this.parseErrors];
  }

  private isExcluded(value: string): boolean {
    if (this.policy.excludedPaths?.some((pattern) => pattern.test(this.sourcePath)) === true) return true;
    if (this.policy.excludedExtensions?.some((extension) => this.sourcePath.endsWith(extension)) === true) return true;
    return this.policy.excludedKeywords?.some((pattern) => pattern.test(value)) === true;
  }
}

export class OpenCodeSqliteSourceAdapter implements SourceAdapter {
  readonly id = 'opencode-session-db';
  readonly parserVersion = 'opencode-sqlite-v1';
  private readonly parseErrors: AdapterError[] = [];
  private currentCursor: SourceCursor | null = null;

  constructor(
    readonly sourcePath: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async detect(): Promise<SourceDetection> {
    try {
      await access(this.sourcePath, constants.R_OK);
      const database = new Database(this.sourcePath, { readonly: true, fileMustExist: true });
      try {
        const row = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session_message', 'message') ORDER BY CASE name WHEN 'session_message' THEN 0 ELSE 1 END LIMIT 1").get() as { name: string } | undefined;
        return row === undefined
          ? { available: false, path: this.sourcePath, reason: 'supported_message_table_not_found' }
          : { available: true, path: this.sourcePath };
      } finally {
        database.close();
      }
    } catch {
      return { available: false, path: this.sourcePath, reason: 'source_not_readable' };
    }
  }

  async *readSince(cursor: SourceCursor): AsyncIterable<SourceRecord> {
    this.parseErrors.length = 0;
    this.currentCursor = cursor;
    await access(this.sourcePath, constants.R_OK);
    const database = new Database(this.sourcePath, { readonly: true, fileMustExist: true });
    try {
      database.pragma('busy_timeout = 2000');
      const table = this.messageTable(database);
      if (table === null) return;
      const rows = database
        .prepare(`SELECT rowid AS offset, id, session_id, time_created, data FROM ${table} WHERE rowid > ? ORDER BY rowid`)
        .all(cursor.offset) as Array<{ offset: number; id: string; session_id: string; time_created: number; data: string }>;
      for (const row of rows) {
        this.currentCursor = { offset: row.offset, sourceVersion: this.parserVersion };
        let payload: unknown;
        try {
          payload = JSON.parse(row.data) as unknown;
        } catch {
          this.parseErrors.push({ path: this.sourcePath, offset: row.offset, reason: 'malformed_sqlite_record' });
          continue;
        }
        const raw = JSON.stringify({ sessionId: row.session_id, messageId: row.id, data: payload });
        yield {
          id: sourceRecordId(this.id, `${row.offset}:${row.id}:${row.data}`),
          source: 'watcher',
          payload,
          raw,
          path: this.sourcePath,
          cursor: { offset: row.offset, sourceVersion: this.parserVersion },
          occurredAt: Number.isFinite(row.time_created) ? new Date(row.time_created).toISOString() : this.clock().toISOString(),
        };
      }
    } finally {
      database.close();
    }
  }

  checkpoint(record: SourceRecord): SourceCursor {
    return record.cursor;
  }

  latestCursor(): SourceCursor | null {
    return this.currentCursor;
  }

  errors(): readonly AdapterError[] {
    return [...this.parseErrors];
  }

  private messageTable(database: Database.Database): 'session_message' | 'message' | null {
    const rows = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session_message', 'message') ORDER BY CASE name WHEN 'session_message' THEN 0 ELSE 1 END").all() as Array<{ name: 'session_message' | 'message' }>;
    for (const row of rows) {
      if (database.prepare(`SELECT 1 AS found FROM ${row.name} LIMIT 1`).get() !== undefined) return row.name;
    }
    return rows[0]?.name ?? null;
  }
}

abstract class BaseJsonlAgentAdapter implements AgentAdapter {
  abstract readonly id: string;
  protected abstract readonly commandName: string;
  protected abstract readonly parserVersion: string;
  protected abstract readonly capabilitiesValue: AgentCapabilities;
  protected abstract configPaths(): readonly string[];
  protected abstract defaultSourceRoots(): readonly string[];
  protected abstract recordValidator(payload: unknown): boolean;
  abstract staticTargets(projectPath: string): readonly string[];
  private cachedSourcePaths: readonly string[] | null = null;
  private cachedSourcePathsAt = 0;

  constructor(protected readonly options: AgentAdapterOptions = {}) {}

  async detect(options: AgentDetectionOptions = {}): Promise<AgentDetection> {
    const roots = this.options.sourceRoots ?? this.defaultSourceRoots();
    const sources = this.options.sourcePaths !== undefined
      ? await readablePaths(this.options.sourcePaths)
      : options.includeSourceScan === false
        ? await readablePaths(roots)
        : await this.sourcePaths();
    const commandPath = options.includeCommandLookup === false ? null : await commandPathFor(this.commandName, this.options);
    const version = commandPath === null || options.includeVersion === false ? undefined : await versionFor(commandPath, this.options);
    const installed = commandPath !== null;
    const degradedReasons = [
      ...(options.includeCommandLookup === false ? ['binary_check_skipped'] : installed ? [] : ['binary_not_found']),
      ...(sources.length > 0 ? [] : ['session_source_not_found']),
      ...(installed && options.includeVersion !== false && version === undefined ? ['version_unavailable'] : []),
    ];
    const available = installed || sources.length > 0;
    return {
      id: this.id,
      available,
      installed,
      capabilities: this.capabilitiesValue,
      parserVersion: this.parserVersion,
      ...(commandPath === null ? {} : { commandPath }),
      ...(version === undefined ? {} : { version }),
      configPaths: this.configPaths(),
      sourceRoots: roots,
      sourceCount: sources.length,
      ...(sources[0] === undefined ? {} : { latestSourcePath: sources[0] }),
      degradedReasons,
      ...(available ? {} : { reason: 'agent_not_detected' }),
    };
  }

  async sessionSources(): Promise<readonly SourceAdapter[]> {
    return (await this.sourcePaths()).map((path) => new JsonlSourceAdapter(
      `${this.id}-${shortHash(path)}`,
      path,
      'watcher',
      this.options.clock ?? (() => new Date()),
      {},
      this.parserVersion,
      (payload) => this.recordValidator(payload),
    ));
  }

  capabilities(): AgentCapabilities {
    return this.capabilitiesValue;
  }

  private async sourcePaths(): Promise<readonly string[]> {
    if (this.options.sourcePaths !== undefined) return [...this.options.sourcePaths];
    if (this.cachedSourcePaths !== null && Date.now() - this.cachedSourcePathsAt < 30_000) return this.cachedSourcePaths;
    this.cachedSourcePaths = await discoverFiles(this.options.sourceRoots ?? this.defaultSourceRoots(), '.jsonl', this.options.maxSources ?? 20);
    this.cachedSourcePathsAt = Date.now();
    return this.cachedSourcePaths;
  }
}

export class PiAgentAdapter extends BaseJsonlAgentAdapter {
  readonly id = 'pi';
  protected readonly commandName = 'pi';
  protected readonly parserVersion = 'pi-session-v3';
  protected readonly capabilitiesValue: AgentCapabilities = {
    staticInjection: true,
    mcp: 'stdio',
    sessionLog: 'jsonl',
    source: 'jsonl',
    hook: false,
    reliability: 'medium',
  };

  constructor(options: AgentAdapterOptions | string = {}) {
    super(typeof options === 'string' ? { sourcePaths: [options], commandPath: null } : options);
  }

  staticTargets(projectPath: string): readonly string[] {
    return [join(projectPath, 'AGENTS.md'), join(this.home(), '.pi', 'agent', 'AGENTS.md')];
  }

  protected configPaths(): readonly string[] {
    return [join(this.home(), '.pi', 'agent', 'settings.json')];
  }

  protected defaultSourceRoots(): readonly string[] {
    return [join(this.home(), '.pi', 'agent', 'sessions')];
  }

  protected recordValidator(payload: unknown): boolean {
    return hasStringProperty(payload, 'type');
  }

  private home(): string {
    return this.options.homeDir ?? homedir();
  }
}

export class ClaudeCodeAgentAdapter extends BaseJsonlAgentAdapter {
  readonly id = 'claude-code';
  protected readonly commandName = 'claude';
  protected readonly parserVersion = 'claude-session-v1';
  protected readonly capabilitiesValue: AgentCapabilities = {
    staticInjection: true,
    mcp: 'stdio',
    sessionLog: 'jsonl',
    source: 'jsonl',
    hook: false,
    reliability: 'medium',
  };

  staticTargets(projectPath: string): readonly string[] {
    return [join(projectPath, 'CLAUDE.md'), join(this.configRoot(), 'CLAUDE.md')];
  }

  protected configPaths(): readonly string[] {
    return [join(this.configRoot(), 'settings.json'), join(this.configRoot(), 'settings.local.json')];
  }

  protected defaultSourceRoots(): readonly string[] {
    return [join(this.configRoot(), 'projects'), join(this.configRoot(), 'sessions')];
  }

  protected recordValidator(payload: unknown): boolean {
    return hasStringProperty(payload, 'type');
  }

  private configRoot(): string {
    const env = this.options.env ?? process.env;
    return env.CLAUDE_CONFIG_DIR ?? env.CLAUDE_HOME ?? join(this.options.homeDir ?? homedir(), '.claude');
  }
}

export class CodexAgentAdapter extends BaseJsonlAgentAdapter {
  readonly id = 'codex';
  protected readonly commandName = 'codex';
  protected readonly parserVersion = 'codex-rollout-v1';
  protected readonly capabilitiesValue: AgentCapabilities = {
    staticInjection: true,
    mcp: 'stdio',
    sessionLog: 'jsonl',
    source: 'jsonl',
    hook: false,
    reliability: 'medium',
  };

  staticTargets(projectPath: string): readonly string[] {
    return [join(projectPath, 'AGENTS.md'), join(this.configRoot(), 'AGENTS.md')];
  }

  protected configPaths(): readonly string[] {
    return [join(this.configRoot(), 'config.toml')];
  }

  protected defaultSourceRoots(): readonly string[] {
    return [join(this.configRoot(), 'sessions')];
  }

  protected recordValidator(payload: unknown): boolean {
    return hasStringProperty(payload, 'type') && hasStringProperty(payload, 'timestamp');
  }

  private configRoot(): string {
    const env = this.options.env ?? process.env;
    return env.CODEX_HOME ?? join(this.options.homeDir ?? homedir(), '.codex');
  }
}

export class OpenCodeAgentAdapter implements AgentAdapter {
  readonly id = 'opencode';
  private readonly capabilitiesValue: AgentCapabilities = {
    staticInjection: true,
    mcp: 'stdio',
    sessionLog: 'none',
    source: 'sqlite',
    hook: false,
    reliability: 'medium',
  };

  constructor(private readonly options: AgentAdapterOptions = {}) {}

  async detect(options: AgentDetectionOptions = {}): Promise<AgentDetection> {
    const commandPath = options.includeCommandLookup === false ? null : await commandPathFor('opencode', this.options);
    const version = commandPath === null || options.includeVersion === false ? undefined : await versionFor(commandPath, this.options);
    const source = new OpenCodeSqliteSourceAdapter(this.databasePath(), this.options.clock ?? (() => new Date()));
    const sourceDetection = await source.detect();
    const installed = commandPath !== null;
    const available = installed || sourceDetection.available;
    const degradedReasons = [
      ...(options.includeCommandLookup === false ? ['binary_check_skipped'] : installed ? [] : ['binary_not_found']),
      ...(sourceDetection.available ? [] : [sourceDetection.reason ?? 'session_source_not_found']),
      ...(installed && options.includeVersion !== false && version === undefined ? ['version_unavailable'] : []),
    ];
    return {
      id: this.id,
      available,
      installed,
      capabilities: this.capabilitiesValue,
      parserVersion: source.parserVersion,
      ...(commandPath === null ? {} : { commandPath }),
      ...(version === undefined ? {} : { version }),
      configPaths: this.configPaths(),
      sourceRoots: [this.databasePath()],
      sourceCount: sourceDetection.available ? 1 : 0,
      ...(sourceDetection.available ? { latestSourcePath: this.databasePath() } : {}),
      degradedReasons,
      ...(available ? {} : { reason: 'agent_not_detected' }),
    };
  }

  staticTargets(projectPath: string): readonly string[] {
    return [join(projectPath, 'AGENTS.md')];
  }

  sessionSources(): Promise<readonly SourceAdapter[]> {
    return Promise.resolve([new OpenCodeSqliteSourceAdapter(this.databasePath(), this.options.clock ?? (() => new Date()))]);
  }

  capabilities(): AgentCapabilities {
    return this.capabilitiesValue;
  }

  private dataRoot(): string {
    const env = this.options.env ?? process.env;
    return env.OPENCODE_DATA_DIR ?? join(env.XDG_DATA_HOME ?? join(this.options.homeDir ?? homedir(), '.local', 'share'), 'opencode');
  }

  private databasePath(): string {
    return this.options.databasePath ?? join(this.dataRoot(), 'opencode.db');
  }

  private configPaths(): readonly string[] {
    const env = this.options.env ?? process.env;
    const configRoot = env.XDG_CONFIG_HOME ?? join(this.options.homeDir ?? homedir(), '.config');
    return [join(configRoot, 'opencode', 'opencode.json'), join(configRoot, 'opencode', 'opencode.jsonc')];
  }
}

abstract class StaticAgentAdapter implements AgentAdapter {
  abstract readonly id: string;
  protected abstract readonly commandName: string;
  protected abstract readonly configDirectories: readonly string[];
  abstract staticTargets(projectPath: string): readonly string[];
  private readonly capabilitiesValue: AgentCapabilities = {
    staticInjection: true,
    mcp: 'stdio',
    sessionLog: 'none',
    source: 'none',
    hook: false,
    reliability: 'low',
  };

  constructor(protected readonly options: AgentAdapterOptions = {}) {}

  async detect(options: AgentDetectionOptions = {}): Promise<AgentDetection> {
    const commandPath = options.includeCommandLookup === false ? null : await commandPathFor(this.commandName, this.options);
    const version = commandPath === null || options.includeVersion === false ? undefined : await versionFor(commandPath, this.options);
    const configPaths = this.configPaths();
    const readableConfigs = await readablePaths(configPaths);
    const installed = commandPath !== null || readableConfigs.length > 0;
    const degradedReasons = [
      ...(options.includeCommandLookup === false ? ['binary_check_skipped'] : installed ? [] : ['binary_and_config_not_found']),
      'automatic_collection_unavailable',
      ...(commandPath !== null && options.includeVersion !== false && version === undefined ? ['version_unavailable'] : []),
    ];
    return {
      id: this.id,
      available: installed,
      installed,
      capabilities: this.capabilitiesValue,
      parserVersion: 'static-only-v1',
      ...(commandPath === null ? {} : { commandPath }),
      ...(version === undefined ? {} : { version }),
      configPaths,
      sourceRoots: [],
      sourceCount: 0,
      degradedReasons,
      ...(installed ? {} : { reason: 'agent_not_detected' }),
    };
  }

  sessionSources(): Promise<readonly SourceAdapter[]> {
    return Promise.resolve([]);
  }

  capabilities(): AgentCapabilities {
    return this.capabilitiesValue;
  }

  protected home(): string {
    return this.options.homeDir ?? homedir();
  }

  private configPaths(): readonly string[] {
    return this.configDirectories.map((path) => join(this.home(), path));
  }
}

export class CursorAgentAdapter extends StaticAgentAdapter {
  readonly id = 'cursor';
  protected readonly commandName = 'cursor';
  protected readonly configDirectories = ['.cursor'];

  staticTargets(projectPath: string): readonly string[] {
    return [join(projectPath, '.cursor', 'rules', 'taga.mdc')];
  }
}

export class WindsurfAgentAdapter extends StaticAgentAdapter {
  readonly id = 'windsurf';
  protected readonly commandName = 'windsurf';
  protected readonly configDirectories = ['.codeium/windsurf', '.windsurf'];

  staticTargets(projectPath: string): readonly string[] {
    return [join(projectPath, '.windsurf', 'rules', 'taga.md')];
  }
}

export class ClineAgentAdapter extends StaticAgentAdapter {
  readonly id = 'cline';
  protected readonly commandName = 'cline';
  protected readonly configDirectories = ['.cline'];

  staticTargets(projectPath: string): readonly string[] {
    return [join(projectPath, '.clinerules', 'taga.md')];
  }
}

export class RooAgentAdapter extends StaticAgentAdapter {
  readonly id = 'roo';
  protected readonly commandName = 'roo';
  protected readonly configDirectories = ['.roo'];

  staticTargets(projectPath: string): readonly string[] {
    return [join(projectPath, '.roo', 'rules', 'taga.md')];
  }
}

export class AgentAdapterRegistry {
  constructor(private readonly adapters: readonly AgentAdapter[] = [
    new PiAgentAdapter(),
    new ClaudeCodeAgentAdapter(),
    new CodexAgentAdapter(),
    new OpenCodeAgentAdapter(),
    new CursorAgentAdapter(),
    new WindsurfAgentAdapter(),
    new ClineAgentAdapter(),
    new RooAgentAdapter(),
  ]) {}

  async detect(options: AgentDetectionOptions = {}): Promise<AgentDetection[]> {
    return Promise.all(this.adapters.map((adapter) => adapter.detect(options)));
  }

  all(): readonly AgentAdapter[] {
    return this.adapters;
  }

  get(id: string): AgentAdapter | null {
    const normalized = id === 'claude' ? 'claude-code' : id;
    return this.adapters.find((adapter) => adapter.id === normalized) ?? null;
  }
}

function completeLines(content: Buffer, start: number): Buffer[] {
  const lines: Buffer[] = [];
  let lineStart = start;
  while (lineStart < content.length) {
    const newline = content.indexOf(0x0a, lineStart);
    if (newline < 0) break;
    lines.push(content.subarray(lineStart, newline + 1));
    lineStart = newline + 1;
  }
  return lines;
}

async function commandPathFor(command: string, options: AgentAdapterOptions): Promise<string | null> {
  if (options.commandPath !== undefined) return options.commandPath;
  const env = options.env ?? process.env;
  const lookup = process.platform === 'win32'
    ? { file: 'where.exe', args: [command] }
    : { file: 'which', args: [command] };
  try {
    const result = await execFileAsync(lookup.file, lookup.args, { env, encoding: 'utf8', timeout: 5000, windowsHide: true });
    const candidates = result.stdout.split(/\r?\n/u).map((value) => value.trim()).filter((value) => value.length > 0);
    if (process.platform === 'win32') {
      const selected = candidates.find((value) => ['.exe', '.cmd', '.bat', '.ps1'].includes(extname(value).toLowerCase())) ?? candidates[0] ?? null;
      if (selected !== null && ['.cmd', '.bat'].includes(extname(selected).toLowerCase())) {
        const powershellShim = selected.slice(0, -extname(selected).length) + '.ps1';
        try {
          await access(powershellShim, constants.R_OK);
          return powershellShim;
        } catch {
          return selected;
        }
      }
      return selected;
    }
    return candidates[0] ?? null;
  } catch {
    return null;
  }
}

async function versionFor(commandPath: string, options: AgentAdapterOptions): Promise<string | undefined> {
  if (options.version !== undefined) return options.version;
  const env = options.env ?? process.env;
  try {
    const extension = extname(commandPath).toLowerCase();
    const invocation = extension === '.ps1'
      ? { file: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', commandPath, '--version'] }
      : extension === '.cmd' || extension === '.bat'
        ? { file: env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `""${commandPath}" --version"`] }
        : { file: commandPath, args: ['--version'] };
    const result = await runCommand(invocation.file, invocation.args, env, 15_000);
    const value = `${result.stdout}${result.stderr}`.trim().split(/\r?\n/u)[0]?.trim();
    return value === undefined || value.length === 0 ? undefined : value;
  } catch {
    return undefined;
  }
}

function runCommand(
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout = `${stdout}${chunk}`.slice(-65_536); });
    child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-65_536); });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`command exited with code ${String(code)}`));
    });
  });
}

async function discoverFiles(roots: readonly string[], extension: string, limit: number): Promise<readonly string[]> {
  const files: Array<{ path: string; modified: number }> = [];
  for (const root of roots) await visit(root, extension, files);
  return files
    .sort((left, right) => right.modified - left.modified || left.path.localeCompare(right.path))
    .slice(0, limit)
    .map((file) => file.path);
}

async function readablePaths(paths: readonly string[]): Promise<readonly string[]> {
  const readable: string[] = [];
  for (const path of paths) {
    try {
      await access(path, constants.R_OK);
      readable.push(path);
    } catch {
      continue;
    }
  }
  return readable;
}

async function visit(path: string, extension: string, result: Array<{ path: string; modified: number }>): Promise<void> {
  try {
    const metadata = await stat(path);
    if (metadata.isFile()) {
      if (path.endsWith(extension)) result.push({ path, modified: metadata.mtimeMs });
      return;
    }
    if (!metadata.isDirectory()) return;
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child, extension, result);
      else if (entry.isFile() && child.endsWith(extension)) {
        const childMetadata = await stat(child);
        result.push({ path: child, modified: childMetadata.mtimeMs });
      }
    }
  } catch {
    return;
  }
}

function sourceRecordId(adapterId: string, value: string): string {
  return `source-${createHash('sha256').update(`${adapterId}\n${value}`).digest('hex')}`;
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function isObjectRecord(payload: unknown): payload is Record<string, unknown> {
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload);
}

function hasStringProperty(payload: unknown, property: string): boolean {
  return isObjectRecord(payload) && property in payload && typeof payload[property] === 'string';
}

function timestampFromPayload(payload: unknown): string | null {
  if (!isObjectRecord(payload)) return null;
  for (const key of ['timestamp', 'createdAt', 'created_at']) {
    const value = payload[key];
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const timestamp = new Date(value);
    if (!Number.isNaN(timestamp.getTime())) return timestamp.toISOString();
  }
  return null;
}
