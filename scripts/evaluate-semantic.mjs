import { performance } from 'node:perf_hooks';
import { cpus, freemem, platform, arch, totalmem } from 'node:os';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalBgeM3Embedder } from '../dist/packages/embedding/src/index.js';
import { createLocalCrossEncoderReranker, FtsRetrievalProvider } from '../dist/packages/retrieval/src/index.js';
import { ZvecMemoryIndex, ZvecSemanticRetriever } from '../dist/packages/semantic-index/src/index.js';
import { DatabaseStore, contentHash } from '../dist/packages/storage/src/index.js';
import { createStrictSemanticDataset } from './semantic-strict-300-fixture.mjs';

const modelPath = argument('model') ?? process.env.TAGA_BGE_M3_MODEL_PATH;
if (modelPath === undefined || modelPath.length === 0) throw new Error('set TAGA_BGE_M3_MODEL_PATH or pass --model=<path>');
const rerankerModelPath = argument('reranker-model') ?? process.env.TAGA_RERANKER_MODEL_PATH;
const rerankTopK = positiveInteger(argument('rerank-top-k') ?? process.env.TAGA_RERANK_TOP_K ?? '30', 'rerank-top-k');
const rerankTimeoutMs = positiveInteger(argument('rerank-timeout-ms') ?? process.env.TAGA_RERANK_TIMEOUT_MS ?? '600000', 'rerank-timeout-ms');
const suite = argument('suite') ?? 'golden-19';
if (!['golden-19', 'strict-300'].includes(suite)) throw new Error('supported suites: golden-19, strict-300');
const dataset = evaluationDataset(suite);
const outputPath = resolve(argument('output') ?? join('release', `m4-semantic-evaluation${suite === 'strict-300' ? '-strict-300' : ''}-${platform()}-${arch()}.json`));
const fixturePath = await mkdtemp(join(tmpdir(), 'taga-semantic-eval-'));
const database = new DatabaseStore(join(fixturePath, 'taga.db'));
const evaluationStarted = performance.now();
let index;
let peakRss = process.memoryUsage().rss;

