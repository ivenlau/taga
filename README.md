# Taga

Taga 是一个本地优先、可审计的 AI Agent 长期记忆框架。它把 Markdown 记忆作为事实源，用 SQLite/FTS5 完成本地检索，并可选接入本地 BGE-M3 和 Zvec，向 Agent 提供可追踪的记忆、上下文和治理能力。

> 当前版本：`0.1.0`。项目仍在快速迭代，配置、命令和存储格式可能发生变化。

## 为什么是 Taga

- **本地优先**：记忆、索引和审计数据默认保存在本机 Brain 目录。
- **可审计**：写入、反馈、生命周期变更、召回、注入和自动治理都保留审计轨迹。
- **可控召回**：未确认的 candidate/draft 不进入默认召回，Context Pack 会说明纳入、排除和截断原因。
- **渐进增强**：默认使用 FTS5；需要时再启用本地语义检索、LLM 和后台整合。
- **多入口集成**：提供 CLI、JSON Lines MCP server 和后台 daemon，并包含 Claude Code、Codex、pi、OpenCode 等 Agent 适配基础设施。

## 工作方式

```text
Agent / CLI / MCP
        |
        v
记忆治理、检索与 Context Pack
        |
        +--> Markdown：规范记忆事实源
        +--> SQLite + FTS5：元数据、审计和词法检索
        +--> BGE-M3 + Zvec：可选的本地语义检索
```

Brain 中的 Markdown 是规范数据源；SQLite、FTS5 和向量索引属于可重建的派生数据。这个边界让 Taga 可以在索引损坏、迁移或升级后重新构建，而不依赖不可解释的黑盒状态。

## 安装

### 使用 npm 包

发布版本可安装两个命令：

```bash
npm install --global taga
taga-mcp
```

### 从源码开发

环境要求：

- Node.js `>=22 <25`
- pnpm `10.32.1`
- Windows、Linux 或 macOS
- Linux/macOS 支持用户级 systemd/launchd daemon；Windows 使用 Taga 自己的后台进程管理

```bash
git clone https://github.com/ivenlau/taga.git
cd taga
pnpm install --frozen-lockfile
pnpm run build
```

源码运行时，入口位于 `dist/`：

```bash
node dist/apps/cli/src/main.js doctor --json
node dist/apps/mcp/src/main.js
node dist/apps/daemon/src/main.js
```

## 快速开始

### 1. 初始化 Brain

在终端中直接运行交互式向导：

```bash
taga init
```

向导只配置全局 Brain、Agent 适配器、语义检索、LLM、后台整合和网络学习，并在最终摘要中确认。确认后会在同一次执行中完成写入；按 `Ctrl+C` 或在最终确认中选择取消不会修改配置。

如果启用 BGE-M3，但本机没有兼容的 Transformers.js 模型，可以让向导下载经过固定 revision 和 SHA-256 校验的 `Xenova/bge-m3`。模型约 `2.1 GiB`，默认保存到 `<brain>/models/Xenova/bge-m3`；已完成文件会复用，未完成的 `.part` 文件会从断点继续。

自动化环境使用非交互参数：

```bash
taga init --brain="$HOME/.taga/brain" --agent=codex --yes
taga doctor --brain="$HOME/.taga/brain" --json
taga reindex --brain="$HOME/.taga/brain"
```

`--yes`、`--no-interactive`、重定向输入输出或 `--json` 都不会启动交互界面。未提供 `--yes` 的非交互初始化只输出变更预览，不写入文件。`init` 不接受 `--project`、`--project-root` 或 `--project-id`，也不会创建项目记录或修改任何项目文件。Brain 可以同时服务多个项目；配置文件使用 block-style YAML，不把配置再编码成嵌套 JSON。

进入具体项目后，可以安装该项目的 Agent 指令：

```bash
cd /path/to/project
taga agent install --agent=codex --yes
taga project show --json
```

Taga 会在 Agent 会话或项目命令实际运行时，根据当前工作目录向上寻找 Git 根目录，并优先使用规范化后的 `origin` 生成稳定项目身份；非 Git 目录使用规范化路径生成身份。项目不是初始化前置条件。

### 2. 记录和检索记忆

```bash
taga memory ls --brain=./brain
taga memory search "retry policy" --brain=./brain
taga memory show <memory-id> --brain=./brain
taga memory timeline <memory-id> --brain=./brain
```

