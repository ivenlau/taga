# Taga

Taga 是一个本地优先、可审计、面向 AI Agent 的长期记忆框架。它将 Markdown 作为记忆事实源，使用 SQLite/FTS5 提供可靠的本地检索，并可选接入 BGE-M3 与 Zvec，实现离线语义召回和混合排序。

项目目前处于早期开发阶段，适合本地开发、验证和二次集成，尚未作为稳定公共包发布。

## 核心能力

- Markdown 记忆事实源，SQLite、FTS5 和向量索引均可重建。
- Memory 生命周期、Evidence、反馈、遗忘和治理审计。
- FTS5 词法检索，以及 BGE-M3 + Zvec 本地语义检索。
- 词法结果与语义结果通过 equal-weight Reciprocal Rank Fusion（equal-RRF）融合。
- 可选的 `bge-reranker-v2-m3` cross-encoder 重排，并在失败时回退 RRF。
- 可选的后台自动整合：embedding 语义去重、useful 反馈驱动的 draft 自动晋升，全部审计可回溯。
- 可选的 OpenAI 兼容 LLM 插槽，用于重复记忆的 merge-or-keep 裁决。
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

发布：`pnpm run build && pnpm run release:tag`（打 tag 触发 release 工作流：build、lint、隔离的 CI 测试、性能 benchmark、npm 临时安装冒烟验证后发布 `taga` 包）。本地组装发布包：`pnpm run release:package`（生成 `npm-package/`）；本地验证发布包：`pnpm run release:smoke`。发布需要 GitHub 仓库配置 `NPM_TOKEN` secret，且 tag 必须严格匹配 `package.json` 版本。

安装（发布后）：`npm i -g taga` 提供 `taga` 与 `taga-mcp` 两个命令。

开发时直接运行编译后的入口：

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

接入真实 Agent（注册会话采集适配器，并把记忆使用指令写入项目的 `CLAUDE.md` / `AGENTS.md` 以及对应的全局指令文件）：

```bash
node dist/apps/cli/src/main.js init --agent=claude-code,codex --yes
```

指令块由 `taga:instructions:begin/end` 标记管理，重复 init 幂等；`--no-instructions` 可跳过注入。注册适配器后，daemon 会自动采集 agent 会话日志并蒸馏 candidate 进审核队列。

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

## 自动记忆整合（可选）

默认关闭。设置 `TAGA_CONSOLIDATION_MODE=on` 后，daemon 的后台 `consolidation.scan` 任务会：

1. **语义去重**：对新 draft 计算与 active 记忆的 BGE-M3 余弦相似度。`≥ TAGA_DEDUP_REJECT_SIMILARITY`（默认 0.95）判定为重复、`≥ TAGA_DEDUP_MERGE_SIMILARITY`（默认 0.88）判定为重叠——两者都会生成 garden proposal 并通知，不进入自动晋升；相似度更低则视为新颖。
2. **反馈自动晋升**：draft 累计 `usefulCount ≥ TAGA_AUTO_PROMOTE_USEFUL_COUNT`（默认 2）且未被去重拦截时，按 `proactive.autoActivateFeedback` 策略自动转为 active，审计事件以 `actor: daemon` 落账并发送 L1 通知。`notUsefulCount ≥ TAGA_AUTO_PROMOTE_MAX_NOT_USEFUL`（默认 2）的 draft 不再自动晋升。
3. **LLM merge 裁决（可选插槽）**：配置 `TAGA_LLM_MODE=on` 与 OpenAI 兼容端点后，重叠区间（0.88–0.95）的 draft 交由 LLM 做 merge-or-keep 裁决；判定 merge 时生成合并文本供 garden review 采纳，不自动改写 active 记忆。未配置 LLM 时重叠 draft 直接进入人工 review。语义索引不可用时去重降级跳过，晋升不受影响。

相关环境变量：

```bash
TAGA_CONSOLIDATION_MODE=off            # on 开启后台整合
TAGA_AUTO_PROMOTE_USEFUL_COUNT=2      # 自动晋升所需 useful 反馈数
TAGA_AUTO_PROMOTE_MAX_NOT_USEFUL=2    # 超过则不再自动晋升
TAGA_DEDUP_REJECT_SIMILARITY=0.95     # 重复判定阈值
TAGA_DEDUP_MERGE_SIMILARITY=0.88      # 重叠判定下限
TAGA_CONSOLIDATION_SCAN_INTERVAL_MS=600000
TAGA_LLM_MODE=off                     # on 启用 LLM merge 裁决
TAGA_LLM_ENDPOINT=                    # OpenAI 兼容端点（如本地 Ollama）
TAGA_LLM_API_KEY=
TAGA_LLM_MODEL=
TAGA_LLM_TIMEOUT_MS=3000
```

