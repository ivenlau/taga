import { icon } from '../icons.js';
import { $, PAGER, api, confirmAction, emptyState, esc, fmtTime, kv, listenPage, pageEl, pagerBar, pagerClick, previewModal, toast } from '../core.js';
import { SENSITIVE_RE } from './memories.js';

/* ---------- S12 系统与设置（配置中心 / 运行与维护 / 高级配置） ---------- */

const SYSTEM_TABS = [
  ['ops', '运行与维护', 'refresh'],
  ['config', '配置中心', 'settings'],
  ['advanced', '高级配置', 'pencil'],
];

const SOURCE_BADGE = {
  default: ['neutral', '默认值'],
  file: ['accent', 'config.yaml'],
  environment: ['warn', 'env 锁定'],
  override: ['danger', '启动参数锁定'],
};

const ENV_SNIPPLES = [
  ['TAGA_BRAIN', 'Brain 目录'],
  ['TAGA_SEMANTIC_MODE', 'off / shadow / on'],
  ['TAGA_BGE_M3_MODEL_PATH', 'BGE-M3 模型目录'],
  ['TAGA_LLM_API_KEY', 'LLM 密钥（不落盘）'],
  ['TAGA_LLM_MODE', 'off / shadow / on'],
  ['TAGA_CONSOLIDATION_MODE', 'off / on'],
  ['TAGA_CONSOLIDATION_SCAN_INTERVAL_MS', '整合扫描间隔'],
  ['TAGA_AUTO_PROMOTE_USEFUL_COUNT', '自动晋升有用阈值'],
  ['TAGA_DEDUP_REJECT_SIMILARITY', '判重阈值'],
  ['TAGA_DEDUP_MERGE_SIMILARITY', '合并阈值'],
];

function dottedGet(target, path) {
  return path.split('.').reduce((cursor, part) => (cursor == null ? undefined : cursor[part]), target);
}

function fmtMs(value) {
  if (typeof value !== 'number') return '';
  if (value % 3600000 === 0 && value >= 3600000) return `= ${value / 3600000} 小时`;
  if (value % 60000 === 0 && value >= 60000) return `= ${value / 60000} 分钟`;
  if (value % 1000 === 0 && value >= 1000) return `= ${value / 1000} 秒`;
  return '';
}

export async function renderSystem() {
  const [sys, jobs, cfg, llmUsage] = await Promise.all([api('/api/system'), api('/api/jobs'), api('/api/config'), api('/api/llm/usage')]);
  const tab = PAGER.systemTab || 'ops';
  pageEl.classList.add('fill');
  pageEl.innerHTML = `
    <div class="tabs">
      ${SYSTEM_TABS.map(([key, label, ic]) => `<span class="tab ${tab === key ? 'on' : ''}" data-sys-tab="${key}">${icon(ic, 14, 'currentColor')} ${label}</span>`).join('')}
      <div class="spacer"></div>
      <span class="mono small faint">config: ${esc(cfg.configPath)}</span>
    </div>
    <div class="fill-area" id="system-tab-content" style="display:flex;flex-direction:column"></div>`;
  pageEl.querySelectorAll('[data-sys-tab]').forEach((el) => el.addEventListener('click', () => {
    PAGER.systemTab = el.dataset.sysTab;
    renderSystem();
  }));
  const content = $('#system-tab-content');
  if (tab === 'config') renderConfigTab(content, cfg);
  else if (tab === 'advanced') renderAdvancedTab(content, cfg);
  else renderOpsTab(content, sys, jobs, llmUsage);
}

/* ---------- 页签一：配置中心 ---------- */

