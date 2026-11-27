import { icon } from '../icons.js';
import { $, api, downloadFile, emptyState, esc, kv, pageEl, statusBadge, toast } from '../core.js';

export async function renderSearch() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const q = params.get('q') || '';
  const includeDraft = params.get('includeDraft') === 'true';
  const semantic = params.get('semantic') || 'on';
  const scopeParam = params.get('scope') || 'all';
  const scopeIdParam = params.get('scopeId') || '';
  let projectOptions = [];
  try {
    projectOptions = (await api('/api/projects')).data.items || [];
  } catch {
    projectOptions = [];
  }
  const scopeOptions = [
    ['all', '全部范围'],
    ['global', '全局（global）'],
    ...projectOptions.map((project) => [`project:${project.id}`, `项目：${project.name}`]),
  ];
  const scopeValue = scopeParam === 'global' || scopeParam === 'all' ? scopeParam : `project:${scopeIdParam}`;
  pageEl.innerHTML = `
    <div class="row">
      <div class="search-input" style="flex:1;height:48px">${icon('search', 16, 'var(--text-faint)')}
        <input id="s-q" placeholder="输入查询词，例如：sqlite 并发 锁" value="${esc(q)}" style="font-size:15px"></div>
      <select id="s-scope" class="cfg-input" style="height:48px;width:200px" title="调试台默认全部范围；Agent 侧无项目上下文时只搜 global">
        ${scopeOptions.map(([value, label]) => `<option value="${esc(value)}" ${value === scopeValue ? 'selected' : ''}>${esc(label)}</option>`).join('')}
      </select>
      <button class="btn primary" id="s-run">检索</button>
    </div>
    <div class="row">
      <span class="mono small faint">semantic_mode</span>
      ${[['off', 'off'], ['shadow', 'shadow'], ['on', 'on']].map(([t, v]) =>
    `<span class="radio ${semantic === v ? 'on' : ''}" data-semantic="${v}"><span class="ring"></span>${t}</span>`).join('')}
      <span class="tag">k: 10</span>
      <span class="tag">equal-weight RRF</span>
      <label class="row" style="gap:8px;cursor:pointer"><span class="toggle ${includeDraft ? 'on' : ''}" id="s-draft"><span class="knob"></span></span>
        <span class="mono small faint">include_draft（结果标记并降权）</span></label>
      <div class="spacer"></div>
      <span class="mono small faint" id="s-time"></span>
    </div>
    <div class="split">
      <div class="card" style="flex:1 1 480px;min-width:0">
        <div class="card-head"><h2 id="s-title">召回结果</h2><div class="spacer"></div>
          <span class="mono small faint">词法 FTS</span><span class="mono small faint">语义 SEM</span><span class="mono small faint">融合 RRF</span></div>
        <div id="s-result">${emptyState('输入查询词开始调试召回', 'search', 'var(--info)')}</div>
      </div>
      <div class="rail">
        <div class="card">
          <h2>召回解释 / TRACE</h2>
          ${kv([['请求', 'memory_search · web'], ['检索', 'FTS5（BM25 词项加权）'], ['降级', '语义不可用时自动纯词法'], ['审计', 'recall 事件可回放']])}
        </div>
        <div class="card" id="s-explain">
          <h2>纳入 / 排除</h2>
          <div class="small faint">执行检索后展示逐条原因。</div>
        </div>
        <div class="card" style="background:var(--accent-soft);border-color:var(--accent)">
          <h2>权重与降级</h2>
          <div class="small muted" style="line-height:1.6" id="s-note">equal-weight RRF（词法 0.5 / 语义 0.5）。语义不可用时自动降级纯 FTS5 并记录降级审计。include_draft 打开时结果标记并降权（×0.5）。</div>
          <button class="btn" id="s-export">导出调试 JSON</button>
        </div>
      </div>
    </div>`;

  let lastResult = null;
  const scopeParams = () => {
    const value = $('#s-scope').value;
    if (value === 'all') return { scope: 'all' };
    if (value === 'global') return { scope: 'global' };
    return { scope: 'project', scopeId: value.slice('project:'.length) };
  };
  const run = async () => {
    const query = $('#s-q').value.trim();
    if (!query) return;
    const draft = $('#s-draft').classList.contains('on');
    const sem = document.querySelector('[data-semantic].on')?.dataset.semantic || 'off';
    const searchQuery = new URLSearchParams({ q: query, semantic: sem, ...scopeParams(), ...(draft ? { includeDraft: 'true' } : {}) });
    location.hash = '#/search?' + searchQuery.toString();
    const started = performance.now();
    $('#s-result').innerHTML = '<div class="skeleton" style="width:60%"></div><div class="skeleton" style="width:80%"></div>';
    try {
      const [data, all] = await Promise.all([
        api('/api/search?' + searchQuery.toString()),
        api('/api/search?' + new URLSearchParams({ q: query, semantic: sem, ...scopeParams(), includeDraft: 'true' }).toString()),
      ]);
      lastResult = data;
      $('#s-time').textContent = `耗时 ${Math.round(performance.now() - started)}ms · ${data.semanticAvailable ? 'hybrid RRF' : 'FTS5 词法'}${data.degraded ? '（降级）' : ''}`;
      $('#s-note').textContent = `${data.note} · semantic_mode=${data.semanticMode} · semanticAvailable=${data.semanticAvailable} · scope=${data.scope}`;
      $('#s-title').textContent = `召回结果 ${data.items.length} / 候选池 ${all.items.length}`;
      const shown = new Set(data.items.map((i) => i.id));
      const excluded = all.items.filter((i) => !shown.has(i.id));
      $('#s-result').innerHTML = data.items.length === 0 ? emptyState('没有命中结果', 'search', 'var(--info)') : data.items.map((item, index) => `
        <div class="row" style="border-bottom:1px solid var(--border-soft);padding:12px 0;align-items:flex-start">
          <span class="page-btn ${index === 0 ? 'on' : ''}" style="border-radius:6px">${index + 1}</span>
          <div style="flex:1;min-width:0">
            <div class="row" style="gap:8px">
              <a href="#/memories/${esc(item.id)}"><b style="font-size:14px">${esc(item.title || item.id)}</b></a>
              ${statusBadge(item.status)}
              <span class="mono small faint">${esc(item.id)}</span>
            </div>
            ${item.summary ? `<div class="small muted" style="margin-top:4px">${esc(item.summary)}</div>` : ''}
            ${item.excerpt ? `<div class="small faint" style="margin-top:2px">${esc(item.excerpt)}${item.excerpt.length >= 160 ? '…' : ''}</div>` : ''}
            <div class="small muted" style="margin-top:4px">命中词：${esc((item.matchReason || []).join(' · ') || '—')}</div>
          </div>
          <div style="width:220px;display:flex;flex-direction:column;gap:5px">
            ${[['FTS', item.lexicalScore ?? item.score, 'var(--info)'], ['SEM', item.semanticScore ?? null, 'var(--warn)'], ['RRF', item.score, 'var(--ok)']].map(([k, v, c]) => `
              <div class="row" style="gap:6px"><span class="badge neutral" style="width:44px;justify-content:center">${k}</span>
              <div class="score-track" style="flex:1;width:auto"><span style="width:${v === null ? 0 : Math.round(Math.min(1, v) * 100)}%;background:${c}"></span></div>
              <span class="mono small faint" style="width:46px;text-align:right">${v === null ? '降级' : Number(v).toFixed(2)}</span></div>`).join('')}
          </div>
        </div>`).join('');
      $('#s-explain').innerHTML = `
        <h2>纳入 ${data.items.length} 条</h2>
        ${data.items.slice(0, 3).map((i) => `
          <div style="background:var(--accent-soft);border-radius:6px;padding:10px 12px">
            <div class="small"><b>${esc(i.title || i.id)}</b></div>
            <div class="mono small faint">${esc(i.id)}</div>
            <div class="small faint">${esc((i.matchReason || []).join(' · ') || '词法命中')} · RRF 排名 ${data.items.indexOf(i) + 1}</div>
          </div>`).join('')}
        <h2 style="margin-top:6px">排除 ${excluded.length} 条（透明可查）</h2>
        ${excluded.length === 0 ? '<div class="small faint">无排除项</div>' : excluded.slice(0, 3).map((i) => `
          <div style="background:var(--accent-soft);border-radius:6px;padding:10px 12px">
            <div class="small"><b>${esc(i.title || i.id)}</b></div>
            <div class="mono small faint">${esc(i.id)}</div>
            <div class="small faint">${i.status === 'draft' ? 'draft 未确认 —— 默认不进入召回（include_draft 可见并降权）' : '词法 / 语义相关度未进入前 k —— 见候选池对比'}</div>
          </div>`).join('')}`;
    } catch (error) {
      $('#s-result').innerHTML = `<div class="banner danger">检索失败：${esc(error.message)}</div>`;
    }
  };
  $('#s-run').addEventListener('click', run);
  $('#s-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  $('#s-scope').addEventListener('change', () => { if ($('#s-q').value.trim()) run(); });
  $('#s-draft').addEventListener('click', () => { $('#s-draft').classList.toggle('on'); });
  document.querySelectorAll('[data-semantic]').forEach((radio) => radio.addEventListener('click', () => {
    document.querySelectorAll('[data-semantic]').forEach((el) => el.classList.remove('on'));
    radio.classList.add('on');
    if ($('#s-q').value.trim()) run();
  }));
  $('#s-export').addEventListener('click', () => {
    if (!lastResult) { toast('warn', '暂无结果', '先执行一次检索'); return; }
    downloadFile('taga-search-trace.json', JSON.stringify(lastResult, null, 2), 'application/json');
    toast('ok', '已下载调试 JSON', '包含召回结果与纳入/排除说明');
  });
  if (q) run();
}

/* ---------- S9 审计与时间线 ---------- */