CLI 默认输出适合终端阅读；增加 `--json` 可获得结构化输出。涉及遗忘等高风险操作时需要显式提供 `--yes`。

### 3. 为会话生成 Context Pack

```bash
taga context preview --brain=./brain --agent=codex --task="fix configuration loading" --json
taga context start --brain=./brain --agent=codex --session-id=session-001 --task="fix configuration loading"
```

需要写入当前项目的 Agent 指令文件时，显式执行安装命令：

```bash
taga agent install --agent=codex --yes
taga context start --agent=codex --session-id=session-001 --inject
```

Taga 只维护 `taga:instructions:begin/end` 标记之间的内容，重复执行 `agent install` 是幂等的。`init` 不会写入这些指令块。

## CLI 命令

常用命令如下，完整行为以当前版本实现为准：

| 命令 | 用途 |
| --- | --- |
| `init` | 初始化 Brain、配置和 Agent 适配器 |
| `doctor` | 检查平台、存储、索引和运行状态 |
| `config validate` | 校验当前有效配置 |
| `config show` | 查看脱敏后的有效配置及每项来源 |
| `config migrate --write` | 将旧版配置迁移为 schema v4 |
| `project show` | 显示当前工作目录解析出的项目身份 |
| `project list` | 列出 Brain 已发现的项目 |
| `memory` | 列表、搜索、查看、编辑、反馈和生命周期管理 |
| `context` | 构建、预览、解释和追踪 Context Pack |
| `agent` | 检测 Agent、安装项目指令、采集会话和执行验收 |
| `daemon` | 启动、停止、安装和管理后台 daemon |
| `vector` | 查看、重建、同步和优化语义索引 |
| `reindex` | 从 Markdown 重建派生索引 |
| `precheck` | 在编辑前检查相关记忆和操作提示 |
| `pack` | 管理领域知识包 |
| `release` | 查看和记录发布门禁证据 |

## 配置

### 配置文件位置

默认配置文件为 `config.yaml`：

| 平台 | 默认路径 |
| --- | --- |
| Windows | `%APPDATA%\\taga\\config.yaml` |
| macOS | `~/Library/Application Support/taga/config.yaml` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/taga/config.yaml` |

也可以通过 `TAGA_CONFIG` 或命令行 `--config=<path>` 指定文件。使用 `--brain=<path>` 时，如果没有显式指定配置文件，会优先读取该 Brain 下的 `config.yaml`。

### 优先级

每个配置项按以下顺序解析，前者覆盖后者：

1. 命令行覆写，例如 `--brain`、初始化参数等。
2. 环境变量，例如 `TAGA_BRAIN`、`TAGA_SEMANTIC_MODE`。
3. `config.yaml` 中的 schema v4 配置。
4. 内置默认值。

`taga config show --json` 会同时输出脱敏后的有效配置和每个字段的来源，适合排查“配置写了但没有生效”的问题。LLM API Key 不写入 YAML，只从 `TAGA_LLM_API_KEY` 读取。

### 标准 YAML 示例

```yaml
schemaVersion: 4

paths:
  brain: ./brain

agents:
  enabled:
    - codex
  writeInstructions: false

projectResolution:
  mode: auto
  preferGitRoot: true
  preferGitRemote: true
  markerFile: .taga/project.yaml
  unknownProjectPolicy: global-only

retrieval:
  semantic:
    mode: off
    modelPath: /models/Xenova/bge-m3

llm:
  mode: off
  provider: openai-compatible
  endpoint: http://127.0.0.1:11434/v1/chat/completions
  model: local-model
  timeoutMs: 30000

consolidation:
  enabled: false
  scanIntervalMs: 600000
  promotion:
    minUsefulCount: 2
    maxNotUsefulCount: 2
  deduplication:
    rejectSimilarity: 0.95
    mergeSimilarity: 0.88

learning:
  allowNetwork: false

reflection:
  enabled: false
  intervalMs: 604800000
  windowDays: 7
  minGroupSize: 3
  maxGroups: 5