### Draft 软召回

MCP `memory_search` 支持显式 `include_draft: true`（CLI 为 `memory search --include-draft`），draft 结果以 `status:draft:unverified` 标记并降权 0.5。默认召回与静态 Context Pack 仍仅包含 active 记忆。搜索结果的 `proof` 字段与 `proof:useful:N` / `proof:verified` match-reason 标记展示每条记忆的反馈佐证，供调用方自行加权。

## 配置文件

Taga 使用一个用户可编辑的 `config.yaml`（schemaVersion 3）。默认位置：

- Windows：`%APPDATA%\taga\config.yaml`
- Linux：`${XDG_CONFIG_HOME:-~/.config}/taga/config.yaml`
- macOS：`~/Library/Application Support/taga/config.yaml`
- 显式使用 `--brain=<path>` 且未指定配置路径时：`<brain>/config.yaml`，便于测试和隔离运行

配置路径优先级为 `--config > TAGA_CONFIG > 平台默认路径`。字段优先级为 **当前请求/CLI 参数 > 环境变量 > 配置文件 > 默认值**：

```yaml
schemaVersion: 3

paths:
  brain: C:\Users\123\.taga\brain
  project: D:\codebase\taga

agents:
  enabled:
    - claude-code
    - codex
  writeInstructions: true

retrieval:
  semantic:
    mode: on
    modelPath: D:\models\bge-m3
  rerank:
    mode: off
    modelPath: D:\models\reranker
    modelId: default
    topK: 30
    timeoutMs: 350

llm:
  mode: shadow
  provider: openai-compatible
  endpoint: http://127.0.0.1:11434/v1/chat/completions
  model: MiniMax-M3
  timeoutMs: 30000
  dailyCap: 100

consolidation:
  enabled: true
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
  enabled: true
  intervalMs: 604800000
  windowDays: 7
  minGroupSize: 3
  maxGroups: 5
```

配置文件经严格 zod schema 校验：未知键、非法类型和非法环境变量都会返回具体字段路径，不再静默回退。文件中的相对路径相对 `config.yaml` 目录解析；CLI 和环境变量中的相对路径相对当前工作目录解析。

API Key 不属于配置 schema，只能通过 `TAGA_LLM_API_KEY` 提供；`config show` 会统一脱敏。长运行的 daemon 和 MCP 在启动时读取一次配置，修改后需要重启。

配置诊断与迁移：

```bash
taga config validate
taga config show --effective
taga config migrate              # 预览 v1/v2 迁移
taga config migrate --write      # 写入 schemaVersion 3，旧文件保留
```

旧版 Brain 内的 `_config.yaml` 会在新配置缺失时只读加载并给出迁移提示。`projectId`、agent target paths、数据库、锁和健康状态均由运行时派生，不再写入用户配置，也不再生成冗余的 `agents/*.yaml`。

## 用户指定知识学习（`taga learn`）

把文字、文件、文件夹或网页内容喂给 Taga 学习——内容经脱敏、切块、语义去重后由蒸馏管道提炼为候选记忆，进审核队列：

```bash
node dist/apps/cli/src/main.js learn --text="..." --type=lessons
node dist/apps/cli/src/main.js learn --file=D:\notes\arch.md
node dist/apps/cli/src/main.js learn --dir=D:\notes --include=.md,.txt
node dist/apps/cli/src/main.js learn --url=https://example.com/post --allow-network
```

- 提炼而非全文存储：每个知识块蒸馏出 1~3 条事实型 candidate，原文位置（file/url + hash）存入 sources 可随时溯源
- 学习前语义去重：与现有 active 记忆比 BGE-M3 余弦，≥0.95 直接跳过（省 LLM 调用）；distill 管道同样挂了 `duplicateGate`（候选级语义去重）
- **网络安全**：URL 学习默认拒绝，`TAGA_LEARN_ALLOW_NETWORK=1` 显式开启；抓取内容过脱敏规则后才入库
- 防跑飞：默认跳过 `node_modules`/`.git`/隐藏目录，单文件 ≤512KB，单次 ≤50 块（`--max-blocks` 可调）
- MCP 侧提供 `knowledge_ingest` 工具：agent 可以把用户口述的知识入队，daemon 后台蒸馏
- **目录监视**：`learn --watch --dir=D:
otes [--interval-ms=30000]` 前台轮询，文件 hash 增量状态持久化，新/变更文件自动学习，Ctrl+C 退出