function cfgBlocks() {
  return [
    { icon: 'brain', title: '记忆与项目识别', desc: 'Brain 数据目录与项目边界识别策略', fields: [
      { key: 'paths.brain', label: 'Brain 目录', help: 'Markdown 事实源所在目录；迁移需离线操作', kind: 'readonly' },
      { key: 'projectResolution.preferGitRoot', label: '优先 git 根目录', help: '项目根以 git 工作区为准', kind: 'boolean' },
      { key: 'projectResolution.preferGitRemote', label: '优先 git remote', help: '用 origin 地址生成稳定项目 ID', kind: 'boolean' },
      { key: 'projectResolution.markerFile', label: '标记文件', help: '按标记文件识别项目边界', kind: 'string' },
      { key: 'projectResolution.unknownProjectPolicy', label: '未知项目策略', help: '当前固定 global-only', kind: 'readonly' },
    ] },
    { icon: 'search', title: '检索与语义', desc: 'FTS5 词法 + 可选 BGE-M3 语义融合召回', fields: [
      { key: 'retrieval.semantic.mode', label: '语义模式', help: 'off=纯词法 · shadow=影子对比 · on=融合召回', kind: 'featureMode' },
      { key: 'retrieval.semantic.modelPath', label: '模型路径', help: '本地 Xenova/bge-m3 目录（模型由 daemon 统一加载）', kind: 'string', modelStatus: true },
    ] },
    { icon: 'info', title: 'LLM', desc: '蒸馏 / 反思 / 合并裁决的模型接入', fields: [
      { key: 'llm.mode', label: 'LLM 模式', help: 'off=确定性回退 · shadow=影子对比 · on=启用', kind: 'featureMode' },
      { key: 'llm.provider', label: 'provider', help: '如 openai-compatible', kind: 'string' },
      { key: 'llm.endpoint', label: 'endpoint', help: 'OpenAI 兼容接口地址', kind: 'string' },
      { key: 'llm.model', label: 'model', help: '模型标识', kind: 'string' },
      { key: 'llm.timeoutMs', label: '超时（ms）', help: '单次调用超时', kind: 'int' },
      { key: 'llm.dailyCap', label: '每日调用上限', help: '留空 = 内置默认 200 次/天；超限自动降级确定性路径', kind: 'int', nullable: true, placeholder: '默认 200' },
      { key: 'llm.dailyTokens', label: '每日 Token 预算', help: '留空 = 内置默认 2,000,000；按输入+输出 token 记账', kind: 'int', nullable: true, placeholder: '默认 2,000,000' },
      { key: 'llm.perConsumerShare', label: '单消费方份额', help: '蒸馏/学习/反思/合并 单链路最多占总预算的比例；1 = 不分桶', kind: 'unit' },
      { key: 'llm.apiKey', label: 'API Key', help: '仅环境变量 TAGA_LLM_API_KEY；密钥不落盘 config.yaml', kind: 'envOnly' },
    ] },
    { icon: 'layers', title: '后台整合 · consolidation', desc: '自动晋升、判重与合并裁决', fields: [
      { key: 'consolidation.enabled', label: '启用整合', help: 'daemon 周期扫描并执行晋升 / 判重', kind: 'boolean' },
      { key: 'consolidation.scanIntervalMs', label: '扫描间隔（ms）', help: '周期扫描的间隔', kind: 'int', hint: 'ms' },
      { key: 'consolidation.promotion.minUsefulCount', label: '晋升所需有用次数', help: 'useful ≥ N 自动晋升 active', kind: 'int' },
      { key: 'consolidation.promotion.maxNotUsefulCount', label: '允许无用次数', help: 'not_useful > N 淘汰', kind: 'int' },
      { key: 'consolidation.deduplication.rejectSimilarity', label: '判重阈值', help: '≥ 该相似度判为重复（确定性）', kind: 'unit' },
      { key: 'consolidation.deduplication.mergeSimilarity', label: '合并阈值', help: '≥ 该相似度交 LLM 裁决合并', kind: 'unit' },
    ] },
    { icon: 'sprout', title: '反思提炼 · reflection', desc: '从记忆组提炼洞见候选', fields: [
      { key: 'reflection.enabled', label: '启用反思', help: 'daemon 周期运行反思任务', kind: 'boolean' },
      { key: 'reflection.intervalMs', label: '反思间隔（ms）', help: '两次反思运行的间隔', kind: 'int', hint: 'ms' },
      { key: 'reflection.windowDays', label: '观察窗口（天）', help: '回看多少天的记忆', kind: 'int' },
      { key: 'reflection.minGroupSize', label: '最小组大小', help: '少于 N 条不构成记忆组', kind: 'int' },
      { key: 'reflection.maxGroups', label: '单次最大组数', help: '每次运行最多提炼多少组', kind: 'int' },
    ] },
    { icon: 'book', title: '学习与 Agent', desc: '学习来源与 Agent 接入', fields: [
      { key: 'learning.allowNetwork', label: '允许网络学习', help: '危险：允许从网络来源学习知识', kind: 'boolean', danger: true },
      { key: 'agents.enabled', label: '已启用 Agent', help: '会话采集与指令写入的目标 Agent', kind: 'chips', options: ['claude-code', 'codex', 'pi', 'opencode'] },
      { key: 'agents.writeInstructions', label: '写入 Agent 指令', help: '自动维护 CLAUDE.md / AGENTS.md 记忆块', kind: 'boolean' },
    ] },
    { icon: 'history', title: '采集', desc: '增量采集的时间窗', fields: [
      { key: 'collection.lookbackDays', label: '采集时间窗（天）', help: '早于窗口的会话记录不入库、不蒸馏（游标照常推进）；改小可只关注近期', kind: 'int', placeholder: '默认 7' },
    ] },
  ];
}

