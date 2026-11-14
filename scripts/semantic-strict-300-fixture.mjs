const topics = [
  topic('retry-backoff', 'exponential backoff and jitter', 'Bounded retry policy', 'Repeated immediate retries amplify a temporary outage.', 'Cap attempts and add exponential delay with random jitter.', '临时故障被立即连续重试，导致故障放大。', '限制重试次数，并使用指数退避和随机抖动。', 'Requests keep hammering an unhealthy dependency.', '依赖异常时请求仍然持续打满。', 'Retry-After'),
  topic('circuit-breaker', 'circuit breaker half-open state', 'Circuit breaker recovery', 'A failing dependency consumes every request until the caller collapses.', 'Open the circuit after a failure threshold and probe recovery in half-open state.', '下游持续失败时，上游仍把所有流量压过去。', '达到失败阈值后熔断，并在半开状态探测恢复。', 'Latency spikes while every call waits for the same broken service.', '所有调用都等待故障服务，延迟持续升高。', 'half_open'),
  topic('idempotency', 'idempotency key duplicate request', 'Idempotent command handling', 'Network retries can execute the same payment or command more than once.', 'Persist an idempotency key and return the original result for duplicates.', '网络重试可能让同一支付或命令执行多次。', '持久化幂等键，重复请求返回第一次执行结果。', 'A client timeout is followed by duplicated side effects.', '客户端超时后出现重复扣款或重复写入。', 'Idempotency-Key'),
  topic('timeout-budget', 'deadline propagation timeout budget', 'End-to-end timeout budgets', 'Independent downstream timeouts can exceed the caller deadline.', 'Propagate one deadline and reserve time for cleanup and fallback.', '各下游独立设置超时，累计时间超过调用方截止时间。', '传递统一截止时间，并为清理和降级预留预算。', 'The parent request expires before nested calls stop.', '主请求已经超时，子调用仍在继续运行。', 'AbortSignal.timeout'),
  topic('rate-limit', 'token bucket rate limiting', 'Rate limit burst control', 'Traffic bursts exhaust a shared service even when average load is acceptable.', 'Use a token bucket with bounded burst capacity and explicit retry guidance.', '平均流量正常，但突发请求压垮共享服务。', '使用令牌桶限制突发容量，并返回明确的重试提示。', 'Short spikes cause 429 responses and queue growth.', '短时流量尖峰导致 429 和队列堆积。', '429 Retry-After'),
  topic('queue-backpressure', 'queue backpressure bounded buffer', 'Bounded queue backpressure', 'An unbounded producer queue converts overload into memory exhaustion.', 'Bound the queue and slow or reject producers before memory is exhausted.', '无界生产队列把过载转化成内存耗尽。', '限制队列长度，在内存耗尽前阻塞或拒绝生产者。', 'Resident memory grows with pending work and never stabilizes.', '待处理任务越积越多，常驻内存无法稳定。', 'highWaterMark'),
  topic('transaction-rollback', 'database transaction rollback', 'Transactional rollback', 'Partial writes leave related records in inconsistent states.', 'Wrap related writes in one transaction and roll back on validation failure.', '部分写入成功会让关联记录处于不一致状态。', '把关联写入放进同一事务，校验失败时整体回滚。', 'One table is updated while another still contains old data.', '一张表已经更新，另一张表仍是旧数据。', 'BEGIN IMMEDIATE'),
  topic('schema-migration', 'expand contract schema migration', 'Compatible schema migration', 'A breaking schema change cannot be deployed safely with mixed application versions.', 'Use expand-migrate-contract phases and verify rollback before removing old columns.', '新旧应用版本并存时，破坏性表结构变更无法安全发布。', '采用扩展、迁移、收缩三阶段，并在删旧列前验证回滚。', 'Old instances fail immediately after the new migration runs.', '迁移执行后，旧版本实例立即报错。', 'schema_version'),
  topic('cache-invalidation', 'cache invalidation content hash', 'Authoritative cache invalidation', 'Cached responses remain stale after the source document changes.', 'Include an authoritative content hash in the cache key and invalidate on change.', '源文档已经变化，但缓存仍返回旧内容。', '把权威内容哈希放入缓存键，并在变化时失效。', 'Users observe old values after a successful update.', '更新成功后，用户仍然看到旧值。', 'ETag'),
  topic('distributed-lock', 'distributed lease fencing token', 'Fenced distributed leases', 'An expired lock holder can continue writing after another worker acquires the lock.', 'Attach a monotonically increasing fencing token to every protected write.', '旧锁持有者过期后仍继续写入，与新持有者发生竞争。', '为每次受保护写入附加单调递增的 fencing token。', 'Two workers both believe they own the same resource.', '两个工作进程都认为自己持有同一资源。', 'fencing_token'),
  topic('message-dedup', 'message deduplication consumer offset', 'At-least-once message deduplication', 'At-least-once delivery can process the same event repeatedly.', 'Store a stable event identifier with the business transaction before acknowledging.', '至少一次投递可能让同一事件被重复消费。', '在确认消息前，把稳定事件 ID 与业务事务一起保存。', 'The consumer restarts and applies an already completed event again.', '消费者重启后再次执行已经完成的事件。', 'event_id'),
  topic('replica-lag', 'read replica lag read your writes', 'Read-after-write consistency', 'A request writes to the primary and immediately reads stale data from a replica.', 'Route read-after-write traffic to the primary or carry a replication position.', '请求写入主库后立即从副本读取，得到旧数据。', '读写后的一致性请求走主库，或携带复制位点。', 'A successful update appears missing for several seconds.', '更新已经成功，但几秒内查询不到。', 'LSN'),
  topic('tls-rotation', 'TLS certificate rotation trust chain', 'TLS certificate rotation', 'An expired or incomplete certificate chain causes a production outage.', 'Renew early, deploy the full chain, and verify it from an external client.', '证书过期或证书链不完整会造成线上中断。', '提前续期、部署完整证书链，并从外部客户端验证。', 'Browsers reject the endpoint although the server has a new certificate.', '服务器已换新证书，但浏览器仍拒绝连接。', 'fullchain.pem'),
  topic('least-privilege', 'OAuth scope least privilege', 'Least privilege authorization', 'Broad credentials increase impact while missing scopes cause 403 errors.', 'Grant only required scopes and rotate credentials without broadening access.', '权限过宽会扩大风险，缺少 scope 又会导致 403。', '只授予必要 scope，轮换凭据时不要扩大权限。', 'The token is valid but the API returns forbidden.', '令牌有效，但接口返回禁止访问。', 'scope'),
  topic('secret-redaction', 'structured log secret redaction', 'Secret-safe diagnostics', 'Logs and traces can accidentally persist credentials or private payloads.', 'Redact secrets before serialization and keep stable diagnostic fields.', '日志和链路可能意外保存凭据或私密正文。', '在序列化前脱敏，只保留稳定诊断字段。', 'An error report contains an authorization header.', '错误报告里出现了 Authorization 请求头。', 'Authorization'),
  topic('csrf-cookie', 'SameSite CSRF cookie protection', 'Browser session CSRF protection', 'Cross-site requests can reuse an authenticated browser session.', 'Use SameSite, Secure, HttpOnly, and an anti-CSRF token where required.', '跨站请求可能复用浏览器中的登录会话。', '配置 SameSite、Secure、HttpOnly，并在需要时使用 CSRF token。', 'A third-party page can trigger a state-changing request.', '第三方页面能够触发修改状态的请求。', 'SameSite=Lax'),
  topic('sql-injection', 'parameterized SQL query', 'SQL injection prevention', 'Concatenating user input into SQL changes the intended query structure.', 'Use bound parameters and allow-list identifiers that cannot be parameterized.', '把用户输入拼接进 SQL 会改变原有查询结构。', '使用绑定参数，对无法参数化的标识符做白名单限制。', 'A quote in a search field changes returned rows.', '搜索字段中的引号改变了查询结果。', 'prepare'),
  topic('path-traversal', 'path traversal canonical root', 'Filesystem path containment', 'Untrusted relative paths can escape the intended workspace.', 'Resolve the absolute path and verify it remains under the allowed root.', '不可信相对路径可能逃逸出目标工作目录。', '解析绝对路径，并确认最终路径仍位于允许根目录内。', 'A filename containing dot-dot reads a parent directory.', '文件名包含上级路径后读到了父目录。', 'realpath'),
  topic('node-heap', 'NODE_OPTIONS max old space size', 'Node.js heap exhaustion', 'Large local model or build workloads exceed the default JavaScript heap.', 'Set an explicit max old space size and measure resident memory separately.', '本地模型或大型构建超过 Node.js 默认堆限制。', '设置明确的最大老生代空间，并单独测量常驻内存。', 'The process exits with JavaScript heap out of memory.', '进程因为 JavaScript heap out of memory 退出。', '--max-old-space-size'),
  topic('event-loop', 'Node.js event loop blocking', 'Event loop latency', 'Synchronous CPU work stalls unrelated requests in the same process.', 'Move heavy work to a worker and monitor event loop delay.', '同步 CPU 任务会阻塞同一进程中的其他请求。', '把重任务移到 worker，并监控 event loop delay。', 'Simple health checks pause during a CPU-intensive operation.', 'CPU 密集任务执行时，简单健康检查也会卡住。', 'monitorEventLoopDelay'),
  topic('memory-leak', 'heap snapshot retained objects', 'Memory leak diagnosis', 'Objects remain reachable after requests complete and RSS grows over time.', 'Compare heap snapshots and inspect retained paths before changing limits.', '请求结束后对象仍被引用，RSS 随时间持续增长。', '对比 heap snapshot，先检查 retained path，再调整限制。', 'Garbage collection runs but baseline memory never drops.', '垃圾回收执行后，内存基线仍不下降。', 'writeHeapSnapshot'),
  topic('utf8-paths', 'UTF-8 Windows path encoding', 'Cross-shell UTF-8 paths', 'Chinese filenames become unreadable when shells disagree on encoding.', 'Use UTF-8 end to end and avoid rebuilding paths through another shell.', '不同 shell 编码不一致时，中文文件名会变成乱码。', '全链路使用 UTF-8，避免跨 shell 重新拼接路径。', 'A valid Chinese directory name is displayed as replacement characters.', '正确的中文目录名显示成乱码或替换字符。', 'chcp 65001'),
  topic('flaky-tests', 'flaky test random seed shared state', 'Repeatable flaky-test diagnosis', 'Intermittent tests hide shared state, timing, or random seed dependencies.', 'Capture the seed, isolate state, and rerun the smallest failing test.', '间歇性测试失败通常隐藏共享状态、时序或随机种子依赖。', '记录随机种子、隔离状态，并重跑最小失败用例。', 'The same CI commit alternates between pass and fail.', '同一个 CI 提交有时通过、有时失败。', 'vitest --sequence.shuffle', { kind: 'project', id: 'alpha' }),
  topic('lockfile', 'frozen lockfile deterministic install', 'Reproducible dependency installation', 'Unpinned dependency resolution makes local and CI builds differ.', 'Commit the lockfile and install with frozen resolution in CI.', '依赖解析未锁定会让本地和 CI 构建结果不同。', '提交 lockfile，并在 CI 中使用 frozen 安装。', 'A clean CI machine installs a different transitive version.', '全新 CI 环境安装了不同的间接依赖版本。', 'pnpm-lock.yaml', { kind: 'project', id: 'beta' }),
  topic('memory-chunking', 'overlapping semantic memory chunks', 'Semantic memory chunking', 'Long memories lose local meaning when embedded as one oversized document.', 'Split at semantic boundaries with bounded overlap and retain source offsets.', '长记忆整体向量化会丢失局部语义。', '按语义边界切分，保留有限重叠和原文偏移。', 'A relevant paragraph is hidden inside a very long memory.', '相关段落埋在超长记忆中，无法稳定召回。', 'chunk_start'),
  topic('offline-model', 'local_files_only BGE-M3', 'Offline embedding model loading', 'A supposedly local memory system unexpectedly downloads model files.', 'Require an explicit local model path and disable remote model resolution.', '本地记忆系统不应在运行时偷偷下载模型。', '要求显式本地模型路径，并禁止远程模型解析。', 'Startup attempts an outbound request when the model cache is incomplete.', '模型缓存不完整时，启动过程尝试访问外网。', 'local_files_only'),
  topic('zvec-writer', 'Zvec single writer lock', 'Zvec writer coordination', 'Competing native writers can fail to acquire the collection lock.', 'Use one daemon writer and enqueue durable semantic index jobs.', '多个 native writer 会争抢 collection 锁并导致写入失败。', '只保留一个 daemon writer，其他进程提交持久化索引任务。', 'The CLI and daemon both try to update the vector collection.', 'CLI 与 daemon 同时尝试更新向量集合。', 'ZVecOpen', { kind: 'project', id: 'alpha' }),
  topic('generation-mismatch', 'semantic index generation fingerprint', 'Embedding generation compatibility', 'Queries become invalid when model dimensions or fingerprints differ from the active index.', 'Build a new generation and activate it only after validation succeeds.', '模型维度或 fingerprint 与活动索引不一致时，查询会失效。', '构建新 generation，验证成功后再原子切换。', 'The model loads successfully but every vector query has incompatible dimensions.', '模型加载成功，但向量查询全部提示维度不兼容。', 'embeddingFingerprint'),
  topic('content-hash', 'semantic content hash drift', 'Derived index freshness', 'A vector hit can point to memory content that has changed since indexing.', 'Compare the indexed content hash with the authoritative memory before recall.', '向量命中可能指向索引后已经变化的记忆正文。', '召回前比较索引 content hash 与权威记忆哈希。', 'Search returns a memory whose current body no longer matches the indexed text.', '搜索返回的记忆正文与当初向量化内容已经不同。', 'content_hash'),
  topic('semantic-fallback', 'semantic retrieval FTS fallback', 'Semantic retrieval degradation', 'Missing models or corrupt vector indexes must not make memory search unavailable.', 'Fall back to FTS5, mark the response degraded, and expose a repair action.', '模型缺失或向量索引损坏时，记忆搜索不能整体不可用。', '降级到 FTS5，标记 degraded，并给出修复动作。', 'Vector search fails while lexical memory search is still healthy.', '向量搜索失败，但关键词记忆搜索仍然正常。', 'repairSuggestion'),
];