## Reflect 周期反思（可选）

`TAGA_REFLECT_MODE=on` 后，daemon 按周（`TAGA_REFLECT_INTERVAL_MS`，默认 7 天）把近期活跃的 active 记忆按类型+作用域分组（组内 ≥ `TAGA_REFLECT_MIN_GROUP` 条，默认 3），交给 LLM 提炼一条**更高层的洞察 candidate**（"这些记忆共同指向什么规律"），进审核队列。相关环境变量：

```bash
TAGA_REFLECT_MODE=off            # on 开启周期反思
TAGA_REFLECT_INTERVAL_MS=604800000
TAGA_REFLECT_WINDOW_DAYS=7       # 只反思窗口内活跃的记忆
TAGA_REFLECT_MIN_GROUP=3
TAGA_REFLECT_MAX_GROUPS=5
```

反思需要 LLM（`TAGA_LLM_MODE=on`）：每次反思产生 1 条洞察 candidate、1 条冗余合并 garden 提案 + `reflect.completed`/`reflect.group` 审计事件和 L1 通知。Markdown 解析对 CRLF 行尾容错（外部编辑器改过的记忆文件不再被静默忽略）。
- **纠错学习**：`memory_feedback kind=conflict` 会自动触发一次以冲突上下文为证据的蒸馏（原记忆哪不可靠、正确是什么），产出的修正 lessons candidate 同样进审核队列，每条记忆每天最多触发一次
- **冗余提案**：每个反思分组会同时归档一条 garden 提案（"这 N 条记忆主题趋同，考虑合并"），与洞察 candidate 一并供人工处置

## LLM 适配（可选）

Taga 的 LLM 能力默认关闭。设置以下环境变量后，OpenAI 兼容端点会驱动两个消费点：

- **会话日志蒸馏**（`distill.auto`）：candidate 质量从确定性规则升级为 LLM 提炼
- **记忆整合裁决**（consolidation）：重叠区间 draft 的 merge-or-keep 由 LLM 裁决

```bash
TAGA_LLM_MODE=off            # off（默认）| shadow | on
TAGA_LLM_ENDPOINT=           # OpenAI 兼容地址，如 http://127.0.0.1:11434/v1/chat/completions（Ollama）
TAGA_LLM_API_KEY=
TAGA_LLM_MODEL=
TAGA_LLM_TIMEOUT_MS=30000
TAGA_LLM_PROVIDER_NAME=openai-compatible
```

| 模式 | 行为 |
|---|---|
| `off` | 不调用 LLM，蒸馏与整合全部走确定性路径 |
| `shadow` | 确定性结果照旧生效；LLM 双跑，对比结果写 `distill.llm_shadow` 审计事件——用于上线前评估质量 |
| `on` | LLM 为主，失败自动回退确定性路径并写 `distill.llm_fallback` 审计；consolidation 裁决启用 |

**隐私提示**：`TAGA_LLM_MODE=on/shadow` 时，脱敏后的会话观察内容会发送到 `TAGA_LLM_ENDPOINT`。指向本地 Ollama 时数据不出机器；指向云端服务时请自行确认该端点的数据处理政策。发送前不做额外变换，行为可预测。

candidate 的 model trace（provider/model/mode/tokens/latency）与审计事件共同构成 LLM 调用的完整可观测性。

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

`taga-mcp` 从 stdin 接收一行一个 JSON 请求，并向 stdout 返回一行一个 JSON 响应。Brain 路径来自统一配置，也可通过 `TAGA_BRAIN` 临时覆盖；配置文件可通过 `TAGA_CONFIG` 指定。

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
- 未确认的 candidate/draft 不进入默认召回和静态 Context Pack；显式 `include_draft` 的搜索结果带未验证标记并降权。
- 高风险行为不得在没有单独授权的情况下自动执行；自动晋升仅限 draft → active，遗忘与改写 active 记忆始终需要人工确认。
- 所有写入、生命周期变化、召回、注入、反馈和遗忘操作都应可审计；自动转正以 `actor: daemon` 落审计并可人工回滚。