try {
  const memories = dataset.memories;
  const cases = dataset.queries;
  const provider = new FtsRetrievalProvider(database);
  const reranker = rerankerModelPath === undefined || rerankerModelPath.length === 0
    ? undefined
    : createLocalCrossEncoderReranker({ modelPath: rerankerModelPath });
  const hybridOptions = reranker === undefined
    ? {}
    : { reranker, rerankTopK, rerankTimeoutMs };
  let rerankerApplied = 0;
  let rerankerDegraded = 0;
  for (const item of memories) provider.upsert(item.memory, item.body);

  const rssBeforeModel = sampleRss();
  const embedder = createLocalBgeM3Embedder({ modelPath, batchSize: 4 });
  const coldStarted = performance.now();
  await embedder.embed([{ id: 'cold-start', text: 'bounded retry for temporary network failure' }]);
  const coldEmbedMs = performance.now() - coldStarted;
  const rssAfterModel = sampleRss();

  const documentInputs = memories.map(({ memory, body }) => ({
    id: memory.id,
    text: `${memory.title}\n\n${memory.summary}\n\n${body}`,
  }));
  const documentEmbedStarted = performance.now();
  const documentVectors = await embedder.embed(documentInputs);
  const documentEmbedMs = performance.now() - documentEmbedStarted;
  sampleRss();

  index = new ZvecMemoryIndex(join(fixturePath, 'semantic'));
  await index.initialize(embedder.metadata.fingerprint, embedder.metadata.dimensions);
  const indexStarted = performance.now();
  await index.upsert(memories.map(({ memory, body }, indexValue) => ({
    id: `${memory.id}:0`,
    memoryId: memory.id,
    chunkIndex: 0,
    chunkStart: 0,
    chunkEnd: body.length,
    scopeKind: memory.scope.kind,
    scopeId: memory.scope.kind === 'global' ? null : memory.scope.id,
    status: memory.status,
    visibility: memory.visibility,
    sourceTrust: memory.sourceTrust,
    contentHash: memory.contentHash,
    vector: documentVectors[indexValue]?.vector ?? [],
  })));
  const indexUpsertMs = performance.now() - indexStarted;
  const retriever = new ZvecSemanticRetriever({ database, index, embedder, overfetch: 8 });

  const queryRows = [];
  for (const testCase of cases) {
    const input = { query: testCase.query, limit: 10, ...(testCase.scope === undefined ? {} : { scope: testCase.scope }) };
    const lexicalStarted = performance.now();
    const lexical = provider.search(input);
    const lexicalMs = performance.now() - lexicalStarted;
    const semanticStarted = performance.now();
    const semantic = await retriever.search(input);
    const semanticMs = performance.now() - semanticStarted;
    const hybridStarted = performance.now();
    const hybrid = await provider.searchHybrid(input, { search: () => Promise.resolve(semantic) }, hybridOptions);
    if (hybrid.rerankerAvailable === true) rerankerApplied += 1;
    if (hybrid.rerankerDegraded === true) rerankerDegraded += 1;
    const hybridFusionMs = performance.now() - hybridStarted;
    sampleRss();
    queryRows.push({
      id: testCase.id,
      query: testCase.query,
      category: testCase.category ?? 'core',
      style: testCase.style ?? 'golden',
      scope: testCase.scope ?? null,
      relevantIds: testCase.relevantIds,
      forbiddenIds: testCase.forbiddenIds ?? [],
      lexicalIds: lexical.map(({ memory }) => memory.id),
      semanticIds: semantic.map(({ memory }) => memory.id),
      hybridIds: hybrid.items.map(({ memory }) => memory.id),
      rerankerApplied: hybrid.rerankerAvailable === true,
      rerankerDegraded: hybrid.rerankerDegraded === true,
      latencyMs: { lexical: round(lexicalMs), semantic: round(semanticMs), hybridFusion: round(hybridFusionMs) },
    });
    if (queryRows.length === 1 || queryRows.length % 25 === 0 || queryRows.length === cases.length) {
      console.error(`[semantic-eval] queries=${queryRows.length}/${cases.length} rerankerApplied=${rerankerApplied} rerankerDegraded=${rerankerDegraded} elapsedMs=${round(performance.now() - evaluationStarted)}`);
    }
  }

  const warmEmbeddingDurations = [];
  const zvecDurations = [];
  const hybridDurations = [];
  const latencyCases = cases.slice(0, 10);
  for (let indexValue = 0; indexValue < 20; indexValue += 1) {
    const testCase = latencyCases[indexValue % latencyCases.length];
    const embedStarted = performance.now();
    const [embedded] = await embedder.embed([{ id: `warm-${indexValue}`, text: testCase.query }]);
    warmEmbeddingDurations.push(performance.now() - embedStarted);
    if (embedded === undefined) throw new Error('query embedding missing');
    const zvecStarted = performance.now();
    await index.query({ vector: embedded.vector, topK: 10 });
    zvecDurations.push(performance.now() - zvecStarted);
    const hybridStarted = performance.now();
    await provider.searchHybrid(
      { query: testCase.query, limit: 10, ...(testCase.scope === undefined ? {} : { scope: testCase.scope }) },
      retriever,
      hybridOptions,
    );
    hybridDurations.push(performance.now() - hybridStarted);
    sampleRss();
  }

  const quality = {
    lexical: rankingMetrics(queryRows, 'lexicalIds'),
    semantic: rankingMetrics(queryRows, 'semanticIds'),
    hybrid: rankingMetrics(queryRows, 'hybridIds'),
    averageLexicalHybridOverlapAt10: round(averageOverlap(queryRows)),
  };
  const qualityBreakdown = {
    byStyle: groupedQuality(queryRows, 'style'),
    byCategory: groupedQuality(queryRows, 'category'),
  };
  const governance = governanceReport(queryRows, memories);
  const latency = {
    coldEmbedMs: round(coldEmbedMs),
    documentBatchEmbedMs: round(documentEmbedMs),
    documentEmbeddingsPerSecond: round(memories.length / (documentEmbedMs / 1000)),
    indexUpsertMs: round(indexUpsertMs),
    indexDocumentsPerSecond: round(memories.length / (indexUpsertMs / 1000)),
    lexicalQuery: distribution(queryRows.map((row) => row.latencyMs.lexical)),
    warmEmbedding: distribution(warmEmbeddingDurations),
    zvecQuery: distribution(zvecDurations),
    hybridEndToEnd: distribution(hybridDurations),
  };
  const resources = {
    rssBeforeModelMb: megabytes(rssBeforeModel),
    rssAfterModelMb: megabytes(rssAfterModel),
    peakRssMb: megabytes(peakRss),
    semanticIndexBytes: await directoryBytes(join(fixturePath, 'semantic')),
  };
  const gates = evaluateGates(quality, qualityBreakdown, latency, governance, resources, suite);
  const report = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    evidenceKind: dataset.evidenceKind,
    limitations: dataset.limitations,
    model: embedder.metadata,
    reranker: {
      enabled: reranker !== undefined,
      ...(reranker === undefined ? {} : {
        modelPath: rerankerModelPath,
        metadata: reranker.metadata,
        topK: rerankTopK,
        timeoutMs: rerankTimeoutMs,
      }),
      applied: rerankerApplied,
      degraded: rerankerDegraded,
    },
    system: {
      node: process.version,
      platform: platform(),
      arch: arch(),
      cpu: cpus()[0]?.model ?? 'unknown',
      logicalCpus: cpus().length,
      totalMemoryMb: megabytes(totalmem()),
      freeMemoryMbAtEnd: megabytes(freemem()),
    },
    dataset: { suite: dataset.id, memories: memories.length, queries: cases.length, relevantPerQuery: suite === 'strict-300' ? 3 : 1 },
    quality,
    qualityBreakdown,
    governance,
    latency,
    resources,
    gates,
    queries: queryRows,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ outputPath, dataset: report.dataset, quality, qualityBreakdown, governance, latency, resources, gates }, null, 2));
  if (!gates.passed) process.exitCode = 2;
} finally {
  index?.close();
  database.close();
  await rm(fixturePath, { recursive: true, force: true });
}