export function createStrictSemanticDataset() {
  const memories = [];
  const queries = [];
  for (const definition of topics) {
    const relevantIds = [`${definition.id}-concept`, `${definition.id}-runbook`, `${definition.id}-diagnostic`];
    memories.push(
      memory(relevantIds[0], definition.title, definition.problemEn, `${definition.solutionEn} The controlling technical anchor is ${definition.symbol}.`, definition.scope),
      memory(relevantIds[1], `${definition.title} 操作手册`, definition.problemZh, `${definition.solutionZh} 执行后验证症状已经消失，并保留可回滚证据。`, definition.scope),
      memory(relevantIds[2], `Diagnose ${definition.title}`, definition.symptomEn, `When ${lowerFirst(definition.symptomEn)}, inspect ${definition.symbol}, confirm the failure boundary, and then apply the bounded remediation.`, definition.scope),
    );
    const oppositeScope = definition.scope.kind === 'project'
      ? { kind: 'project', id: definition.scope.id === 'alpha' ? 'beta' : 'alpha' }
      : definition.scope;
    const negativeId = `${definition.id}-hard-negative`;
    memories.push(memory(
      negativeId,
      `${definition.title} unsafe shortcut`,
      `Contains similar terminology but recommends the opposite operational behavior.`,
      `Ignore ${definition.symbol}, disable the safeguard, and continue even when ${lowerFirst(definition.symptomEn)} This is intentionally unsafe guidance.`,
      oppositeScope,
    ));
    const variants = queryVariants(definition);
    for (const variant of variants) {
      queries.push({
        id: `${definition.id}-${variant.style}`,
        query: variant.text,
        relevantIds,
        category: definition.category,
        style: variant.style,
        scope: definition.scope,
        forbiddenIds: definition.scope.kind === 'project' ? [negativeId] : [],
      });
    }
  }
  memories.push(
    memory('strict-excluded-secret', 'Production access credential', 'Secret material must never be recalled.', 'A credential-like value exists only to validate exclusion.', { kind: 'global' }, 'active', 'excluded'),
    memory('strict-stale-guidance', 'Obsolete unlimited retry policy', 'Stale operational guidance.', 'Retry forever without delay or a deadline.', { kind: 'global' }, 'stale'),
    memory('strict-superseded-guidance', 'Superseded manual index repair', 'Old vector repair guidance.', 'Edit native index files directly while readers are active.', { kind: 'global' }, 'superseded'),
    memory('strict-forgotten-guidance', 'Forgotten shared token', 'Deleted credential guidance.', 'Reuse one shared token for every integration.', { kind: 'global' }, 'forgotten'),
  );
  return {
    id: 'strict-300',
    evidenceKind: 'sanitized-offline-generated-strict-300',
    limitations: [
      'The 300 queries are deterministic sanitized stress cases, not production query logs.',
      'Template diversity does not replace independent human relevance judgments.',
      'Latency and memory results are hardware-specific.',
      'Only the current host platform is validated by this report.',
    ],
    memories,
    queries,
  };
}

