# Taga

Taga 是一个本地优先、可审计、面向 AI Agent 的长期记忆框架。它将 Markdown 作为记忆事实源，使用 SQLite/FTS5 提供可靠的本地检索，并可选接入 BGE-M3 与 Zvec，实现离线语义召回和混合排序。

项目目前处于早期开发阶段，适合本地开发、验证和二次集成，尚未作为稳定公共包发布。

## 核心能力

- Markdown 记忆事实源，SQLite、FTS5 和向量索引均可重建。
- Memory 生命周期、Evidence、反馈、遗忘和治理审计。
- FTS5 词法检索，以及 BGE-M3 + Zvec 本地语义检索。
- 词法结果与语义结果通过 equal-weight Reciprocal Rank Fusion（equal-RRF）融合。
- 可选的 `bge-reranker-v2-m3` cross-encoder 重排，并在失败时回退 RRF。
- Session-start Context Pack、缓存失效和完整 session observation timeline。
- CLI、JSON Lines MCP 进程和后台 daemon。
- Claude Code、Codex、pi、OpenCode 等 Agent 适配基础设施。
- 本地脱敏、审计、恢复、doctor 和 release gate。

## 架构

```text
Agent / CLI / MCP
        |
        v
Memory governance and session context
        |
        +--> Markdown memories (source of truth)
        +--> SQLite + FTS5 (metadata and lexical recall)
        +--> BGE-M3 + Zvec (optional semantic recall)
        +--> BGE reranker (optional experimental reranking)
```

主要目录：

```text
apps/cli               Taga CLI
apps/mcp               JSON Lines MCP server
apps/daemon            本地采集和语义索引 daemon
packages/domain        Memory 领域模型
packages/storage       SQLite、迁移和审计存储
packages/retrieval     FTS5、RRF 和 reranker
packages/embedding     本地 Transformers.js embedding
packages/semantic-index Zvec 索引和 semantic retriever
packages/session       Session context pack 和 timeline
tests/                 单元、集成和性能测试
scripts/               严格语义评测脚本
```

## 环境要求

- Node.js `>=22 <25`
- pnpm `10.32.1`
- Windows 或 Linux；macOS daemon service 支持基于 launchd
- 可选：本地 Transformers.js 格式的 BGE-M3 模型
- 可选：本地 ONNX 格式的 `bge-reranker-v2-m3`

## 开发安装

```bash
git clone https://github.com/ivenlau/taga.git
cd taga
pnpm install --frozen-lockfile
pnpm run build
```

当前仓库没有发布全局 npm 包。开发时直接运行编译后的入口：

```bash
node dist/apps/cli/src/main.js doctor --json
node dist/apps/mcp/src/main.js
node dist/apps/daemon/src/main.js --brain=./brain
```

## 快速开始

初始化 Brain 和当前项目：

```bash
node dist/apps/cli/src/main.js init --brain=./brain --project=. --agent=local
node dist/apps/cli/src/main.js doctor --brain=./brain --json
node dist/apps/cli/src/main.js reindex --brain=./brain
```

常用命令：

```bash
node dist/apps/cli/src/main.js memory ls --brain=./brain
node dist/apps/cli/src/main.js memory search "retry policy" --brain=./brain
node dist/apps/cli/src/main.js context start --brain=./brain
node dist/apps/cli/src/main.js daemon start --brain=./brain
node dist/apps/cli/src/main.js daemon status --brain=./brain
node dist/apps/cli/src/main.js vector status --brain=./brain
```

CLI 默认输出适合终端阅读；增加 `--json` 可获得结构化响应。

## 本地语义检索

模型必须预先存在于本机，Taga 不会在运行期间自动联网下载模型。

PowerShell 示例：

```powershell
$env:TAGA_BRAIN = "D:\data\taga-brain"
$env:TAGA_BGE_M3_MODEL_PATH = "D:\models\Xenova\bge-m3"
$env:TAGA_SEMANTIC_MODE = "on"
$env:TAGA_RERANK_MODE = "off"
```

Bash 示例：

```bash
export TAGA_BRAIN="$HOME/.taga/brain"
export TAGA_BGE_M3_MODEL_PATH="$HOME/models/Xenova/bge-m3"
export TAGA_SEMANTIC_MODE=on
export TAGA_RERANK_MODE=off
```

推荐的当前默认组合是：