function evaluationDataset(suiteName) {
  if (suiteName === 'strict-300') {
    const strict = createStrictSemanticDataset();
    return {
      ...strict,
      memories: strict.memories.map((memory) => item(
        memory.id,
        memory.title,
        memory.summary,
        memory.body,
        memory.scope,
        memory.status,
        memory.visibility,
      )),
    };
  }
  return {
    id: 'golden-19',
    evidenceKind: 'sanitized-offline-golden-set',
    limitations: [
      'This fixture is sanitized offline evidence and is not a substitute for production query logs.',
      'Latency and memory results are hardware-specific.',
      'Only the current host platform is validated by this report.',
    ],
    memories: goldenMemories(),
    queries: goldenQueries(),
  };
}

function goldenMemories() {
  return [
    item('retry-backoff', 'Bounded retry with jitter', 'Temporary failures should not be retried immediately.', 'Use exponential backoff with jitter for transient network failures and cap the attempt count.'),
    item('least-privilege', 'Least privilege authorization', 'Grant only required permissions.', 'For HTTP 403 errors verify the access token scope and rotate credentials without broadening permissions.'),
    item('sqlite-rollback', 'Transactional schema migration', 'Database changes need a rollback path.', 'Wrap SQLite schema migration steps in a transaction and restore the previous schema when validation fails.'),
    item('node-heap', 'Node heap exhaustion', 'Large builds may exceed the JavaScript heap.', 'Set NODE_OPTIONS=--max-old-space-size=4096 for memory intensive local model or build processes.'),
    item('utf8-paths', 'UTF-8 paths on Windows', 'Keep Chinese filenames readable.', '中文文件名或路径出现乱码时，统一使用 UTF-8 编码并避免跨 shell 转义。'),
    item('cache-invalidation', 'Invalidate stale cache', 'Old cached responses must not survive source changes.', 'Use a content hash in the cache key and invalidate entries when the authoritative document changes.'),
    item('cookie-samesite', 'Cross-site cookie protection', 'Session cookies require browser protections.', 'Set Secure, HttpOnly, and SameSite attributes to reduce cross-site request forgery risk.'),
    item('alpha-blue-green', 'Alpha zero-downtime deployment', 'Alpha uses blue-green releases.', 'Deploy project alpha to the idle environment, run health checks, then switch traffic atomically.', { kind: 'project', id: 'alpha' }),
    item('beta-canary', 'Beta progressive rollout', 'Beta uses a canary release.', 'Deploy project beta to five percent of users, inspect metrics, then progressively increase traffic.', { kind: 'project', id: 'beta' }),
    item('flaky-ci', 'Intermittent CI test failures', 'Flaky tests require repeatable evidence.', 'Capture random seeds, isolate shared state, and rerun the failing test before changing production code.', { kind: 'domain', id: 'engineering' }),
    item('abort-controller', 'Cancel asynchronous work', 'Abort pending JavaScript requests.', 'Pass an AbortSignal from AbortController through the call graph and handle AbortError explicitly.'),
    item('config-file', 'Taga configuration file', 'Local settings live in a YAML file.', 'Read the Brain configuration from _config.yaml and preserve unknown keys during updates.'),
    item('local-model', 'Local-only model loading', 'Embedding must remain offline.', 'Load BGE-M3 from an explicit local path with local_files_only and never download model files automatically.'),
    item('single-writer', 'Single writer vector index', 'Native vector collections reject competing writers.', 'The daemon coordinates short-lived Zvec writers while CLI and MCP enqueue durable semantic jobs.'),
    item('memory-chunking', 'Chunk long memories', 'Long documents need overlapping segments.', 'Split long memory text at sentence boundaries with bounded overlap and retain chunk start and end offsets.'),
    item('tls-expiry', 'TLS certificate expiry', 'Prevent certificate outages.', 'Alert before certificate expiration and verify the renewed chain in the production trust store.'),
    item('structured-logging', 'Structured error logging', 'Logs need stable event fields.', 'Record event type, error code, and request id without persisting secrets.'),
    item('dependency-lock', 'Deterministic dependencies', 'Lock dependency versions.', 'Keep pnpm-lock.yaml synchronized and install with a frozen lockfile in CI.'),
    item('excluded-secret', 'Production credential', 'Never recall secret values.', 'The production password is forbidden from recall.', { kind: 'global' }, 'active', 'excluded'),
    item('stale-retry', 'Unlimited retry loop', 'Old retry guidance.', 'Retry forever without delay.', { kind: 'global' }, 'stale'),
    item('superseded-migration', 'Manual migration rollback', 'Superseded database guidance.', 'Edit production tables manually after a failed migration.', { kind: 'global' }, 'superseded'),
    item('forgotten-token', 'Legacy access token', 'Forgotten credential note.', 'Use the legacy token for every deployment.', { kind: 'global' }, 'forgotten'),
  ];
}