function topic(id, term, title, problemEn, solutionEn, problemZh, solutionZh, symptomEn, symptomZh, symbol, scope = { kind: 'global' }) {
  const category = id.startsWith('semantic-') || ['memory-chunking', 'offline-model', 'zvec-writer', 'generation-mismatch', 'content-hash'].includes(id)
    ? 'semantic-memory'
    : ['transaction-rollback', 'schema-migration', 'cache-invalidation', 'distributed-lock', 'message-dedup', 'replica-lag'].includes(id)
      ? 'data'
      : ['tls-rotation', 'least-privilege', 'secret-redaction', 'csrf-cookie', 'sql-injection', 'path-traversal'].includes(id)
        ? 'security'
        : ['node-heap', 'event-loop', 'memory-leak', 'utf8-paths', 'flaky-tests', 'lockfile'].includes(id)
          ? 'runtime-build'
          : 'reliability';
  return { id, term, title, problemEn, solutionEn, problemZh, solutionZh, symptomEn, symptomZh, symbol, scope, category };
}

function queryVariants(definition) {
  return [
    { style: 'exact', text: definition.term },
    { style: 'symptom-en', text: definition.symptomEn },
    { style: 'paraphrase-en', text: definition.problemEn },
    { style: 'action-en', text: `What operational steps should we take when ${lowerFirst(definition.symptomEn)}?` },
    { style: 'symptom-zh', text: definition.symptomZh },
    { style: 'paraphrase-zh', text: definition.problemZh },
    { style: 'action-zh', text: `遇到“${definition.symptomZh}”时应该如何处理？` },
    { style: 'mixed-anchor', text: `${definition.symbol} 应该如何用于解决这个问题` },
    { style: 'diagnostic', text: `Which subsystem or signal should I inspect when ${lowerFirst(definition.symptomEn)}?` },
    { style: 'preventive-zh', text: `如何提前避免${trimStop(definition.problemZh)}？` },
  ];
}

function memory(id, title, summary, body, scope, status = 'active', visibility = 'private') {
  return { id, title, summary, body, scope, status, visibility };
}

function lowerFirst(value) {
  return value.charAt(0).toLowerCase() + value.slice(1).replace(/[.]$/, '');
}

function trimStop(value) {
  return value.replace(/[。.]$/, '');
}