```

校验和查看有效配置：

```bash
taga config validate
taga config show --json
```

旧版 schema v1/v2/v3 配置会以只读兼容方式加载。V3 中的 `paths.project` 只用于迁移识别，不再作为运行时默认项目。确认迁移结果后执行：

```bash
taga config migrate
taga config migrate --write
```

迁移不会把旧版 API Key 写入新文件；请改用 `TAGA_LLM_API_KEY`。

### 环境变量

环境变量适合临时覆盖配置或注入敏感信息。常用变量：

| 变量 | 说明 |
| --- | --- |
| `TAGA_CONFIG` | 指定 YAML 配置文件 |
| `TAGA_BRAIN` | 覆盖 Brain 路径 |
| `TAGA_PROJECT_MARKER_FILE` | 覆盖 monorepo 项目边界标记路径 |
| `TAGA_SEMANTIC_MODE` | `off`、`shadow` 或 `on` |
| `TAGA_BGE_M3_MODEL_PATH` | 本地 BGE-M3 模型目录 |
| `TAGA_LLM_MODE` | `off`、`shadow` 或 `on` |
| `TAGA_LLM_ENDPOINT` | OpenAI 兼容 Chat Completions 地址 |
| `TAGA_LLM_MODEL` | LLM 模型名 |
| `TAGA_LLM_API_KEY` | LLM API Key，仅支持环境变量 |
| `TAGA_LLM_DAILY_CAP` | 每日 LLM 调用上限 |
| `TAGA_CONSOLIDATION_MODE` | `on` 或 `off` |
| `TAGA_LEARN_ALLOW_NETWORK` | 是否允许学习流程联网 |

## 检索与自动治理

### 词法和语义检索

默认使用 SQLite FTS5。最简单的语义检索配置方式是在 `taga init` 中选择 `shadow` 或 `on`，然后复用本地模型或显式确认下载。普通检索、daemon 和 MCP 运行期间仍然只读取本地模型，不会隐式联网下载。

也可以自行准备 Transformers.js 格式的 BGE-M3 模型：

```bash
export TAGA_BGE_M3_MODEL_PATH="$HOME/models/Xenova/bge-m3"
export TAGA_SEMANTIC_MODE=on
taga reindex
taga memory search "local retry strategy" --semantic-mode=on
```

`shadow` 模式会执行语义路径但仍以词法结果为主，适合比较质量和延迟；`on` 模式才会把混合检索结果用于返回。混合检索使用 equal-weight RRF。

### LLM 和后台整合

LLM 支持 `off`、`shadow`、`on` 三种模式：

- `off`：完全使用确定性路径。
- `shadow`：确定性结果生效，同时调用 LLM 并记录对比审计。
- `on`：LLM 为主，失败时回退确定性路径并记录 fallback 审计。

启用 `on` 或 `shadow` 时，脱敏后的会话观察内容可能发送到 `TAGA_LLM_ENDPOINT`。使用本地 Ollama 时数据留在本机；使用云端兼容服务前，请确认服务商的数据处理政策。

后台整合默认关闭。开启后，daemon 可执行 embedding 去重、draft 晋升和重复记忆的 merge-or-keep 裁决；所有自动动作都以 daemon actor 写入审计，并保留人工回滚路径。

## MCP 集成

`taga-mcp` 是基于 stdin/stdout 的 JSON Lines MCP server：每行接收一个 JSON-RPC 请求，每行输出一个 JSON-RPC 响应。它与 CLI 使用同一套配置解析和 Brain 数据。

```bash
taga-mcp
```

主要工具包括：

- `memory_search`、`memory_get`、`memory_record`、`memory_feedback`
- `memory_session_start`、`memory_session_observation`、`memory_timeline`
- `context_trace`、`memory_precheck`
- `brain_tree`、`brain_list`、`brain_summary`、`brain_detail`、`brain_rebuild`
- `knowledge_ingest`

Agent 宿主需要在自己的 MCP 配置中把启动命令指向 `taga-mcp`；路径和模型等运行参数通过 Taga 的 `config.yaml` 或环境变量管理，不在工具请求中重复传递。

Agent 开始会话时应传入实际工作目录：

```json
{
  "session_id": "20261116-taga",
  "agent_id": "codex",
  "cwd": "D:\\projects\\taga",
  "task": "fix configuration loading"
}
```

`memory_session_start` 会返回 `project_id`、`project_root` 和识别来源，并将项目绑定到该 session。后续 `memory_search`、`memory_record`、`memory_feedback`、`memory_precheck` 和 `context_trace` 可以只传 `session_id`。无项目上下文时只允许召回 global/domain 记忆，不会召回任意项目记忆。

## Daemon

前台运行适合开发和排障：

```bash
taga daemon run --brain=./brain
```

后台生命周期管理：

```bash
taga daemon start --brain=./brain
taga daemon status --brain=./brain
taga daemon restart --brain=./brain
taga daemon stop --brain=./brain
```

Linux 和 macOS 可以安装用户级服务：

```bash
taga daemon install --brain="$HOME/.taga/brain"
taga daemon uninstall
```

服务安装和卸载只管理 systemd/launchd 单元，不会删除 Brain 数据。详细说明见 [`packaging/systemd/README.md`](packaging/systemd/README.md) 和 [`packaging/launchd/README.md`](packaging/launchd/README.md)。

## 数据、安全与恢复

- Markdown 是记忆事实源；SQLite、FTS5 和向量索引可以通过 `reindex` 重建。
- candidate/draft 默认不进入普通召回；显式 `include-draft` 的结果会标记并降权。
- 敏感值不应写入 Markdown、SQLite payload、日志、MCP 错误或测试 fixture。
- 遗忘、active 记忆改写和其他高风险操作需要显式确认。
- `doctor` 用于检查本地运行环境；`memory timeline`、审计记录和 Context trace 用于追踪记忆如何产生和被使用。
- LLM 调用会记录 provider、model、mode、tokens 和 latency 等 model trace，但不会把 API Key 持久化到配置文件。

## 开发与测试

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm run lint
pnpm run test
```