function goldenQueries() {
  return [
    query('exact-retry', 'exponential backoff jitter', ['retry-backoff']),
    query('semantic-retry-zh', '临时网络错误应该怎样延迟后重试', ['retry-backoff']),
    query('semantic-migration-zh', '数据库结构升级失败后如何撤销', ['sqlite-rollback']),
    query('semantic-heap', 'JavaScript 进程内存不够怎么办', ['node-heap']),
    query('semantic-encoding', '中文文件名显示成乱码', ['utf8-paths']),
    query('symbol', 'AbortController cancellation', ['abort-controller']),
    query('path', '_config.yaml', ['config-file']),
    query('offline-model', '禁止 embedding 模型联网下载', ['local-model']),
    query('writer-conflict', '向量数据库多进程同时写入冲突', ['single-writer']),
    query('alpha-deploy', '项目如何无停机切换发布环境', ['alpha-blue-green'], { kind: 'project', id: 'alpha' }, ['beta-canary']),
    query('beta-deploy', '逐步放量并观察指标', ['beta-canary'], { kind: 'project', id: 'beta' }, ['alpha-blue-green']),
    query('flaky-tests', 'CI tests fail intermittently', ['flaky-ci'], { kind: 'project', id: 'alpha' }),
    query('certificate', '证书过期前避免线上中断', ['tls-expiry']),
    query('stale-cache', '缓存返回旧数据', ['cache-invalidation']),
    query('cookie-security', '跨站请求 cookie 防护', ['cookie-samesite']),
    query('chunking', '长篇记忆切成有重叠的片段', ['memory-chunking']),
    query('permissions', '403 token lacks required permissions', ['least-privilege']),
    query('logging', '日志里记录错误码但不能泄漏秘密', ['structured-logging']),
    query('lockfile', 'CI dependency versions must be reproducible', ['dependency-lock']),
  ];
}