function cfgControl(field, value, locked, cfg) {
  const disabled = locked ? 'disabled' : '';
  switch (field.kind) {
    case 'readonly':
      return `<span class="mono small" style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(String(value ?? '—'))}</span>`;
    case 'envOnly':
      return cfg.env.llmApiKeySet
        ? '<span class="badge ok"><span class="dot"></span>已配置</span>'
        : '<span class="badge danger"><span class="dot"></span>未配置</span>';
    case 'boolean':
      return `<span class="toggle ${value ? 'on' : ''}" data-cfg-toggle="${esc(field.key)}" ${disabled} style="${locked ? 'opacity:.5' : 'cursor:pointer'}"><span class="knob"></span></span>`;
    case 'featureMode':
      return `<div class="row" style="gap:6px">${['off', 'shadow', 'on'].map((mode) => `
        <span class="radio ${value === mode ? 'on' : ''}" data-cfg-radio="${esc(field.key)}" data-value="${mode}" ${disabled} style="${locked ? 'opacity:.5' : 'cursor:pointer'}"><span class="ring"></span>${mode}</span>`).join('')}</div>`;
    case 'unit':
      return `<input type="range" class="cfg-slider" min="0" max="1" step="0.01" value="${Number(value ?? 0)}" data-cfg-range="${esc(field.key)}" ${disabled}>
        <input class="cfg-input" style="width:86px" type="number" min="0" max="1" step="0.01" value="${Number(value ?? 0)}" data-cfg-input="${esc(field.key)}" ${disabled}>`;
    case 'int':
      return `<input class="cfg-input" style="width:120px" type="number" min="1" step="1" value="${value ?? ''}" placeholder="${field.placeholder ?? (field.nullable ? '不限' : '')}" data-cfg-input="${esc(field.key)}" ${disabled}>
        ${field.hint === 'ms' ? `<span class="mono small faint" data-cfg-hint="${esc(field.key)}">${fmtMs(value)}</span>` : ''}`;
    case 'chips':
      return `<div class="row" style="gap:6px">${field.options.map((opt) => `
        <span class="chip ${(value || []).includes(opt) ? 'on' : ''}" data-cfg-chip="${esc(field.key)}" data-value="${opt}" ${disabled} style="${locked ? 'opacity:.5' : 'cursor:pointer'}">${opt}</span>`).join('')}</div>`;
    default:
      return `<input class="cfg-input" type="text" value="${esc(String(value ?? ''))}" data-cfg-input="${esc(field.key)}" ${disabled}>`;
  }
}

