import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';

const execFileAsync = promisify(execFile);

export const DEFAULT_AGENT_INSTRUCTIONS = [
  '## Taga 长期记忆（taga-mcp）',
  '',
  '本会话接入了 Taga 本地记忆库（MCP 服务器 `taga`，工具以 `memory_` / `brain_` / `context_` 开头）。行为约定：',
  '',
  '1. **会话开始**：进入一个新任务会话时，调用 `memory_session_start`，传入当前工作目录 `cwd`（`session_id` 用 `日期-项目简称` 格式，如 `20261114-taga`）；Taga 会动态识别项目并返回 Context Pack。',
  '2. **主动记录**：当会话中产生或确认了**可跨会话复用**的经验时，主动调用 `memory_record` 写入。典型场景：',
  '   - 踩坑与修复方案（报错根因、有效解法）',
  '   - 用户的偏好与工作习惯（称呼、代码风格、流程偏好）',
  '   - 项目关键决策与环境配置变更（端口、路径、版本约束）',
  '   - 验证过的操作步骤（部署、构建、排查流程）',
  '   类型选择（`type` 参数，五选一）：',
  '   - `preferences` — 用户偏好与习惯（称呼、代码风格、流程偏好）',
  '   - `environment` — 环境与配置事实（路径、端口、版本、工具链约束）',
  '   - `procedures` — 验证过的操作步骤（部署、构建、排查 SOP）',
  '   - `lessons` — 踩坑与修复经验（报错根因、有效解法、"不要做 X"）',
  '   - `projects` — 项目决策与目标（方案取舍、里程碑、范围界定）',
  '   拿不准时选 `lessons`（最常见）；明显关于用户本人的选 `preferences`。',
  '   参数要求：传入当前 `session_id`，`scope` 通常使用 `"auto"`，`requested_status` 必须显式传 `"draft"`，`actor` 传 `"agent"`，`sources` 至少给出一条来源（file/commit/tool_call）。宁缺毋滥——只记可复用的事实，不记一次性细节和中间过程。',
  '3. **动手前查询**：遇到"以前怎么解决的"类问题、或要修改之前改过的文件时，先 `memory_search` 再动手，避免重复踩坑。',
  '4. **反馈闭环**：召回的记忆确实帮到了你，可在会话收尾时对关键记忆调 `memory_feedback`（kind=useful）；发现记忆过时或有误，调 kind=conflict 或 not_useful。',
  '5. **状态说明**：写入的记忆是 draft，由用户审核或后台整合（consolidation）自动晋升后才进默认召回。不要向用户声称记忆"已生效"，可以说"已记录待审核"。',
].join('\n');

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