function item(id, title, summary, body, scope = { kind: 'global' }, status = 'active', visibility = 'private') {
  const now = '2026-11-13T00:00:00.000Z';
  return {
    body,
    memory: {
      schemaVersion: 1,
      id,
      type: 'lessons',
      scope,
      projectId: scope.kind === 'project' ? scope.id : null,
      status,
      title,
      summary,
      confidence: 0.9,
      sourceTrust: 'user_authored',
      visibility,
      created: now,
      updated: now,
      lastVerified: now,
      lastRecalled: null,
      reviewCount: 1,
      usefulCount: 1,
      notUsefulCount: 0,
      expiresAt: null,
      contentHash: contentHash(body),
      sources: [{ kind: 'test', locator: 'scripts/evaluate-semantic.mjs' }],
      anchors: [],
      tags: [],
      supersedes: null,
    },
  };
}

function query(id, text, relevantIds, scope, forbiddenIds = []) {
  return { id, query: text, relevantIds, forbiddenIds, ...(scope === undefined ? {} : { scope }) };
}

function rankingMetrics(rows, field) {
  let recallAt5 = 0;
  let recallAt10 = 0;
  let precisionAt5 = 0;
  let hitAt1 = 0;
  let mrr = 0;
  let ndcgAt10 = 0;
  let averagePrecisionAt10 = 0;
  let zeroResults = 0;
  for (const row of rows) {
    const ids = row[field];
    const relevant = new Set(row.relevantIds);
    if (ids.length === 0) zeroResults += 1;
    const hitsAt5 = ids.slice(0, 5).filter((id) => relevant.has(id)).length;
    const hitsAt10 = ids.slice(0, 10).filter((id) => relevant.has(id)).length;
    recallAt5 += hitsAt5 / relevant.size;
    recallAt10 += hitsAt10 / relevant.size;
    precisionAt5 += hitsAt5 / 5;
    hitAt1 += relevant.has(ids[0]) ? 1 : 0;
    const first = ids.findIndex((id) => relevant.has(id));
    mrr += first < 0 ? 0 : 1 / (first + 1);
    const dcg = ids.slice(0, 10).reduce((sum, id, index) => sum + (relevant.has(id) ? 1 / Math.log2(index + 2) : 0), 0);
    const ideal = Array.from({ length: Math.min(relevant.size, 10) }, (_, index) => 1 / Math.log2(index + 2)).reduce((sum, value) => sum + value, 0);
    ndcgAt10 += ideal === 0 ? 0 : dcg / ideal;
    let relevantSeen = 0;
    let precisionSum = 0;
    ids.slice(0, 10).forEach((id, index) => {
      if (!relevant.has(id)) return;
      relevantSeen += 1;
      precisionSum += relevantSeen / (index + 1);
    });
    averagePrecisionAt10 += precisionSum / Math.min(relevant.size, 10);
  }
  return {
    queries: rows.length,
    recallAt5: round(recallAt5 / rows.length),
    recallAt10: round(recallAt10 / rows.length),
    precisionAt5: round(precisionAt5 / rows.length),
    hitAt1: round(hitAt1 / rows.length),
    mrr: round(mrr / rows.length),
    ndcgAt10: round(ndcgAt10 / rows.length),
    mapAt10: round(averagePrecisionAt10 / rows.length),
    zeroResultRate: round(zeroResults / rows.length),
  };
}

function groupedQuality(rows, field) {
  const groups = new Map();
  for (const row of rows) {
    const key = row[field];
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return Object.fromEntries([...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, group]) => [key, {
    lexical: rankingMetrics(group, 'lexicalIds'),
    semantic: rankingMetrics(group, 'semanticIds'),
    hybrid: rankingMetrics(group, 'hybridIds'),
  }]));
}

function governanceReport(rows, memories) {
  const forbidden = new Set(memories.filter(({ memory }) => memory.status !== 'active' || memory.visibility === 'excluded').map(({ memory }) => memory.id));
  const leaks = [];
  for (const row of rows) {
    const forbiddenForQuery = new Set([...forbidden, ...row.forbiddenIds]);
    for (const mode of ['lexicalIds', 'semanticIds', 'hybridIds']) {
      for (const id of row[mode]) {
        if (forbiddenForQuery.has(id)) leaks.push({ queryId: row.id, mode, memoryId: id });
      }
    }
  }
  return { forbiddenIds: [...forbidden], leakCount: leaks.length, leaks };
}