function renderConfigTab(content, cfg) {
  const draft = new Map();
  const original = (key) => {
    const v = dottedGet(cfg.config, key);
    return v === undefined ? null : v;
  };
  content.innerHTML = `
    <div class="split fill-area">
      <div class="main-col" style="overflow:hidden">
        <div class="list-scroll stack">
          ${cfgBlocks().map((block) => `
          <div class="card">
            <div class="card-head">${icon(block.icon, 15, 'var(--accent)')}
              <h2>${block.title}</h2><div class="spacer"></div>
              <span class="small faint">${block.desc}</span></div>
            <div class="cfg-grid">
            ${block.fields.map((field) => {
              const value = field.kind === 'envOnly' ? null : original(field.key);
              const source = cfg.sources[field.key] || 'default';
              const badge = SOURCE_BADGE[source] ?? SOURCE_BADGE.default;
              const locked = source === 'environment' || source === 'override';
              return `
              <div class="cfg-row" data-cfg-row="${esc(field.key)}">
                <div class="cfg-label">
                  <div class="small" style="color:var(--text)">${esc(field.label)}</div>
                  <div class="small faint">${esc(field.help ?? '')}</div>
                  ${field.modelStatus ? `<div class="mono small" style="color:var(--text-muted)">模型状态：${cfg.config.retrieval?.semantic?.modelPath ? '已配置路径' : '未配置'} · daemon 持有模型</div>` : ''}
                </div>
                <div class="cfg-control">
                  ${cfgControl(field, value, locked, cfg)}
                  <div class="spacer"></div>
                  <span class="badge ${badge[0]}" title="${esc(badge[1])}">${esc(badge[1])}</span>
                </div>
              </div>`;
            }).join('')}
            </div>
          </div>`).join('')}
        </div>
      </div>
      <div class="rail wide" style="overflow-y:auto;flex:none">
        <div class="card" id="cfg-panel">
          <div class="card-head"><h2>未保存变更</h2><div class="spacer"></div><span class="badge accent" id="cfg-count">0</span></div>
          <div id="cfg-diff"><div class="small faint">修改左侧任意配置后在此汇总，统一保存。</div></div>
        </div>
        <div class="card">
          <h2>配置来源与优先级</h2>
          ${kv([['优先级', 'override > env > yaml > default'], ['写入目标', cfg.configPath]])}
          <div class="row" style="gap:8px;margin-top:6px">${Object.entries(SOURCE_BADGE).map(([, [cls, label]]) => `<span class="badge ${cls}">${label}</span>`).join('')}</div>
          <div class="small faint" style="margin-top:8px">env / 启动参数锁定的项在 Web 只读（yaml 改了也会被覆盖）。保存前自动备份 config.yaml.bak，全部操作写审计。</div>
        </div>
        <div class="card" style="background:var(--accent-soft);border-color:var(--accent)">
          <h2>生效说明</h2>
          <div class="small muted">带 ⚙ 的后台参数（扫描间隔 / 反思窗口等）<b>重启 daemon 后生效</b>；检索与 LLM 模式随下次请求生效。</div>
        </div>
      </div>
    </div>
    <div class="save-bar">
      ${icon('info', 15, 'var(--info)')}
      <span class="small muted" style="flex:1">保存前自动备份 config.yaml.bak 并写入 config.update 审计；⚙ 后台参数需重启 daemon 生效。</span>
      <button class="btn" id="cfg-discard">全部放弃</button>
      <button class="btn primary" id="cfg-save" disabled>保存…</button>
    </div>`;

  const refreshPanel = () => {
    $('#cfg-count').textContent = String(draft.size);
    $('#cfg-save').disabled = draft.size === 0;
    $('#cfg-diff').innerHTML = draft.size === 0
      ? '<div class="small faint">修改左侧任意配置后在此汇总，统一保存。</div>'
      : [...draft.entries()].map(([key, value]) => `
        <div class="row" style="gap:8px;padding:6px 0;border-bottom:1px solid var(--border-soft);align-items:flex-start">
          <div style="flex:1"><div class="mono small">${esc(key)}</div>
            <div class="mono small faint">${esc(String(original(key) ?? '空'))} → <b style="color:var(--warn)">${esc(value === null ? '（清空）' : String(value))}</b></div></div>
        </div>`).join('');
    content.querySelectorAll('[data-cfg-row]').forEach((row) => {
      row.classList.toggle('dirty', draft.has(row.dataset.cfgRow));
    });
  };
  const setDraft = (key, value) => {
    const current = original(key);
    const same = (Array.isArray(value) && Array.isArray(current))
      ? value.length === current.length && value.every((item, i) => item === current[i])
      : value === current;
    if (same) draft.delete(key);
    else draft.set(key, value);
    refreshPanel();
  };

  content.addEventListener('click', (event) => {
    const toggle = event.target.closest('[data-cfg-toggle]:not([disabled])');
    if (toggle) {
      const key = toggle.dataset.cfgToggle;
      const next = !toggle.classList.contains('on');
      toggle.classList.toggle('on', next);
      setDraft(key, next);
      return;
    }
    const radio = event.target.closest('[data-cfg-radio]:not([disabled])');
    if (radio) {
      const key = radio.dataset.cfgRadio;
      radio.parentElement.querySelectorAll('[data-cfg-radio]').forEach((el) => el.classList.remove('on'));
      radio.classList.add('on');
      setDraft(key, radio.dataset.value);
      return;
    }
    const chip = event.target.closest('[data-cfg-chip]:not([disabled])');
    if (chip) {
      const key = chip.dataset.cfgChip;
      chip.classList.toggle('on');
      const selected = [...chip.parentElement.querySelectorAll('[data-cfg-chip].on')].map((el) => el.dataset.value);
      setDraft(key, selected);
    }
  });
  content.addEventListener('input', (event) => {
    const input = event.target.closest('[data-cfg-input]');
    if (input) {
      const key = input.dataset.cfgInput;
      const raw = input.value.trim();
      if (input.type === 'number') {
        const num = Number(raw);
        if (raw === '') setDraft(key, key === 'llm.dailyCap' || key === 'llm.dailyTokens' ? null : NaN);
        else setDraft(key, Number.isNaN(num) ? NaN : num);
      } else setDraft(key, raw);
      const hint = content.querySelector(`[data-cfg-hint="${key}"]`);
      if (hint) hint.textContent = fmtMs(Number(raw));
      return;
    }
    const range = event.target.closest('[data-cfg-range]');
    if (range) {
      const key = range.dataset.cfgRange;
      const num = Number(range.value);
      const echo = content.querySelector(`[data-cfg-input="${key}"]`);
      if (echo) echo.value = String(num);
      setDraft(key, num);
    }
  });
  $('#cfg-discard').addEventListener('click', () => renderSystem());
  $('#cfg-save').addEventListener('click', async () => {
    const changes = {};
    for (const [key, value] of draft.entries()) changes[key] = Number.isNaN(value) ? null : value;
    const ok = await confirmAction({
      title: '保存配置变更？',
      body: `将写入 ${cfg.configPath}（写前自动备份 config.yaml.bak），并记录 config.update 审计。`,
      impact: [...draft.entries()].map(([key, value]) => `${key}: ${String(original(key) ?? '空')} → ${String(value ?? '（清空）')}`).slice(0, 8),
      confirmLabel: '确认保存',
    });
    if (!ok) return;
    try {
      await api('/api/config', { method: 'PUT', body: JSON.stringify({ changes, reason: 'updated via web workbench' }) });
      toast('ok', '配置已保存', '已备份 config.yaml.bak · 审计 config.update', '查看审计');
      PAGER.systemTab = 'config';
      renderSystem();
    } catch (error) { toast('danger', '保存失败', error.message); }
  });
  refreshPanel();
}

/* ---------- 页签二：运行与维护 ---------- */

function usageRow(label, used, limit) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : null;
  const warn = pct !== null && pct >= 80;
  return `
    <div style="margin-top:8px">
      <div class="row" style="gap:8px">
        <span class="small" style="flex:1">${label}</span>
        <span class="mono small" ${warn ? 'style="color:var(--warn)"' : ''}>${used.toLocaleString()}${limit ? ` / ${limit.toLocaleString()}` : ''}${pct !== null ? ` · ${pct}%` : ''}</span>
      </div>
      ${limit ? `<div style="height:6px;border-radius:3px;background:var(--border-soft);overflow:hidden"><div style="height:100%;width:${pct}%;background:${warn ? 'var(--warn)' : 'var(--accent)'}"></div></div>` : ''}
    </div>`;
}