CI 使用不包含 benchmark 的测试集，性能基线单独运行：

```bash
pnpm run test:ci
pnpm run test:benchmark
```

需要本地模型时，可以运行严格语义评测：

```bash
TAGA_BGE_M3_MODEL_PATH=/path/to/Xenova/bge-m3 pnpm run evaluate:semantic:strict
```

主要目录：

```text
apps/cli                CLI 入口
apps/mcp                JSON Lines MCP server
apps/daemon             会话采集、语义索引和后台整合
packages/config         schema v4、配置分层和迁移
packages/project-context 动态项目识别和稳定身份
packages/domain         Memory 领域模型与契约
packages/storage        Markdown、SQLite、迁移和审计
packages/retrieval      FTS5、RRF 和语义检索融合
packages/embedding      Transformers.js 本地 embedding
packages/semantic-index Zvec 索引和语义检索
packages/session        Session Context Pack 和 timeline
tests/                  单元、集成、发布和性能测试
scripts/                npm 打包、发布校验和语义评测
packaging/              systemd/launchd 服务模板
```

## 发布

发布版本由 `v<package.json.version>` tag 驱动。发布前会执行 build、lint、隔离测试、benchmark 和真实 npm 临时安装冒烟验证，最后发布包含 `taga` 与 `taga-mcp` 两个 bin 的 npm 包。

本地检查发布包：

```bash
pnpm run release:package
pnpm run release:smoke
pnpm run release:verify
```

正式发布需要 GitHub Actions 中配置 `NPM_TOKEN` secret，且 tag 必须严格匹配 `package.json` 版本。发布门禁和证据记录见 [`release/README.md`](release/README.md)。

## 项目状态

当前已具备：

- 本地 Markdown Brain、SQLite/FTS5 检索和审计存储
- Memory 生命周期、反馈、恢复和治理流程
- Context Pack、session timeline 和 Agent 适配器
- CLI、MCP server、daemon 和跨平台服务模板
- 可选 BGE-M3/Zvec 语义检索、LLM shadow/on 和自动整合
- 配置 schema v4、动态多项目上下文、分层优先级、旧版配置迁移和发布验证

当前限制：

- BGE-M3 的 fp32 模型约 `2.1 GiB`，首次下载和首次语义索引构建需要较长时间，并占用明显的 CPU、内存和磁盘资源。
- `0.1.0` 仍属于开发版本，公共 API、配置和存储格式不承诺长期稳定。

## 贡献

行为变更遵循仓库中的 minispec 流程：先更新项目契约和变更卡，再实现、检查、分析和归档。提交前至少运行：

```bash
pnpm run build
pnpm run lint
pnpm run test:ci
```

## 许可证

[MIT](LICENSE)