function evaluateGates(quality, qualityBreakdown, latency, governance, resources, suiteName) {
  const thresholds = {
    recallAt10Gain: 0.1,
    precisionAt5MaxRegression: 0.05,
    ndcgAt10MaxRegression: 0.05,
    coldEmbedMs: 30_000,
    warmEmbeddingP95Ms: 1_000,
    zvecQueryP95Ms: 100,
    hybridP95Ms: 1_500,
    peakRssMb: 4_096,
    ...(suiteName === 'strict-300' ? {
      hybridRecallAt5: 0.65,
      hybridRecallAt10: 0.8,
      hybridPrecisionAt5: 0.35,
      hybridHitAt1: 0.8,
      hybridMapAt10: 0.75,
      hybridNdcgAt10: 0.8,
      worstStyleRecallAt10: 0.65,
    } : {}),
  };
  const styleRecall = Object.values(qualityBreakdown.byStyle).map(({ hybrid }) => hybrid.recallAt10);
  const checks = {
    recallAt10Gain: quality.hybrid.recallAt10 - quality.lexical.recallAt10 >= thresholds.recallAt10Gain,
    precisionAt5: quality.hybrid.precisionAt5 >= quality.lexical.precisionAt5 - thresholds.precisionAt5MaxRegression,
    ndcgAt10: quality.hybrid.ndcgAt10 >= quality.lexical.ndcgAt10 - thresholds.ndcgAt10MaxRegression,
    governanceLeaks: governance.leakCount === 0,
    coldEmbed: latency.coldEmbedMs <= thresholds.coldEmbedMs,
    warmEmbeddingP95: latency.warmEmbedding.p95Ms <= thresholds.warmEmbeddingP95Ms,
    zvecQueryP95: latency.zvecQuery.p95Ms <= thresholds.zvecQueryP95Ms,
    hybridP95: latency.hybridEndToEnd.p95Ms <= thresholds.hybridP95Ms,
    peakRss: resources.peakRssMb <= thresholds.peakRssMb,
    ...(suiteName === 'strict-300' ? {
      hybridRecallAt5: quality.hybrid.recallAt5 >= thresholds.hybridRecallAt5,
      hybridRecallAt10: quality.hybrid.recallAt10 >= thresholds.hybridRecallAt10,
      hybridPrecisionAt5: quality.hybrid.precisionAt5 >= thresholds.hybridPrecisionAt5,
      hybridHitAt1: quality.hybrid.hitAt1 >= thresholds.hybridHitAt1,
      hybridMapAt10: quality.hybrid.mapAt10 >= thresholds.hybridMapAt10,
      hybridNdcgAt10: quality.hybrid.ndcgAt10 >= thresholds.hybridNdcgAt10,
      worstStyleRecallAt10: Math.min(...styleRecall) >= thresholds.worstStyleRecallAt10,
    } : {}),
  };
  return { passed: Object.values(checks).every(Boolean), thresholds, checks };
}

function averageOverlap(rows) {
  return rows.reduce((sum, row) => {
    const lexical = new Set(row.lexicalIds.slice(0, 10));
    const hybrid = new Set(row.hybridIds.slice(0, 10));
    const union = new Set([...lexical, ...hybrid]);
    const intersection = [...lexical].filter((id) => hybrid.has(id));
    return sum + (union.size === 0 ? 1 : intersection.length / union.size);
  }, 0) / rows.length;
}

function distribution(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    minMs: round(sorted[0] ?? 0),
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    maxMs: round(sorted.at(-1) ?? 0),
    averageMs: round(sorted.reduce((sum, value) => sum + value, 0) / Math.max(1, sorted.length)),
  };
}

function percentile(sorted, value) {
  return sorted[Math.max(0, Math.ceil(sorted.length * value) - 1)] ?? 0;
}

async function directoryBytes(path) {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const entryPath = join(path, entry.name);
    total += entry.isDirectory() ? await directoryBytes(entryPath) : (await stat(entryPath)).size;
  }
  return total;
}

function sampleRss() {
  const rss = process.memoryUsage().rss;
  peakRss = Math.max(peakRss, rss);
  return rss;
}

function megabytes(bytes) {
  return round(bytes / 1024 / 1024);
}

function round(value) {
  return Math.round(value * 10_000) / 10_000;
}

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}