function renderOpsTab(content, sys, jobs, usage) {
  const statusFilter = PAGER.jobsStatus || 'all';
  const statusCounts = {};
  for (const job of jobs.items) statusCounts[job.status] = (statusCounts[job.status] || 0) + 1;
  const statusOrder = ['queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled'];
  const filteredJobs = jobs.items.filter((job) => statusFilter === 'all' || job.status === statusFilter);
  const jlimit = 8;
  let joffset = PAGER.jobs || 0;
  if (joffset >= filteredJobs.length) { joffset = 0; PAGER.jobs = 0; }
  const jobsPage = filteredJobs.slice(joffset, joffset + jlimit);
  content.innerHTML = `
    <div class="split fill-area">
      <div class="main-col" style="overflow:hidden">
        <div class="list-scroll stack">
          <div class="card">
            <div class="card-head"><h2>运行状态</h2><div class="spacer"></div>
              <span class="badge ${sys.daemon?.running ? 'ok' : sys.daemon?.stale ? 'warn' : 'neutral'}"><span class="dot"></span>${sys.daemon?.running ? `daemon running · pid ${sys.daemon.pid}` : sys.daemon?.stale ? 'daemon 锁陈旧' : 'daemon 未运行 · Fast Path 可用'}</span></div>
            ${kv([['版本', `taga ${sys.runtime?.version ?? '?'} · node ${sys.runtime?.node ?? '?'}`],
      ['平台', `${sys.runtime?.platform ?? '?'} · ${sys.runtime?.arch ?? '?'}`],
      ['绑定', '127.0.0.1（仅本机）'], ['Brain', sys.brainPath]])}
            <div class="row">
              <button class="btn small" id="sys-restart">重启 daemon…</button>
              <button class="btn small" id="sys-doctor">运行 doctor</button>
            </div>
          </div>
          <div class="card">
            <div class="card-head"><h2>后台任务 Jobs</h2><div class="spacer"></div>
              <span class="mono small faint">队列持久化于 SQLite · 失败可重试</span></div>
            <div class="row">
              <span class="chip ${statusFilter === 'all' ? 'on' : ''}" data-job-filter="all">全部 <b>${jobs.items.length}</b></span>
              ${statusOrder.filter((status) => statusCounts[status]).map((status) => `
                <span class="chip ${statusFilter === status ? 'on' : ''}" data-job-filter="${status}">${status} <b>${statusCounts[status]}</b></span>`).join('')}
              <div class="spacer"></div>
              <span class="small faint">筛选后勾选可批量操作</span>
            </div>
            <div class="row" style="background:var(--accent-soft);border:1px solid var(--accent);border-radius:10px;padding:10px 16px">
              ${icon('layers', 15, 'var(--warn)')}
              <b class="small">已选 <span id="jobs-sel-count">0</span> / ${filteredJobs.length} 条</b>
              <div class="spacer"></div>
              <button class="btn small" id="jobs-rerun" disabled>重跑失败任务</button>
              <button class="btn danger-ghost small" id="jobs-clear" disabled>清除历史任务…</button>
            </div>
            ${filteredJobs.length === 0 ? emptyState(statusFilter === 'all' ? '暂无任务' : `当前筛选（${statusFilter}）下暂无任务`, 'inbox') : `
            <table>
              <thead><tr><th><span class="checkbox" id="jobs-sel-all"></span></th><th class="mono">job</th><th class="mono">kind</th><th class="mono">status</th><th></th></tr></thead>
              <tbody>
                ${jobsPage.map((job) => `<tr>
                  <td><span class="checkbox" data-job-sel="${esc(job.id)}" data-job-status="${esc(job.status)}"></span></td>
                  <td class="mono">${esc(job.id)}</td><td class="mono">${esc(job.kind)}</td>
                  <td><span class="badge ${job.status === 'dead' || job.status === 'failed' ? 'danger' : 'neutral'}">${esc(job.status)}</span></td>
                  <td>${job.status === 'dead' || job.status === 'failed' ? `<button class="btn small" data-retry="${esc(job.id)}">重试</button>` : ''}</td></tr>`).join('')}
              </tbody>
            </table>`}
            ${filteredJobs.length > jlimit ? pagerBar('jobs', filteredJobs.length, joffset, jlimit) : ''}
          </div>
        </div>
      </div>
      <div class="rail wide" style="overflow-y:auto">
        <div class="card">
          <h2>检索与语义</h2>
          ${kv([['FTS5', 'ok · 词法检索就绪'],
      ['semantic', `${sys.semantic.mode} · ${sys.semantic.modelAvailable ? 'bge-m3 模型就绪' : '模型缺失（自动降级）'}`],
      ['modelPath', sys.semantic.modelPath || '未配置'],
      ['语义索引', sys.semantic.indexStatus || '—'],
      ['融合', 'equal-weight RRF（词法 0.5 / 语义 0.5）']])}
          <div class="row">
            <button class="btn small" id="sys-reindex">重建索引…</button>
            <button class="btn small" id="sys-vector">重建向量…</button>
          </div>
        </div>
        <div class="card">
          <h2>LLM 与用量</h2>
          <div class="row">
            <span class="badge ${sys.llm.mode === 'off' ? 'neutral' : 'warn'}"><span class="dot"></span>mode: ${esc(sys.llm.mode)}</span>
            ${sys.llm.apiKeySet ? '<span class="badge ok">API Key 已配置（仅环境变量）</span>' : '<span class="badge danger">API Key 未配置</span>'}
            ${usage?.warning ? '<span class="badge warn"><span class="dot"></span>今日预算 ≥80%</span>' : ''}
          </div>
          ${kv([['provider', sys.llm.provider || '—'], ['endpoint', sys.llm.endpoint || '—'], ['model', sys.llm.model || '—'],
      ['timeoutMs', String(sys.llm.timeoutMs)],
      ['dailyCap', sys.llm.dailyCap ? String(sys.llm.dailyCap) : '默认 200'],
      ['dailyTokens', sys.llm.dailyTokens ? String(sys.llm.dailyTokens) : '默认 2,000,000'],
      ['perConsumerShare', sys.llm.perConsumerShare !== undefined ? String(sys.llm.perConsumerShare) : '默认 0.8']])}
          ${usage ? `
          <div class="eyebrow" style="margin-top:8px">今日用量 · ${esc(usage.today.day)}</div>
          ${usageRow('调用次数', usage.today.calls, usage.limits.dailyCalls)}
          ${usageRow('Token（输入+输出）', usage.today.tokens, usage.limits.dailyTokens)}
          ${Object.keys(usage.today.consumers).length > 0 ? `
          <div class="eyebrow" style="margin-top:8px">消费方分桶</div>
          ${Object.entries(usage.today.consumers).map(([name, bucket]) => `
            <div class="row" style="gap:8px;padding:2px 0"><span class="mono small" style="flex:1">${esc(name)}</span>
              <span class="mono small faint">${bucket.calls} 次 · ${bucket.tokens.toLocaleString()} tokens</span></div>`).join('')}` : ''}
          ${usage.days.length > 1 ? `
          <div class="eyebrow" style="margin-top:8px">近 ${usage.days.length} 日</div>
          ${usage.days.map((day) => `
            <div class="row" style="gap:8px;padding:2px 0"><span class="mono small" style="flex:1">${esc(day.day)}</span>
              <span class="mono small faint">${day.calls} 次 · ${day.tokens.toLocaleString()} tokens${day.warned ? ' · ⚠ 告警' : ''}</span></div>`).join('')}` : ''}
          ` : ''}
          <div class="mono small faint">LLM 用于观察蒸馏（候选生产）、反思提炼（洞见候选）与整合合并裁决；失败自动回退确定性路径，产出一律进入候选层待审。</div>
        </div>
        <div class="card" style="background:var(--accent-soft);border-color:var(--accent)">
          <h2>安全边界</h2>
          ${['仅绑定 127.0.0.1，无远程访问', '敏感值脱敏贯穿 UI / 日志 / 审计', '高风险操作输入式确认 + 全程留痕', 'Fast Path 不依赖 daemon / LLM / 网络']
      .map((t) => `<div class="row" style="gap:8px">${icon('shield', 13, 'var(--ok)')}<span class="small muted">${t}</span></div>`).join('')}
        </div>
      </div>
    </div>`;
  $('#sys-reindex').addEventListener('click', async () => {
    const ok = await confirmAction({
      title: '重建派生索引？',
      body: '从 Markdown 事实源重建 SQLite / FTS5 索引。派生数据可安全重建，但期间检索结果可能不完整。',
      impact: ['rebuild FTS5 memory index', '审计新增 maintenance.reindex（actor=web）'],
      confirmLabel: '确认重建',
    });
    if (!ok) return;
    try {
      await api('/api/system/reindex', { method: 'POST', body: JSON.stringify({ confirm: true }) });
      toast('ok', '已写入审计', 'actor=web · maintenance.reindex · 重建完成', '查看审计');
      renderSystem();
    } catch (error) { toast('danger', '重建失败', error.message); }
  });
  $('#sys-vector').addEventListener('click', async () => {
    const ok = await confirmAction({
      title: '排队重建语义索引？',
      body: '将 semantic.rebuild 任务入队，由 daemon 执行 bge-m3 / Zvec 重建；期间语义检索降级纯 FTS5。',
      impact: ['enqueue semantic.rebuild', '审计新增 maintenance.vector_rebuild（actor=web）'],
      confirmLabel: '确认排队',
    });
    if (!ok) return;
    try {
      await api('/api/system/vector-rebuild', { method: 'POST', body: JSON.stringify({ confirm: true }) });
      toast('ok', '已写入审计', 'actor=web · maintenance.vector_rebuild · 已排队', '查看审计');
    } catch (error) { toast('danger', '操作失败', error.message); }
  });
  $('#sys-doctor').addEventListener('click', async () => {
    try {
      const report = await api('/api/system/doctor');
      const checkRow = (c, icSize = 14) => `
        <div class="row" style="gap:10px;padding:8px 0;border-bottom:1px solid var(--border-soft);align-items:flex-start">
          ${icon(c.ok ? 'circleCheck' : 'alert', icSize, `var(--${c.ok ? 'ok' : 'warn'})`)}
          <div style="flex:1">
            <div class="small" style="color:var(--text)">${esc(c.name)}</div>
            <div class="mono small faint">${esc(c.status)}${c.detail ? ' · ' + esc(c.detail) : ''}</div>
          </div>
        </div>`;
      previewModal({
        title: 'doctor · 运行体检',
        sub: `生成于 ${fmtTime(report.generatedAt)} · ${report.okCount}/${report.total} 项通过`,
        html: `
          ${report.checks.map((c) => checkRow(c)).join('')}
          <div class="eyebrow" style="margin-top:12px">平台检查</div>
          ${report.extra.map((c) => checkRow(c, 13)).join('')}`,
      });
    } catch (error) { toast('danger', 'doctor 失败', error.message); }
  });
  $('#sys-restart').addEventListener('click', async () => {
    const ok = await confirmAction({
      title: '重启 daemon？',
      body: '将停止当前 daemon 进程并重新拉起（systemd / launchd 托管时走服务重启）。期间后台任务暂停，Fast Path 不受影响。',
      impact: ['stop + start daemon', '配置变更随重启生效', '审计新增 daemon.restart（actor=web）'],
      confirmLabel: '确认重启',
    });
    if (!ok) return;
    try {
      const result = await api('/api/system/daemon-restart', { method: 'POST', body: JSON.stringify({ confirm: true }) });
      toast('ok', 'daemon 已重启', `${result.managed ? '服务托管重启' : '进程重启'} · pid ${result.pid ?? '—'}`, '查看审计');
      renderSystem();
    } catch (error) { toast('danger', '重启失败', error.message); }
  });
  const selected = new Map();
  const refreshJobsBar = () => {
    $('#jobs-sel-count').textContent = String(selected.size);
    $('#jobs-clear').disabled = selected.size === 0;
    $('#jobs-rerun').disabled = ![...selected.values()].some((status) => ['failed', 'dead', 'cancelled'].includes(status));
    const boxes = [...document.querySelectorAll('[data-job-sel]')];
    const header = $('#jobs-sel-all');
    if (header) {
      const allOn = boxes.length > 0 && boxes.every((box) => box.classList.contains('on'));
      header.classList.toggle('on', allOn);
      header.innerHTML = allOn ? icon('check', 10) : '';
    }
  };
  $('#jobs-clear').addEventListener('click', async () => {
    const ids = [...selected.keys()];
    if (ids.length === 0) return;
    const ok = await confirmAction({
      title: `清除 ${ids.length} 条历史任务？`,
      sub: ids.slice(0, 3).join(' · ') + (ids.length > 3 ? ' …' : ''),
      body: '仅删除已完成 / 失败 / 取消的历史任务记录；运行中与排队中的任务自动跳过。审计保留清除记录。',
      impact: ids.slice(0, 4).map((id) => `${id} → 删除`),
      confirmLabel: '确认清除',
      danger: true,
    });
    if (!ok) return;
    try {
      const result = await api('/api/jobs/clear', { method: 'POST', body: JSON.stringify({ ids }) });
      toast('ok', '已清除历史任务', `删除 ${result.removed} 条${result.removed < result.requested ? `（跳过 ${result.requested - result.removed} 条运行中 / 排队）` : ''}`, '查看审计');
      renderSystem();
    } catch (error) { toast('danger', '清除失败', error.message); }
  });
  $('#jobs-rerun').addEventListener('click', async () => {
    const ids = [...selected.keys()];
    if (ids.length === 0) return;
    try {
      const result = await api('/api/jobs/rerun', { method: 'POST', body: JSON.stringify({ ids }) });
      toast('ok', '已重排失败任务', `${result.queued} 个任务重新入队${result.queued < result.requested ? `（${result.requested - result.queued} 条非失败状态跳过）` : ''}`, '查看审计');
      renderSystem();
    } catch (error) { toast('danger', '重跑失败', error.message); }
  });
  listenPage(async (event) => {
    if (pagerClick(event, 'jobs', jlimit, renderSystem)) return;
    const filter = event.target.closest('[data-job-filter]');
    if (filter) {
      PAGER.jobsStatus = filter.dataset.jobFilter;
      PAGER.jobs = 0;
      renderSystem();
      return;
    }
    const selAll = event.target.closest('#jobs-sel-all');
    if (selAll) {
      const boxes = [...document.querySelectorAll('[data-job-sel]')];
      const shouldOn = !boxes.every((box) => box.classList.contains('on'));
      boxes.forEach((box) => {
        box.classList.toggle('on', shouldOn);
        box.innerHTML = shouldOn ? icon('check', 10) : '';
        if (shouldOn) selected.set(box.dataset.jobSel, box.dataset.jobStatus);
        else selected.delete(box.dataset.jobSel);
      });
      refreshJobsBar();
      return;
    }
    const sel = event.target.closest('[data-job-sel]');
    if (sel) {
      sel.classList.toggle('on');
      sel.innerHTML = sel.classList.contains('on') ? icon('check', 10) : '';
      if (sel.classList.contains('on')) selected.set(sel.dataset.jobSel, sel.dataset.jobStatus);
      else selected.delete(sel.dataset.jobSel);
      refreshJobsBar();
      return;
    }
    const btn = event.target.closest('[data-retry]');
    if (!btn) return;
    try {
      const result = await api(`/api/jobs/${btn.dataset.retry}/retry`, { method: 'POST', body: '{}' });
      toast('ok', '已写入审计', `actor=web · job.retry → ${result.nextId}`, '查看审计');
      renderSystem();
    } catch (error) { toast('danger', '重试失败', error.message); }
  });
  refreshJobsBar();
}