```text
TAGA_SEMANTIC_MODE=on
TAGA_RERANK_MODE=off
```

该配置会启用 BGE-M3 + Zvec，并使用词法与语义权重均为 `1` 的 equal-RRF。未配置模型或语义索引异常时，系统会降级到 FTS5 Fast Path。

## 可选 Reranker

Taga 支持 Transformers.js 可加载的 `bge-reranker-v2-m3` ONNX 模型：

```powershell
$env:TAGA_RERANKER_MODEL_PATH = "D:\models\Xenova\bge-reranker-v2-m3"
$env:TAGA_RERANK_MODE = "on"
$env:TAGA_RERANK_TOP_K = "10"
$env:TAGA_RERANK_TIMEOUT_MS = "1500"
```

模型目录应包含：

```text
bge-reranker-v2-m3/
  config.json
  tokenizer.json
  tokenizer_config.json
  onnx/
    model.onnx
    model.onnx_data
```

当前 CPU 评测显示 reranker 能改善 Top-1 和排序质量，但延迟明显高于 equal-RRF，因此默认保持关闭。建议仅用于 shadow、离线评测、较小 `topK`，或具备硬件加速和缓存的部署。

## MCP

`taga-mcp` 从 stdin 接收一行一个 JSON 请求，并向 stdout 返回一行一个 JSON 响应。默认 Brain 位于 `~/.taga/brain`，可通过 `TAGA_BRAIN` 修改。

已实现的主要工具包括：

- `memory_search`
- `memory_get`
- `memory_record`
- `memory_feedback`
- `memory_precheck`
- `memory_timeline`
- `memory_session_start`
- `memory_session_observation`

启动入口：

```bash
node dist/apps/mcp/src/main.js
```

## Daemon

前台运行：

```bash
node dist/apps/cli/src/main.js daemon run --brain=./brain
```

后台生命周期：

```bash
node dist/apps/cli/src/main.js daemon start --brain=./brain
node dist/apps/cli/src/main.js daemon status --brain=./brain
node dist/apps/cli/src/main.js daemon restart --brain=./brain
node dist/apps/cli/src/main.js daemon stop --brain=./brain
```

Linux systemd user service 和 macOS launchd 的说明位于 `packaging/`。Windows 当前使用 Taga 自己的后台进程生命周期管理。

## 验证

```bash
pnpm run build
pnpm run lint
pnpm run test
```

严格语义评测：

```bash
TAGA_BGE_M3_MODEL_PATH=/path/to/Xenova/bge-m3 pnpm run evaluate:semantic:strict
```

启用 reranker 的评测：

```bash
TAGA_BGE_M3_MODEL_PATH=/path/to/Xenova/bge-m3 \
TAGA_RERANKER_MODEL_PATH=/path/to/Xenova/bge-reranker-v2-m3 \
node scripts/evaluate-semantic.mjs --suite=strict-300 --rerank-top-k=10
```

最近一次本地 strict-300 reranker 结果：

| 指标 | 结果 |
| --- | ---: |
| Recall@10 | 0.8400 |
| Precision@5 | 0.4620 |
| Hit@1 | 0.9967 |
| MRR | 0.9983 |
| nDCG@10 | 0.8233 |
| MAP@10 | 0.7228 |
| Hybrid p95（CPU） | 14.6 s |
| Governance leaks | 0 |

这组数据来自确定性、脱敏的 300 条压力测试，不等价于独立人工标注或生产查询日志。完整报告位于 `release/m4-semantic-evaluation-strict-300-win32-x64.json`。

## 当前状态与限制

- Fast Path、治理、CLI、MCP、daemon、session workflow 和可选语义检索已经具备可运行实现。
- 默认检索仍推荐 equal-RRF；CPU cross-encoder reranker 暂不适合默认在线启用。
- 模型权重不会提交到仓库，需要用户自行准备本地模型。
- 这是 `0.1.0` 开发版本，配置、命令和存储格式仍可能变化。
- 当前仓库尚未声明开源许可证；在许可证补充前，保留所有权利。

## 安全原则

- 敏感值不得写入 Markdown、SQLite payload、日志、MCP 错误或测试 fixture。
- 未确认的 candidate/draft 不进入默认召回和静态 Context Pack。
- 高风险行为不得在没有单独授权的情况下自动执行。
- 所有写入、生命周期变化、召回、注入、反馈和遗忘操作都应可审计。