/* ---------- 页签三：高级配置 ---------- */

function renderAdvancedTab(content, cfg) {
  const initial = cfg.raw || 'schemaVersion: 4\n';
  content.innerHTML = `
    <div class="split fill-area">
      <div class="main-col" style="overflow:hidden">
        <div class="editor" style="flex:1">
          <div class="editor-head">${icon('pencil', 14, 'var(--text-muted)')}
            <span>config.yaml</span><span class="faint">高级配置 · 直接编辑配置文档</span>
            <div class="spacer"></div>
            <span class="faint" id="cfg-raw-stats">0 行</span></div>
          <div class="editor-area">
            <div class="editor-gutter" id="cfg-raw-gutter"></div>
            <textarea class="editor-text" id="cfg-raw" spellcheck="false">${esc(initial)}</textarea>
          </div>
        </div>
      </div>
      <div class="rail wide" style="overflow-y:auto">
        <div class="card">
          <h2>配置优先级</h2>
          ${kv([['1（最高）', '启动参数 override'], ['2', '环境变量 env'], ['3', 'config.yaml'], ['4（最低）', '内置默认值']])}
          <div class="small faint">高优先级会覆盖低优先级；env / 启动参数锁定的键不会被本文件覆盖。</div>
        </div>
        <div class="card">
          <h2>环境变量速查</h2>
          ${ENV_SNIPPLES.map(([name, desc]) => `<div class="row" style="gap:8px;padding:4px 0"><span class="mono small" style="flex:1">${name}</span><span class="small faint">${desc}</span></div>`).join('')}
          <div class="small faint" style="margin-top:6px">⚠ API Key 等密钥只放环境变量，禁止写入本文件（校验会拦截）。</div>
        </div>
        <div class="card" id="cfg-validate-result">
          <h2>校验结果</h2>
          <div class="small faint">点击左下「校验」后在此展示解析警告与错误。</div>
        </div>
      </div>
    </div>
    <div class="save-bar">
      ${icon('info', 15, 'var(--info)')}
      <span class="small muted" style="flex:1">保存前自动备份 config.yaml.bak 并写入 config.update 审计；⚙ 后台参数需重启 daemon 生效。</span>
      <button class="btn" id="cfg-raw-reset">放弃更改</button>
      <button class="btn" id="cfg-raw-validate">校验</button>
      <button class="btn primary" id="cfg-raw-save">保存…</button>
    </div>`;

  const textarea = $('#cfg-raw');
  const gutter = $('#cfg-raw-gutter');
  const refreshGutter = () => {
    const lines = textarea.value.split('\n');
    gutter.innerHTML = lines.map((line, i) => `<div class="${SENSITIVE_RE.test(line) ? 'warn' : ''}">${i + 1}</div>`).join('');
    $('#cfg-raw-stats').textContent = `${lines.length} 行 · ${textarea.value.length} 字`;
  };
  textarea.addEventListener('input', refreshGutter);
  refreshGutter();

  const showValidation = (result) => {
    const errors = result.errors || [];
    const warnings = result.warnings || [];
    $('#cfg-validate-result').innerHTML = `
      <h2>校验结果</h2>
      ${result.ok && errors.length === 0
        ? '<div class="banner info"><span class="small">✓ 解析通过，schemaVersion 4 合法</span></div>'
        : ''}
      ${errors.map((e) => `<div class="banner danger" style="margin-top:6px"><span class="small">${esc(e)}</span></div>`).join('')}
      ${warnings.map((w) => `<div class="banner warn" style="margin-top:6px"><span class="small">${esc(w)}</span></div>`).join('')}`;
  };
  $('#cfg-raw-validate').addEventListener('click', async () => {
    try {
      showValidation(await api('/api/config/validate', { method: 'POST', body: JSON.stringify({ text: textarea.value }) }));
    } catch (error) { toast('danger', '校验失败', error.message); }
  });
  $('#cfg-raw-reset').addEventListener('click', () => renderSystem());
  $('#cfg-raw-save').addEventListener('click', async () => {
    const ok = await confirmAction({
      title: '保存配置文档？',
      body: '保存前自动备份 config.yaml.bak；内容会先经 schema 校验与敏感值扫描。',
      impact: ['覆盖写入 config.yaml', '审计新增 config.update（actor=web）', '⚙ 后台参数重启 daemon 后生效'],
      confirmLabel: '确认保存',
    });
    if (!ok) return;
    try {
      await api('/api/config/raw', { method: 'PUT', body: JSON.stringify({ text: textarea.value, reason: 'updated via web workbench (advanced)' }) });
      toast('ok', '配置文档已保存', '已备份 config.yaml.bak · 审计 config.update', '查看审计');
      PAGER.systemTab = 'advanced';
      renderSystem();
    } catch (error) {
      toast('danger', '保存失败', error.message);
      showValidation({ ok: false, errors: [error.message], warnings: [] });
    }
  });
}
