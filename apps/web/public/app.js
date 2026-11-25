'use strict';

/* ---------- lucide icons ---------- */
const ICONS = {
  brain: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2"/>',
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>',
  inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  sprout: '<path d="M7 20h10"/><path d="M10 20c5.5-2.5.8-6.4 3-10"/><path d="M9.5 9.4c1.1.8 1.8 2.2 2.3 3.7-2 .4-3.5.4-4.8-.3-1.2-.6-2.3-1.9-3-4.2 2.8-.5 4.4 0 5.5.8z"/><path d="M14.1 6a7 7 0 0 0-1.1 4c1.9-.1 3.3-.6 4.3-1.4 1-1 1.6-2.3 1.7-4.6-2.7.1-4 1-4.9 2z"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  package: '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  book: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
  settings: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  circleCheck: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  circleX: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  filter: '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6M14 11v6"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  upload: '<path d="M12 13v8"/><path d="m8 17 4-4 4 4"/><path d="M20 16.6A5 5 0 0 0 18 7h-1.26A8 8 0 1 0 4 15.25"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  copy: '<rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  layers: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
};

function icon(name, size = 15, color = 'currentColor') {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
}

const state = { themes: [], defaultTheme: 'morandi', navCounts: { review: 0, garden: 0 } };
const $ = (selector) => document.querySelector(selector);
const pageEl = $('#page');

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({ ok: false, message: '响应解析失败' }));
  if (!response.ok || payload.ok !== true) throw new Error(payload.message || `请求失败 (${response.status})`);
  return payload.data;
}

/* ---------- theme ---------- */
function applyTheme(id) {
  const theme = state.themes.find((t) => t.id === id) || state.themes.find((t) => t.id === state.defaultTheme);
  if (!theme) return;
  const root = document.documentElement;
  root.setAttribute('data-theme', theme.id);
  for (const [key, value] of Object.entries(theme.colors)) {
    root.style.setProperty('--' + key.replace(/[A-Z]/g, (ch) => '-' + ch.toLowerCase()), value);
  }
  localStorage.setItem('taga.theme', theme.id);
  const label = $('#theme-dd-label');
  if (label) label.textContent = theme.name;
  const swatch = $('#theme-dd-swatch');
  if (swatch) swatch.style.background = theme.colors.accent;
  document.querySelectorAll('[data-theme-id]').forEach((item) => {
    item.classList.toggle('on', item.dataset.themeId === theme.id);
  });
}

async function initChrome() {
  const data = await api('/api/themes');
  state.themes = data.themes;
  state.defaultTheme = data.default;

  const dd = $('#theme-dd');
  const menu = $('#theme-dd-menu');
  menu.innerHTML = state.themes.map((t) => `
    <div class="theme-dd-item" data-theme-id="${esc(t.id)}" role="option">
      <span class="swatch" style="background:${esc(t.colors.accent)}"></span>
      <span class="name">${esc(t.name)}</span>
      <span class="mode">${t.mode === 'dark' ? '深色' : '浅色'}</span>
    </div>`).join('');
  $('#theme-dd-btn').addEventListener('click', (event) => {
    event.stopPropagation();
    dd.classList.toggle('open');
  });
  menu.addEventListener('click', (event) => {
    const item = event.target.closest('[data-theme-id]');
    if (!item) return;
    applyTheme(item.dataset.themeId);
    dd.classList.remove('open');
  });
  document.addEventListener('click', () => dd.classList.remove('open'));
  applyTheme(localStorage.getItem('taga.theme') || state.defaultTheme);

  const sidebar = $('#sidebar');
  const saved = localStorage.getItem('taga.sidebar');
  const shouldCollapse = saved !== null ? saved === 'collapsed' : window.innerWidth < 1100;
  sidebar.classList.toggle('collapsed', shouldCollapse);
  $('#sidebar-toggle').addEventListener('click', () => {
    const collapsed = sidebar.classList.toggle('collapsed');
    localStorage.setItem('taga.sidebar', collapsed ? 'collapsed' : 'expanded');
  });

  const searchInput = $('#top-search-input');
  const runTopSearch = () => {
    const q = searchInput.value.trim();
    if (!q) return;
    const next = '#/search?' + new URLSearchParams({ q }).toString();
    if (location.hash === next) route();
    else location.hash = next;
  };
  $('#top-search-btn').addEventListener('click', runTopSearch);
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') runTopSearch();
  });
}

/* ---------- ui atoms ---------- */
const TOAST_ROUTES = { '去审核队列': '#/review', '查看审计': '#/audit', '查看规则': '#/packs' };
function toast(kind, title, body, action) {
  const iconName = { ok: 'circleCheck', warn: 'alert', danger: 'circleX', info: 'info' }[kind] || 'info';
  const route = action ? TOAST_ROUTES[action] : undefined;
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.innerHTML = `
    ${icon(iconName, 16, `var(--${kind === 'danger' ? 'danger' : kind})`)}
    <div style="flex:1"><div class="t-title">${esc(title)}</div><div class="t-body">${esc(body)}</div></div>
    ${action ? `<span class="t-action${route ? ' clickable' : ''}">${esc(action)}</span>` : ''}
    <span class="t-close">${icon('x', 13)}</span>`;
  node.querySelector('.t-close').addEventListener('click', () => node.remove());
  if (route) {
    node.querySelector('.t-action').addEventListener('click', () => {
      node.remove();
      location.hash = route;
    });
  }
  $('#toast-root').appendChild(node);
  setTimeout(() => node.remove(), 6000);
}

function confirmAction({ title, sub = '', body = '', impact = [], confirmLabel = '确认', danger = false, typed = null }) {
  return new Promise((resolve) => {
    $('#modal-root').innerHTML = `
      <div class="modal-backdrop">
        <div class="modal">
          <div class="modal-head">
            <div class="icon-circle ${danger ? 'danger' : ''}">${icon(danger ? 'trash' : 'alert', 18)}</div>
            <div style="flex:1">
              <h3>${esc(title)}</h3>
              ${sub ? `<div class="mono small faint">${esc(sub)}</div>` : ''}
            </div>
          </div>
          <div class="small muted" style="line-height:1.6">${esc(body)}</div>
          ${impact.length ? `<div class="impact ${danger ? 'danger' : ''}">${impact.map((line) => `<div><span class="d">—</span> ${esc(line)}</div>`).join('')}</div>` : ''}
          ${typed ? `<div class="typed-input"><span class="mono small">输入 <b>${esc(typed)}</b> 以确认</span><input id="modal-typed" placeholder="${esc(typed)}" autocomplete="off"><span class="mono small faint" id="modal-count">0 / ${typed.length}</span></div>` : ''}
          <div class="actions">
            <button class="btn" id="modal-cancel">取消</button>
            <button class="btn ${danger ? 'danger' : 'primary'}" id="modal-ok" ${typed ? 'disabled' : ''}>${esc(confirmLabel)}</button>
          </div>
        </div>
      </div>`;
    const close = (result) => { $('#modal-root').innerHTML = ''; resolve(result); };
    $('#modal-cancel').addEventListener('click', () => close(false));
    $('#modal-ok').addEventListener('click', () => close(true));
    if (typed) {
      const input = $('#modal-typed');
      input.addEventListener('input', () => {
        $('#modal-ok').disabled = input.value.trim() !== typed;
        $('#modal-count').textContent = `${input.value.trim().length} / ${typed.length}`;
      });
      input.focus();
    }
  });
}

function statusBadge(status) {
  const kind = { active: 'ok', draft: 'warn', candidate: 'info', stale: 'neutral', superseded: 'neutral', forgotten: 'danger' }[status] || 'neutral';
  return `<span class="badge ${kind}"><span class="dot"></span>${esc(status)}</span>`;
}
function kv(rows) {
  return `<div class="kv">${rows.map(([k, v]) => `<div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>`).join('')}</div>`;
}
function emptyState(text, iconName = 'inbox', color = 'var(--ok)') {
  return `<div class="empty"><div class="icon-circle" style="background:var(--accent-soft);color:${color}">${icon(iconName, 20)}</div>${esc(text)}</div>`;
}
function fmtTime(value) { return String(value || '').slice(0, 19).replace('T', ' '); }

/* ---------- pagination & delegation ---------- */
const PAGER = {};
const listenPage = (handler) => { pageEl.onclick = handler; };

function pagerBar(key, total, offset, limit) {
  const pages = Math.max(1, Math.ceil(total / limit));
  const current = Math.floor(offset / limit) + 1;
  const nums = [];
  for (let p = 1; p <= pages; p += 1) {
    if (p === 1 || p === pages || Math.abs(p - current) <= 1) nums.push(p);
    else if (nums[nums.length - 1] !== '...') nums.push('...');
  }
  return `<div class="pager">
    <span class="mono small faint">显示 ${total === 0 ? 0 : offset + 1}–${Math.min(offset + limit, total)} / ${total}</span>
    <div class="spacer"></div>
    <span class="page-btn" data-pager="${key}" data-page="${current - 1}" ${current <= 1 ? 'disabled' : ''}>‹</span>
    ${nums.map((p) => p === '...'
      ? '<span class="page-btn" style="border:none">…</span>'
      : `<span class="page-btn ${p === current ? 'on' : ''}" data-pager="${key}" data-page="${p}">${p}</span>`).join('')}
    <span class="page-btn" data-pager="${key}" data-page="${current + 1}" ${current >= pages ? 'disabled' : ''}>›</span>
  </div>`;
}

function pagerClick(event, key, limit, rerender) {
  const btn = event.target.closest(`[data-pager="${key}"]`);
  if (!btn || btn.hasAttribute('disabled')) return false;
  PAGER[key] = (Number(btn.dataset.page) - 1) * limit;
  rerender();
  return true;
}

function downloadFile(name, content, mime) {
  const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function diffLines(oldText, newText) {
  const oldLines = String(oldText ?? '').split('\n');
  const newLines = String(newText ?? '').split('\n');
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
  let endOld = oldLines.length - 1;
  let endNew = newLines.length - 1;
  while (endOld >= start && endNew >= start && oldLines[endOld] === newLines[endNew]) { endOld -= 1; endNew -= 1; }
  const rows = [];
  for (let i = 0; i < start; i += 1) rows.push(['same', oldLines[i]]);
  for (let i = start; i <= endOld; i += 1) rows.push(['-', oldLines[i]]);
  for (let i = start; i <= endNew; i += 1) rows.push(['+', newLines[i]]);
  for (let i = endNew + 1; i < newLines.length; i += 1) rows.push(['same', newLines[i]]);
  return rows;
}

/* ---------- S1 概览 ---------- */
async function renderOverview() {
  const [data, garden] = await Promise.all([api('/api/overview'), api('/api/garden').catch(() => ({ proposals: [] }))]);
  const pendingGarden = garden.proposals.filter((p) => p.status === 'pending').length;
  const recallCount = data.audit.recent.filter((e) => e.eventType.includes('recall')).length;
  setNavCounts(data.reviewBacklogCount, pendingGarden);
  const s = data.summary;
  const health = [
    ['SQLite / 完整性', 'ok', 'ok', 'circleCheck'],
    ['FTS5 索引', 'ok', 'ok', 'circleCheck'],
    ['索引漂移', data.index.drift ? 'drifted' : 'clean', data.index.drift ? 'warn' : 'ok', data.index.drift ? 'alert' : 'circleCheck'],
    ['语义索引', '未接入 Web', 'info', 'info'],
    ['Zvec 运行时', '未配置', 'info', 'info'],
    ['daemon', '运行中', 'ok', 'circleCheck'],
    ['Jobs', `${data.jobs.total} 个`, data.jobs.dead + data.jobs.failed > 0 ? 'danger' : 'ok', data.jobs.dead + data.jobs.failed > 0 ? 'circleX' : 'circleCheck'],
    ['恢复流程', '干净', 'ok', 'circleCheck'],
  ];
  const okCount = health.filter((h) => h[2] === 'ok').length;
  pageEl.innerHTML = `
    <div class="row">
      <div style="display:flex;flex-direction:column;gap:6px">
        <h1 style="font-size:26px;font-weight:700">Brain 总览</h1>
        <div class="small faint">本地优先 · 所有写操作留审计 · 未确认记忆不进入召回</div>
      </div>
      <div class="spacer"></div>
      <button class="btn" id="export-report">导出报告</button>
      <a class="btn primary" href="#/memories/new">新建记忆</a>
    </div>
    <div class="grid cols-4">
      ${[
        ['记忆总数', s.total ?? 0, `+${data.index.memories} markdown · active ${s.byStatus?.active ?? 0}`, 'var(--ok)'],
        ['待审核', data.reviewBacklogCount, `draft ${s.byStatus?.draft ?? 0} · candidate ${s.byStatus?.candidate ?? 0}`, 'var(--warn)'],
        ['花园提案', pendingGarden, '由 daemon 整合与人工扫描生成', 'var(--text-muted)'],
        ['今日召回', recallCount, 'audit · recall 事件', 'var(--info)'],
      ].map(([label, value, note, color]) => `
        <div class="stat"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div>
        <div class="note" style="color:${color}">${esc(note)}</div></div>`).join('')}
    </div>
    <div class="card">
      <div class="card-head"><h2>运行健康 · doctor</h2><div class="spacer"></div>
        <span class="badge ok">${okCount} 项通过</span>
        <span class="badge warn">${health.length - okCount} 项需关注</span></div>
      <div class="grid cols-4">
        ${health.map(([name, status, kind, ic]) => `
          <div class="check-tile">${icon(ic, 15, `var(--${kind})`)}
            <div class="name">${esc(name)}</div>
            <div class="status" style="color:var(--${kind})">${esc(status)}</div></div>`).join('')}
      </div>
    </div>
    <div class="grid cols-2" style="align-items:stretch">
      <div class="card" style="height:100%">
        <div class="card-head"><h2>待审核队列</h2><div class="spacer"></div>
          ${data.reviewBacklogCount ? `<span class="badge warn">${data.reviewBacklogCount} 待处理</span>` : ''}</div>
        ${data.reviewBacklog.length === 0 ? emptyState('审核队列已清空') : data.reviewBacklog.map((item) => `
          <div class="row" style="border-bottom:1px solid var(--border-soft);padding:10px 0">
            <span class="checkbox"></span>
            <div style="flex:1"><a href="#/memories/${esc(item.id)}" class="small"><b>${esc(item.title)}</b></a>
              <div class="mono faint" style="font-size:11px">${esc(item.id)} · ${esc(item.status)} · ${esc(item.type)} · ${fmtTime(item.updated)}</div></div>
            <button class="btn small" data-quick="promote" data-id="${esc(item.id)}">确认</button>
            <button class="btn danger-ghost small" data-quick="forget" data-id="${esc(item.id)}">丢弃</button>
          </div>`).join('')}
      </div>
      <div class="card" style="height:100%">
        <div class="card-head"><h2>最近审计</h2><div class="spacer"></div><a class="small" style="color:var(--warn)" href="#/audit">查看全部 →</a></div>
        <div class="timeline">
          ${data.audit.recent.map((r) => `
            <div class="tl-item" style="padding:10px 0">
              <div class="time">${fmtTime(r.occurredAt).slice(5)}</div>
              <div class="desc" style="display:flex;gap:8px;align-items:center">
                <span class="badge accent">${esc(r.actor)}${r.actorId ? '/' + esc(r.actorId) : ''}</span>
                <span class="mono" style="color:var(--text)">${esc(r.eventType)}</span>
                <span class="mono faint">${esc(r.subjectId)}</span>
              </div>
            </div>`).join('')}
        </div>
      </div>
    </div>`;
  $('#export-report').addEventListener('click', () => {
    downloadFile('taga-overview.json', JSON.stringify(data, null, 2), 'application/json');
    toast('ok', '已下载概览报告', `审计 ${data.audit.total} 条 · 记忆 ${data.index.memories} 条`);
  });
  listenPage( async (event) => {
    const btn = event.target.closest('button[data-quick]');
    if (!btn) return;
    try {
      if (btn.dataset.quick === 'promote') {
        await api(`/api/memories/${btn.dataset.id}/transition`, { method: 'POST', body: JSON.stringify({ type: 'activate', reason: 'promoted via web workbench' }) });
        toast('ok', '已写入审计', `actor=web · lifecycle.activate · ${btn.dataset.id}`, '查看审计');
        renderOverview();
      } else {
        const ok = await confirmAction({
          title: '确认丢弃这条候选记忆？', sub: btn.dataset.id,
          body: '丢弃等同遗忘：退出召回并保留审计。此操作需要输入式确认。',
          impact: [`target: ${btn.dataset.id}`, 'status → forgotten', '审计新增 lifecycle.forget（actor=web）'],
          confirmLabel: '确认丢弃', danger: true, typed: 'FORGET',
        });
        if (!ok) return;
        await api(`/api/memories/${btn.dataset.id}/transition`, { method: 'POST', body: JSON.stringify({ type: 'forget', confirm: true, reason: 'discarded via web workbench' }) });
        toast('ok', '已丢弃', `actor=web · lifecycle.forget · ${btn.dataset.id}`, '查看审计');
        renderOverview();
      }
    } catch (error) { toast('danger', '操作失败', error.message); }
  });
}

function setNavCounts(review, garden) {
  state.navCounts = { review, garden };
  $('#nav-review-count').textContent = review > 0 ? String(review) : '';
  $('#nav-garden-count').textContent = garden > 0 ? String(garden) : '';
}

/* ---------- S2 记忆库 ---------- */
const TYPE_OPTIONS = ['preferences', 'environment', 'procedures', 'lessons', 'projects'];
const STATUS_OPTIONS = ['draft', 'candidate', 'active', 'stale', 'superseded', 'forgotten'];

async function renderMemories() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const type = params.get('type') || '';
  const status = params.get('status') || '';
  const q = params.get('q') || '';
  const offset = Math.max(0, Number(params.get('offset') || '0') || 0);
  const query = new URLSearchParams({ limit: '25', offset: String(offset) });
  if (type) query.set('type', type);
  if (status) query.set('status', status);
  if (q) query.set('q', q);
  const data = await api('/api/memories?' + query.toString());
  const counts = {};
  for (const key of [...TYPE_OPTIONS, ...STATUS_OPTIONS]) counts[key] = '';
  pageEl.innerHTML = `
    <div class="split">
      <div class="card filter-panel">
        <div class="card-head">${icon('filter', 14, 'var(--text-muted)')}<h2>筛选</h2><div class="spacer"></div>
          <span class="small faint" style="cursor:pointer" id="filter-reset">重置</span></div>
        <div style="display:flex;flex-direction:column;gap:9px">
          <div class="eyebrow">类型</div>
          ${TYPE_OPTIONS.map((t) => filterRow('type', t, type === t)).join('')}
        </div>
        <div style="display:flex;flex-direction:column;gap:9px">
          <div class="eyebrow">状态</div>
          ${STATUS_OPTIONS.map((t) => filterRow('status', t, status === t)).join('')}
        </div>
        <div style="display:flex;flex-direction:column;gap:9px">
          <div class="eyebrow">范围</div>
          <div class="row" style="gap:8px">
            ${['global', 'domain', 'project'].map((t) => `<span class="chip ${params.get('scope') === t ? 'on' : ''}" data-scope="${t}">${t}</span>`).join('')}
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:9px">
          <div class="eyebrow">项目</div>
          <div class="select-lite">taga · ivenlau/taga ${icon('chevronDown', 13, 'var(--text-faint)')}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:9px">
          <div class="eyebrow">时间</div>
          <div class="select-lite">最近 30 天 ${icon('chevronDown', 13, 'var(--text-faint)')}</div>
        </div>
      </div>
      <div class="main-col">
        <div class="row">
          <div class="search-input" style="flex:1">${icon('search', 15, 'var(--text-faint)')}
            <input id="mem-q" placeholder="搜索记忆内容、ID、标签…（支持语义检索）" value="${esc(q)}"></div>
          <div class="select-lite">更新时间 ↓ ${icon('chevronDown', 13, 'var(--text-faint)')}</div>
          <a class="btn primary" href="#/memories/new">新建记忆</a>
        </div>
        <div class="row">
          ${type ? `<span class="chip on">状态: ${esc(type)} ×</span>` : ''}
          ${status ? `<span class="chip on">状态: ${esc(status)} ×</span>` : ''}
          <span class="chip">共命中 ${data.total} 条</span>
          <span class="small faint" style="cursor:pointer" id="clear-all">清除全部</span>
        </div>
        <div class="table" style="flex:1">
          <table>
            <thead><tr>
              <th></th><th class="mono">记忆 ID</th><th class="mono">摘要 / 内容</th><th class="mono">类型</th>
              <th class="mono">状态</th><th class="mono">范围</th><th class="mono">有用/无用</th><th class="mono">更新</th><th></th>
            </tr></thead>
            <tbody>
              ${data.items.length === 0 ? `<tr><td colspan="9">${emptyState('没有匹配的记忆')}</td></tr>` : data.items.map((m) => `
                <tr onclick="location.hash='#/memories/${esc(m.id)}'">
                  <td><span class="checkbox"></span></td>
                  <td class="mono">${esc(m.id)}</td>
                  <td><b>${esc(m.title)}</b><br><span class="small muted">${esc(m.summary)}</span></td>
                  <td class="mono faint">${esc(m.type)}</td>
                  <td>${statusBadge(m.status)}</td>
                  <td class="mono faint">${esc(m.scope?.kind)}${m.scope?.id ? ':' + esc(m.scope.id) : ''}</td>
                  <td class="mono">${m.usefulCount ?? 0} / ${m.notUsefulCount ?? 0}</td>
                  <td class="mono faint">${esc((m.updated || '').slice(0, 10))}</td>
                  <td>${icon('more', 16, 'var(--text-faint)')}</td>
                </tr>`).join('')}
            </tbody>
          </table>
          ${pagerBar('memories', data.total, data.offset ?? offset, data.limit ?? 25)}
        </div>
      </div>
    </div>`;
  const go = (next) => { location.hash = '#/memories' + (next.toString() ? '?' + next.toString() : ''); };
  const build = () => {
    const next = new URLSearchParams();
    const activeType = document.querySelector('[data-filter="type"].on');
    const activeStatus = document.querySelector('[data-filter="status"].on');
    if (activeType) next.set('type', activeType.dataset.value);
    if (activeStatus) next.set('status', activeStatus.dataset.value);
    if ($('#mem-q').value) next.set('q', $('#mem-q').value);
    return next;
  };
  listenPage( (event) => {
    const row = event.target.closest('[data-filter]');
    if (row) {
      const group = row.dataset.filter;
      const wasOn = row.classList.contains('on');
      document.querySelectorAll(`[data-filter="${group}"]`).forEach((el) => el.classList.remove('on'));
      if (!wasOn) row.classList.add('on');
      go(build());
      return;
    }
    if (event.target.closest('#filter-reset') || event.target.closest('#clear-all')) { go(new URLSearchParams()); }
    const scope = event.target.closest('[data-scope]');
    if (scope) {
      const next = build();
      next.set('scope', scope.dataset.scope);
      go(next);
      return;
    }
    const pg = event.target.closest('[data-pager="memories"]');
    if (pg && !pg.hasAttribute('disabled')) {
      const next = build();
      const page = Number(pg.dataset.page);
      if (page > 1) next.set('offset', String((page - 1) * 25));
      go(next);
    }
  });
  $('#mem-q').addEventListener('keydown', (event) => { if (event.key === 'Enter') go(build()); });
}

function filterRow(group, value, on) {
  return `<div class="checkbox-row" data-filter="${group}" data-value="${value}" style="cursor:pointer">
    <span class="checkbox ${on ? 'on' : ''}">${on ? icon('check', 10) : ''}</span>
    <span class="mono small" style="flex:1;color:var(--text)">${value}</span></div>`;
}

/* ---------- S3 记忆详情 ---------- */
async function renderDetail(id) {
  const data = await api('/api/memories/' + encodeURIComponent(id));
  const m = data.memory;
  const body = data.body ?? '';
  const canPromote = m.status === 'draft' || m.status === 'candidate';
  const canStale = m.status === 'active';
  const canRefresh = m.status === 'stale';
  const forgotten = m.status === 'forgotten';
  const audit = data.audit || [];
  pageEl.innerHTML = `
    <div class="card">
      <div class="row">
        <span class="mono" style="background:var(--input);padding:4px 10px;border-radius:6px;font-size:12px">${esc(m.id)}</span>
        ${statusBadge(m.status)}
        <span class="tag">scope: ${esc(m.scope?.kind)}${m.scope?.id ? ':' + esc(m.scope.id) : ''}</span>
        <span class="tag">type: ${esc(m.type)}</span>
        ${m.projectId ? `<span class="tag">project: ${esc(m.projectId)}</span>` : ''}
        <div class="spacer"></div>
        <span class="badge info">可回滚</span>
      </div>
      <h2 style="font-size:22px;font-weight:700">${esc(m.title)}</h2>
      <div class="mono small faint">创建 ${fmtTime(m.created)} · 更新 ${fmtTime(m.updated)} · content-hash ${esc((m.contentHash || '').slice(0, 10))}… · sourceTrust ${esc(m.sourceTrust)}</div>
      <div class="row">
        <a class="btn" href="#/memories/${esc(m.id)}/edit">${icon('pencil', 14)}编辑</a>
        ${canStale ? `<button class="btn" data-act="stale">标记 stale</button>` : ''}
        ${canRefresh ? `<button class="btn primary" data-act="refresh">刷新为 active</button>` : ''}
        <button class="btn" data-act="fb-useful">反馈 · 有用</button>
        <div class="spacer"></div>
        ${canPromote ? `<button class="btn primary" data-act="promote">确认晋升为 active</button>` : ''}
        ${forgotten ? '' : `<button class="btn danger-ghost" data-act="forget">${icon('trash', 14)}遗忘…</button>`}
      </div>
    </div>
    <div class="tabs">
      ${['内容', '时间线', `审计 ${audit.length}`, '召回记录'].map((t, i) => `<span class="tab ${i === 0 ? 'on' : ''}" data-tab="${i}">${t}</span>`).join('')}
    </div>
    <div class="split">
      <div class="main-col" id="detail-tab-content">
        <div class="card">
          <div class="mono" style="font-size:15px;font-weight:700;color:var(--text)"># ${esc(m.title)}</div>
          <div class="small muted" style="line-height:1.7">${esc(m.summary)}</div>
          <div class="code-block">${esc(body)}</div>
          <div class="frontmatter">
            <div class="eyebrow">frontmatter（Markdown 事实源）</div>
            <div>id: ${esc(m.id)}</div>
            <div>type: ${esc(m.type)}    status: ${esc(m.status)}    scope: ${esc(m.scope?.kind)}</div>
            <div>created: ${esc(m.created)}    hash: ${esc((m.contentHash || '').slice(0, 12))}</div>
          </div>
        </div>
      </div>
      <div class="rail">
        <div class="card">
          <h2>元数据</h2>
          ${kv([
            ['type', m.type], ['status', m.status], ['scope', `${m.scope?.kind}${m.scope?.id ? ':' + m.scope.id : ''}`],
            ['project', m.projectId || '—'], ['use_count', String((m.usefulCount ?? 0) + (m.notUsefulCount ?? 0))],
            ['useful / not_useful', `${m.usefulCount ?? 0} / ${m.notUsefulCount ?? 0}`],
            ['sourceTrust', m.sourceTrust], ['visibility', m.visibility],
            ['tags', (m.tags || []).join(', ') || '—'], ['supersedes', m.supersedes || '—'],
          ])}
        </div>
        <div class="card">
          <h2>生命周期</h2>
          <div style="display:flex;flex-direction:column">
            ${audit.slice(0, 5).map((r) => `
              <div class="row" style="align-items:flex-start;gap:10px">
                <div class="tl-dots"><span class="dot" style="background:var(--accent)"></span><div class="tl-stem"></div></div>
                <div style="flex:1;padding-bottom:10px">
                  <div class="mono small faint">${fmtTime(r.occurredAt).slice(0, 16)}</div>
                  <div class="small" style="color:var(--text)">${esc(r.eventType)} · ${esc(r.actor)}</div>
                </div>
              </div>`).join('')}
          </div>
        </div>
        <div class="card">
          <h2>反馈</h2>
          ${kv([['useful', String(m.usefulCount ?? 0)], ['not_useful', String(m.notUsefulCount ?? 0)], ['review', String(m.reviewCount ?? 0)]])}
          <div class="banner info">反馈影响 confidence 与整合裁决，全部写入审计。</div>
        </div>
        <div class="card">
          <h2>整合判定 · consolidation</h2>
          ${data.dedup ? `
            <div class="row">
              <span class="badge ${data.dedup.verdict === 'merge' ? 'warn' : data.dedup.verdict === 'duplicate' ? 'danger' : 'ok'}"><span class="dot"></span>verdict: ${esc(String(data.dedup.verdict))}</span>
              ${data.dedup.score !== undefined ? `<span class="mono small faint">score ${Number(data.dedup.score).toFixed(3)}</span>` : ''}
              ${data.dedup.bestMatchId ? `<a class="mono small" style="color:var(--warn)" href="#/memories/${esc(String(data.dedup.bestMatchId))}">best match: ${esc(String(data.dedup.bestMatchId))}</a>` : ''}
            </div>
            ${data.dedup.mergedText ? `
              <div class="eyebrow">LLM 合并建议（mimo）</div>
              <div class="code-block" style="font-size:11px">${esc(String(data.dedup.mergedText))}</div>` : ''}
            <div class="small faint">0.95+ 判重（确定性）；0.88–0.95 由 LLM 裁决 merge / keep 并生成合并建议。</div>
          ` : '<div class="small faint">暂无整合判定 · draft 与 active 比对后由 daemon 记录。</div>'}
        </div>
        <div class="card">
          <h2>关联记忆</h2>
          ${(data.related || []).length === 0 ? '<div class="small faint">暂无词法相关记忆</div>' : (data.related || []).map((rel) => `
            <div class="row" style="border-bottom:1px solid var(--border-soft);padding:8px 0">
              <div style="flex:1">
                <a class="mono small" href="#/memories/${esc(rel.id)}">${esc(rel.id)}</a>
                <div class="small faint">${esc((rel.reason || []).join(' · '))}</div>
              </div>
              <span class="mono small" style="color:var(--warn)">${Number(rel.score).toFixed(2)}</span>
            </div>`).join('')}
          <div class="small faint">基于词法相关性；语义相似度随语义检索卡接入。</div>
        </div>
      </div>
    </div>`;

  pageEl.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
    pageEl.querySelectorAll('.tab').forEach((t) => t.classList.remove('on'));
    tab.classList.add('on');
    const idx = tab.dataset.tab;
    const content = $('#detail-tab-content');
    if (idx === '0') return renderDetail(id);
    if (idx === '1' || idx === '2') {
      content.innerHTML = `<div class="card"><h2>${idx === '1' ? '时间线' : '审计记录'}</h2><div class="timeline">
        ${audit.length === 0 ? emptyState('暂无审计事件') : audit.map((r) => `
          <div class="tl-item"><div class="time">${fmtTime(r.occurredAt)}</div>
          <div class="desc"><b>${esc(r.eventType)}</b> · ${esc(r.actor)}${r.actorId ? '/' + esc(r.actorId) : ''}<br>
          <span class="faint">${esc(r.reason)} · hash ${esc(r.eventHash)}</span></div></div>`).join('')}
      </div></div>`;
    } else {
      const recalls = audit.filter((r) => /recall|shadow|context/i.test(r.eventType));
      content.innerHTML = `<div class="card">
        <h2>召回记录</h2>
        ${kv([['lastRecalled', m.lastRecalled ? fmtTime(m.lastRecalled) : '—'], ['召回事件', String(recalls.length)]])}
        ${recalls.length === 0 ? emptyState('暂无召回事件 · memory_search 命中后会记录 recall 审计', 'search', 'var(--info)') : `
        <div class="timeline">
          ${recalls.map((r) => `
            <div class="tl-item"><div class="time">${fmtTime(r.occurredAt)}</div>
            <div class="desc"><b>${esc(r.eventType)}</b> · ${esc(r.actor)}<br>
            <span class="faint">${esc(r.reason)}${Object.keys(r.payload || {}).length ? ' · ' + esc(JSON.stringify(r.payload).slice(0, 120)) : ''}</span></div></div>`).join('')}
        </div>`}
        <div class="banner info">召回轨迹与 S7 搜索调试、S8 Context Pack 的纳入决策互相印证；完整 trace 可在审计页按 subject 过滤。</div>
      </div>`;
    }
  }));

  listenPage( async (event) => {
    const btn = event.target.closest('button[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    try {
      if (act === 'forget') {
        const ok = await confirmAction({
          title: '确认遗忘这条记忆？', sub: `${m.id} · ${m.title}`,
          body: '该记忆将标记为 forgotten 并退出所有默认召回；Markdown 归档保留，审计事件完整记录。此操作需要输入式确认。',
          impact: [`status：${m.status} → forgotten`, '退出 Context Pack 与搜索召回', '审计新增 lifecycle.forget（actor=web）', '可从归档恢复，但需重新确认启用'],
          confirmLabel: '确认遗忘', danger: true, typed: 'FORGET',
        });
        if (!ok) return;
        await api(`/api/memories/${id}/transition`, { method: 'POST', body: JSON.stringify({ type: 'forget', confirm: true, reason: 'forgotten via web workbench' }) });
        toast('ok', '已写入审计', `actor=web · lifecycle.forget · ${id}`, '查看审计');
      } else if (act === 'promote' || act === 'stale' || act === 'refresh') {
        const type = { promote: 'activate', stale: 'mark_stale', refresh: 'refresh' }[act];
        await api(`/api/memories/${id}/transition`, { method: 'POST', body: JSON.stringify({ type, reason: `${type} via web workbench` }) });
        toast('ok', '已写入审计', `actor=web · lifecycle.${type} · ${id}`, '查看审计');
      } else if (act.startsWith('fb-')) {
        const kind = act === 'fb-useful' ? 'useful' : 'not_useful';
        await api(`/api/memories/${id}/feedback`, { method: 'POST', body: JSON.stringify({ kind, note: `${kind} via web workbench` }) });
        toast('ok', '反馈已记录', `actor=web · feedback.${kind} · ${id}`, '查看审计');
      }
      renderDetail(id);
    } catch (error) { toast('danger', '操作失败', error.message); }
  });
}

/* ---------- S4 记忆编辑 ---------- */
const SENSITIVE_RE = /(api[_-]?key|secret|token)\s*[:=]|sk-[A-Za-z0-9]{8,}/i;

async function renderEdit(id) {
  const isNew = id === null;
  const data = isNew ? null : await api('/api/memories/' + encodeURIComponent(id));
  const m = data ? data.memory : null;
  const needsConfirm = m && (m.status === 'active' || m.status === 'stale');
  const initBody = data?.body || '';
  pageEl.innerHTML = `
    <div class="banner warn" id="sensitive-banner" style="display:none">
      ${icon('alert', 16, 'var(--danger)')}
      <div style="flex:1"><b>已阻止保存：检测到疑似敏感值</b><br>
      <span class="small">内容命中内置脱敏规则（token / API Key 模式）。请移除密钥后重试；Taga 不会把敏感值写入 Markdown、SQLite、日志或审计。</span></div>
      <button class="btn small">查看规则</button>
    </div>
    <div class="split">
      <div class="main-col">
        <div class="editor">
          <div class="editor-head">${icon('pencil', 14, 'var(--text-muted)')}
            <span>${isNew ? 'mem_new.md' : esc(id) + '.md'}</span>
            <span class="faint">Markdown 事实源</span>
            <div class="spacer"></div>
            <span class="faint" id="editor-stats">0 行</span>
          </div>
          <div class="editor-area">
            <div class="editor-gutter" id="editor-gutter"></div>
            <textarea class="editor-text" id="f-body" spellcheck="false">${esc(initBody)}</textarea>
          </div>
        </div>
        <div class="card" id="diff-card" style="display:none">
          <div class="card-head"><h2>变更预览（−/+ 行 diff）</h2><div class="spacer"></div>
            <span class="mono small faint" id="diff-stats"></span></div>
          <div class="code-block" id="diff-body" style="max-height:260px;overflow-y:auto"></div>
        </div>
        <div class="save-bar">
          ${icon('info', 15, 'var(--info)')}
          <span class="small muted" style="flex:1">${needsConfirm
            ? '改写 active 记忆需要二次确认，保存将写入审计（actor=web）并保留可回滚的历史版本。'
            : '保存写入 Markdown 事实源并同步派生索引；draft 确认后才进入召回。'}</span>
          <a class="btn" href="${isNew ? '#/memories' : '#/memories/' + esc(id)}">取消</a>
          <button class="btn" id="f-save">保存草稿</button>
          <button class="btn primary" id="f-submit">${needsConfirm ? '提交更改…' : '提交更改'}</button>
        </div>
      </div>
      <div class="rail">
        <div class="card">
          <h2>保存前校验</h2>
          ${[['frontmatter 完整', '通过', 'ok', 'circleCheck'], ['ID 保持不变', isNew ? '生成新 ID' : '通过', 'ok', 'circleCheck'],
      ['敏感值扫描', '扫描中…', 'ok', 'circleCheck'], ['长度 0 / 2000', '通过', 'ok', 'circleCheck']]
      .map(([name, status, kind, ic]) => `
            <div class="row" id="val-${name.replace(/\s/g, '')}">${icon(ic, 14, `var(--${kind})`)}
              <span class="small" style="flex:1">${name}</span>
              <span class="mono small" style="color:var(--${kind})">${status}</span></div>`).join('')}
        </div>
        <div class="card">
          <h2>元数据</h2>
          <label class="field">type
            <select id="f-type">${TYPE_OPTIONS.map((t) => `<option ${t === m?.type ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
          <label class="field">status
            <input value="${esc(m?.status || 'draft')}（改写需确认）" disabled style="opacity:.6"></label>
          <label class="field">scope
            <select id="f-scope">${['global', 'domain', 'project'].map((t) => `<option ${t === m?.scope?.kind ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
          <label class="field">scope id<input id="f-scope-id" value="${esc(m?.scope?.id || '')}" placeholder="domain / project 时必填"></label>
          <label class="field">title<input id="f-title" value="${esc(m?.title || '')}"></label>
          <label class="field">summary<textarea id="f-summary" style="min-height:64px">${esc(m?.summary || '')}</textarea></label>
          <label class="field">变更原因（写入审计）<input id="f-reason" placeholder="why this change"></label>
        </div>
        <div class="card" style="background:var(--accent-soft);border-color:var(--accent)">
          <h2>保存影响说明</h2>
          <div class="bullet-row"><span class="d">—</span>写入 Markdown 事实源并同步派生索引</div>
          <div class="bullet-row"><span class="d">—</span>审计新增 memory.update（actor=web）</div>
          <div class="bullet-row"><span class="d">—</span>保留旧版本，可从时间线回滚</div>
          ${needsConfirm ? '<div class="bullet-row"><span class="d">—</span>提交后弹出二次确认</div>' : ''}
        </div>
      </div>
    </div>`;

  const gutter = $('#editor-gutter');
  const textarea = $('#f-body');
  const originalBody = initBody;
  const refreshDiff = () => {
    const rows = diffLines(originalBody, textarea.value);
    const changed = rows.some(([kind]) => kind !== 'same');
    $('#diff-card').style.display = changed ? 'flex' : 'none';
    if (!changed) return;
    const adds = rows.filter(([kind]) => kind === '+').length;
    const dels = rows.filter(([kind]) => kind === '-').length;
    $('#diff-stats').textContent = `+${adds} / -${dels} 行`;
    $('#diff-body').innerHTML = rows.map(([kind, line]) => {
      const color = kind === '+' ? 'var(--ok)' : kind === '-' ? 'var(--danger)' : 'var(--text-faint)';
      return `<div style="color:${color}">${kind === 'same' ? '&nbsp;&nbsp;' : kind} ${esc(line)}</div>`;
    }).join('');
  };
  const refreshGutter = () => {
    const lines = textarea.value.split('\n');
    gutter.innerHTML = lines.map((line, i) => `<div class="${SENSITIVE_RE.test(line) ? 'warn' : ''}">${i + 1}</div>`).join('');
    $('#editor-stats').textContent = `${lines.length} 行 · ${textarea.value.length} 字`;
    const hit = SENSITIVE_RE.test(textarea.value) || SENSITIVE_RE.test($('#f-summary')?.value || '');
    $('#sensitive-banner').style.display = hit ? 'flex' : 'none';
    refreshDiff();
  };
  textarea.addEventListener('input', refreshGutter);
  refreshGutter();

  const submit = async (asDraft) => {
    const content = textarea.value;
    if (SENSITIVE_RE.test(content) || SENSITIVE_RE.test($('#f-summary').value)) {
      toast('danger', '已阻止保存', '检测到疑似敏感值，内容未持久化', '查看规则');
      return;
    }
    const scopeKind = $('#f-scope').value;
    const payload = {
      type: $('#f-type').value,
      scope: { kind: scopeKind, ...(scopeKind === 'global' ? {} : { id: $('#f-scope-id').value || 'default' }) },
      title: $('#f-title').value.trim() || '未命名记忆',
      summary: $('#f-summary').value.trim() || $('#f-title').value.trim() || '未命名记忆',
      body: content,
      reason: $('#f-reason').value.trim() || undefined,
      ...(needsConfirm && !asDraft ? { confirm: true } : {}),
    };
    if (needsConfirm && !asDraft) {
      const diffRows = diffLines(originalBody, content);
      const adds = diffRows.filter(([kind]) => kind === '+').length;
      const dels = diffRows.filter(([kind]) => kind === '-').length;
      const ok = await confirmAction({
        title: '确认改写 active 记忆？', sub: `${id} · ${payload.title}`,
        body: '改写会生成新版本并 supersede 旧记忆，写入审计并保留历史版本，可从时间线回滚。',
        impact: [`内容变更 +${adds} / -${dels} 行`, '- 内容与元数据变更生成新 draft', '+ 旧版本标记 superseded', '审计新增 memory.superseded + memory.created（actor=web）'],
        confirmLabel: '确认提交',
      });
      if (!ok) return;
    }
    try {
      const result = isNew
        ? await api('/api/memories', { method: 'POST', body: JSON.stringify(payload) })
        : await api('/api/memories/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify(payload) });
      toast('ok', '已写入审计', `actor=web · ${isNew ? 'memory.created' : 'memory.update'} · ${result.memory.id}`, '查看审计');
      location.hash = '#/memories/' + result.memory.id;
    } catch (error) { toast('danger', '保存失败', error.message); }
  };
  $('#f-save').addEventListener('click', () => submit(true));
  $('#f-submit').addEventListener('click', () => submit(false));
}

/* ---------- S5 审核队列 ---------- */
async function renderReview() {
  const [drafts, candidates] = await Promise.all([
    api('/api/memories?status=draft&limit=50'), api('/api/memories?status=candidate&limit=50'),
  ]);
  const items = [...drafts.items, ...candidates.items]
    .sort((left, right) => String(right.updated ?? '').localeCompare(String(left.updated ?? '')));
  setNavCounts(items.length, state.navCounts.garden);
  const selected = new Set();
  const limit = 6;
  let offset = PAGER.review || 0;
  if (offset >= items.length) { offset = 0; PAGER.review = 0; }
  const visible = items.slice(offset, offset + limit);
  pageEl.innerHTML = `
    <div class="row">
      ${[['全部', items.length, true], ['draft', drafts.items.length, false], ['candidate', candidates.items.length, false]].map(([t, n, on]) =>
    `<span class="chip ${on ? 'on' : ''}">${t} <b>${n}</b></span>`).join('')}
      <div class="spacer"></div>
      <span class="small faint">确认后进入默认召回 · 丢弃保留审计</span>
    </div>
    <div class="row" style="background:var(--accent-soft);border:1px solid var(--accent);border-radius:10px;padding:14px 20px">
      ${icon('layers', 15, 'var(--warn)')}
      <b class="small">已选 <span id="sel-count">0</span> / ${items.length} 条</b>
      <div class="spacer"></div>
      <button class="btn small" id="batch-edit">批量编辑后确认</button>
      <button class="btn danger-ghost small" id="batch-drop">批量丢弃</button>
      <button class="btn primary small" id="batch-ok">批量确认晋升</button>
    </div>
    ${items.length === 0 ? `<div class="card">${emptyState('审核队列已清空')}</div>` : visible.map((m) => `
      <div class="card" style="gap:10px">
        <div class="row">
          <span class="checkbox" data-sel="${esc(m.id)}"></span>
          ${statusBadge(m.status)}
          <span class="tag">${esc(m.type)}</span>
          <span class="mono small faint">${esc(m.id)}</span>
          <div class="spacer"></div>
          <span class="mono small faint">${esc(m.sourceTrust)} · ${fmtTime(m.updated)}</span>
        </div>
        <h2 style="font-size:16px">${esc(m.title)}</h2>
        <div class="small muted">${esc(m.summary)}</div>
        <div class="row">
          <button class="btn primary small" data-review="promote" data-id="${esc(m.id)}">确认晋升为 active</button>
          <a class="btn small" href="#/memories/${esc(m.id)}">查看详情</a>
          <a class="btn small" href="#/memories/${esc(m.id)}/edit">编辑后确认</a>
          <div class="spacer"></div>
          <a class="small" style="color:var(--warn)" href="#/audit">查看来源会话 →</a>
          <button class="btn danger-ghost small" data-review="forget" data-id="${esc(m.id)}">丢弃</button>
        </div>
      </div>`).join('')}
    ${items.length > limit ? pagerBar('review', items.length, offset, limit) : ''}`;
  listenPage( async (event) => {
    if (pagerClick(event, 'review', limit, renderReview)) return;
    const sel = event.target.closest('[data-sel]');
    if (sel) {
      sel.classList.toggle('on');
      sel.innerHTML = sel.classList.contains('on') ? icon('check', 10) : '';
      if (sel.classList.contains('on')) selected.add(sel.dataset.sel); else selected.delete(sel.dataset.sel);
      $('#sel-count').textContent = String(selected.size);
      return;
    }
    const btn = event.target.closest('[data-review], #batch-ok, #batch-drop');
    if (!btn) return;
    const ids = btn.id ? [...selected] : [btn.dataset.id];
    const isForget = btn.dataset.review === 'forget' || btn.id === 'batch-drop';
    if (ids.length === 0) { toast('warn', '未选择条目', '先勾选要批量处理的记忆'); return; }
    try {
      if (isForget) {
        const ok = await confirmAction({
          title: `确认丢弃 ${ids.length} 条候选记忆？`, sub: ids.slice(0, 3).join(' · ') + (ids.length > 3 ? ' …' : ''),
          body: '丢弃等同遗忘：退出召回并保留审计。批量操作逐条记录 actor 与 request_id。',
          impact: ids.map((i) => `${i} → forgotten`).slice(0, 4), confirmLabel: '确认丢弃', danger: true, typed: 'FORGET',
        });
        if (!ok) return;
        for (const memoryId of ids) {
          await api(`/api/memories/${memoryId}/transition`, { method: 'POST', body: JSON.stringify({ type: 'forget', confirm: true, reason: 'discarded via web workbench' }) });
        }
        toast('ok', '已批量丢弃', `actor=web · lifecycle.forget × ${ids.length}`, '查看审计');
      } else {
        for (const memoryId of ids) {
          await api(`/api/memories/${memoryId}/transition`, { method: 'POST', body: JSON.stringify({ type: 'activate', reason: 'promoted via web workbench' }) });
        }
        toast('ok', '已批量晋升', `actor=web · lifecycle.activate × ${ids.length}`, '查看审计');
      }
      renderReview();
    } catch (error) { toast('danger', '操作失败', error.message); }
  });
}

/* ---------- S6 记忆花园 ---------- */
async function renderGarden() {
  const data = await api('/api/garden');
  const counts = { duplicate: 0, stale: 0, conflict: 0 };
  data.proposals.filter((p) => p.status === 'pending').forEach((p) => { counts[p.category] = (counts[p.category] || 0) + 1; });
  setNavCounts(state.navCounts.review, counts.duplicate + counts.stale + counts.conflict);
  const cat = PAGER.gardenCat || 'all';
  const all = data.proposals.filter((p) => cat === 'all' || p.category === cat);
  const glimit = 4;
  let goffset = PAGER.garden || 0;
  if (goffset >= all.length) { goffset = 0; PAGER.garden = 0; }
  const visible = all.slice(goffset, goffset + glimit);
  const panel = (m, role) => `
    <div class="cmp ${role === 'primary' ? 'a' : 'b'}">
      <div class="row" style="gap:8px">
        <span class="badge ${role === 'primary' ? 'ok' : 'warn'}">${role === 'primary' ? 'A · 主记忆（已存在）' : 'B · 重复候选'}</span>
        ${statusBadge(m.status)}
        <span class="badge neutral">${esc(m.type)}</span>
      </div>
      <div style="font-size:15px;font-weight:600;color:var(--text)">${esc(m.title)}</div>
      <div class="small muted">${esc(m.summary)}</div>
      <div class="code-block scroll-y" style="font-size:11px;max-height:150px">${esc(m.excerpt)}</div>
      <div class="mono small faint">${esc(m.id)} · useful ${m.usefulCount} / ${m.notUsefulCount} · ${esc((m.updated || '').slice(0, 10))} · hash ${esc((m.contentHash || '').slice(0, 12))}</div>
    </div>`;
  pageEl.innerHTML = `
    <div class="row">
      ${[['all', '全部', data.proposals.length], ['duplicate', '重复 duplicate', counts.duplicate], ['stale', '过期 stale', counts.stale], ['conflict', '冲突 conflict', counts.conflict]]
      .map(([key, t, n]) => `<span class="chip ${cat === key ? 'on' : ''}" data-garden-cat="${key}">${t} <b>${n}</b></span>`).join('')}
      <div class="spacer"></div>
      <span class="small faint">裁决不会自动执行：LLM 只出建议，接受才走治理服务并写审计</span>
      <button class="btn" id="garden-scan">${icon('refresh', 14)}重新扫描</button>
    </div>
    ${all.length === 0 ? `<div class="card">${emptyState('暂无提案 · 点击「重新扫描」生成', 'sprout')}</div>` :
      visible.map((p) => `
      <div class="card">
        <div class="row">
          <span class="badge ${p.category === 'conflict' ? 'danger' : p.category === 'stale' ? 'warn' : 'info'}">${esc(p.category)}</span>
          <span class="badge neutral">${esc(p.status)}</span>
          <span class="mono small faint">建议动作：${esc(p.suggestedAction)}</span>
          <div class="spacer"></div>
          <span class="mono small faint">相似度</span>
          <div class="score-track" style="width:200px"><span style="width:${Math.round(Math.min(1, p.score) * 100)}%"></span></div>
          <span class="mono small" style="color:var(--warn)">${Number(p.score).toFixed(2)} / 阈值 ${Number(p.threshold).toFixed(2)}</span>
        </div>
        <div class="small muted">${esc(p.reason)}</div>
        <div class="row" style="align-items:stretch;flex-wrap:nowrap">
          ${(p.memories || []).map((m) => m.missing ? `<div class="cmp"><span class="mono small faint">${esc(m.id)}（记忆已不存在）</span></div>` : panel(m, m.role)).join('')}
        </div>
        ${p.llm ? `
        <div class="card" style="background:var(--accent-soft);border-color:var(--accent);padding:16px 18px">
          <div class="row" style="gap:10px">
            <span class="badge ${p.llm.verdict === 'merge' ? 'warn' : p.llm.verdict === 'duplicate' ? 'danger' : 'ok'}"><span class="dot"></span>LLM 裁决：${esc(String(p.llm.verdict))}</span>
            ${p.llm.score !== undefined ? `<span class="mono small faint">相似度 ${Number(p.llm.score).toFixed(3)}</span>` : ''}
            ${p.llm.bestMatchId ? `<span class="mono small faint">best match ${esc(String(p.llm.bestMatchId))}</span>` : ''}
          </div>
          ${p.llm.mergedText ? `
            <div class="eyebrow">合并建议（mimo 生成）</div>
            <div class="code-block" style="font-size:12px">${esc(String(p.llm.mergedText))}</div>
            <div class="small faint">「采纳合并稿」= 改写主记忆为合并稿（supersede + 审计）→ 淘汰重复候选 → 合并稿经审核队列确认后生效。全程可回滚。</div>
          ` : '<div class="small faint">LLM 判定无需合并文本（duplicate / keep）。</div>'}
        </div>` : ''}
        ${p.status === 'pending' ? `
        <div class="row">
          ${p.llm && p.llm.mergedText ? `<button class="btn primary small" data-adopt="${esc(p.id)}">采纳 LLM 合并稿…</button>` : ''}
          <button class="btn small" data-garden="accepted" data-id="${esc(p.id)}" data-action="${esc(p.suggestedAction)}" data-target="${esc((p.affectedIds || [])[0] || '')}">接受提案（${esc(p.suggestedAction)}）…</button>
          <button class="btn small" data-garden="ignored" data-id="${esc(p.id)}">忽略</button>
          <div class="spacer"></div>
          <span class="mono small faint">裁决均写入审计 · 可回滚</span>
          <button class="btn danger-ghost small" data-garden="rejected" data-id="${esc(p.id)}">拒绝</button>
        </div>` : ''}
      </div>`).join('')}
    ${all.length > glimit ? pagerBar('garden', all.length, goffset, glimit) : ''}`;
  $('#garden-scan').addEventListener('click', async () => {
    try {
      const result = await api('/api/garden/scan', { method: 'POST', body: '{}' });
      toast('ok', '扫描完成', `新提案 ${result.generated} 条 · 未变化 ${result.unchanged}`, '查看审计');
      renderGarden();
    } catch (error) { toast('danger', '扫描失败', error.message); }
  });
  listenPage( async (event) => {
    const catChip = event.target.closest('[data-garden-cat]');
    if (catChip) { PAGER.gardenCat = catChip.dataset.gardenCat; PAGER.garden = 0; renderGarden(); return; }
    if (pagerClick(event, 'garden', glimit, renderGarden)) return;
    const adopt = event.target.closest('[data-adopt]');
    if (adopt) {
      const proposal = data.proposals.find((item) => item.id === adopt.dataset.adopt);
      const primary = (proposal?.memories || []).find((m) => m.role === 'primary' && !m.missing);
      const candidate = (proposal?.memories || []).find((m) => m.role === 'candidate' && !m.missing);
      const mergedText = proposal?.llm?.mergedText;
      if (!primary || !mergedText) { toast('warn', '无法采纳', '缺少主记忆或合并稿'); return; }
      const ok = await confirmAction({
        title: '采纳 LLM 合并稿？', sub: `提案 ${proposal.id}`,
        body: '这将执行一次受治理的合并：改写主记忆为合并稿并淘汰重复候选。合并稿以新版本形式生成，需在审核队列确认后进入召回。',
        impact: [
          `主记忆 ${primary.id} → 正文改为合并稿（supersede + 审计）`,
          candidate ? `候选 ${candidate.id} → forgotten（审计）` : '候选淘汰（审计）',
          '合并稿进入审核队列，确认后生效',
          'actor=web · 全部可回滚',
        ],
        confirmLabel: '确认采纳并合并',
      });
      if (!ok) return;
      try {
        const edited = await api(`/api/memories/${primary.id}`, {
          method: 'PUT',
          body: JSON.stringify({ body: String(mergedText), summary: String(mergedText).slice(0, 200), confirm: true, reason: '采纳 LLM 合并稿（garden 提案 ' + proposal.id + '）' }),
        });
        if (candidate) {
          await api(`/api/memories/${candidate.id}/transition`, {
            method: 'POST',
            body: JSON.stringify({ type: 'forget', confirm: true, reason: '合并后淘汰重复候选（garden 提案 ' + proposal.id + '）' }),
          });
        }
        toast('ok', '合并已执行（受治理）', `合并稿 ${edited.memory.id} 待确认 · 全程留审计`, '去审核队列');
        renderGarden();
      } catch (error) {
        toast('danger', '合并失败', error.message);
      }
      return;
    }
    const btn = event.target.closest('[data-garden]');
    if (!btn) return;
    const decision = btn.dataset.garden;
    try {
      const payload = { decision };
      if (decision === 'accepted') {
        payload.action = btn.dataset.action;
        if (btn.dataset.target) payload.targetId = btn.dataset.target;
        const ok = await confirmAction({
          title: '接受该治理提案？', sub: btn.dataset.id,
          body: '接受会按建议动作执行治理变更（例如标记 stale / supersede），全部写入审计并可回滚。',
          impact: [`proposal: ${btn.dataset.id}`, `action: ${btn.dataset.action}`, 'actor=web · 写入审计'],
          confirmLabel: '确认接受',
        });
        if (!ok) return;
      }
      await api(`/api/garden/${btn.dataset.id}/review`, { method: 'POST', body: JSON.stringify(payload) });
      toast('ok', '已写入审计', `actor=web · garden.${decision} · ${btn.dataset.id}`, '查看审计');
      renderGarden();
    } catch (error) { toast('danger', '裁决失败', error.message); }
  });
}
/* ---------- S7 搜索与召回调试 ---------- */
async function renderSearch() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const q = params.get('q') || '';
  const includeDraft = params.get('includeDraft') === 'true';
  const semantic = params.get('semantic') || 'off';
  pageEl.innerHTML = `
    <div class="row">
      <div class="search-input" style="flex:1;height:48px">${icon('search', 16, 'var(--text-faint)')}
        <input id="s-q" placeholder="输入查询词，例如：sqlite 并发 锁" value="${esc(q)}" style="font-size:15px"></div>
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
  const run = async () => {
    const query = $('#s-q').value.trim();
    if (!query) return;
    const draft = $('#s-draft').classList.contains('on');
    const sem = document.querySelector('[data-semantic].on')?.dataset.semantic || 'off';
    const searchQuery = new URLSearchParams({ q: query, semantic: sem, ...(draft ? { includeDraft: 'true' } : {}) });
    location.hash = '#/search?' + searchQuery.toString();
    const started = performance.now();
    $('#s-result').innerHTML = '<div class="skeleton" style="width:60%"></div><div class="skeleton" style="width:80%"></div>';
    try {
      const [data, all] = await Promise.all([
        api('/api/search?' + searchQuery.toString()),
        api('/api/search?' + new URLSearchParams({ q: query, semantic: sem, includeDraft: 'true' }).toString()),
      ]);
      lastResult = data;
      $('#s-time').textContent = `耗时 ${Math.round(performance.now() - started)}ms · ${data.semanticAvailable ? 'hybrid RRF' : 'FTS5 词法'}${data.degraded ? '（降级）' : ''}`;
      $('#s-note').textContent = `${data.note} · semantic_mode=${data.semanticMode} · semanticAvailable=${data.semanticAvailable}`;
      $('#s-title').textContent = `召回结果 ${data.items.length} / 候选池 ${all.items.length}`;
      const shown = new Set(data.items.map((i) => i.id));
      const excluded = all.items.filter((i) => !shown.has(i.id));
      $('#s-result').innerHTML = data.items.length === 0 ? emptyState('没有命中结果', 'search', 'var(--info)') : data.items.map((item, index) => `
        <div class="row" style="border-bottom:1px solid var(--border-soft);padding:12px 0;align-items:flex-start">
          <span class="page-btn ${index === 0 ? 'on' : ''}" style="border-radius:6px">${index + 1}</span>
          <div style="flex:1">
            <div class="row" style="gap:8px"><a href="#/memories/${esc(item.id)}"><b>${esc(item.id)}</b></a>${statusBadge(item.status)}</div>
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
            <div class="mono small">${esc(i.id)}</div>
            <div class="small faint">${esc((i.matchReason || []).join(' · ') || '词法命中')} · RRF 排名 ${data.items.indexOf(i) + 1}</div>
          </div>`).join('')}
        <h2 style="margin-top:6px">排除 ${excluded.length} 条（透明可查）</h2>
        ${excluded.length === 0 ? '<div class="small faint">无排除项</div>' : excluded.slice(0, 3).map((i) => `
          <div style="background:var(--accent-soft);border-radius:6px;padding:10px 12px">
            <div class="mono small">${esc(i.id)}</div>
            <div class="small faint">draft 未确认 —— 默认不进入召回（include_draft 可见并降权）</div>
          </div>`).join('')}`;
    } catch (error) {
      $('#s-result').innerHTML = `<div class="banner danger">检索失败：${esc(error.message)}</div>`;
    }
  };
  $('#s-run').addEventListener('click', run);
  $('#s-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
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
async function renderAudit() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const actor = params.get('actor') || '';
  const action = params.get('action') || '';
  const offset = Math.max(0, Number(params.get('offset') || '0') || 0);
  const query = new URLSearchParams({ limit: '30', offset: String(offset) });
  if (actor) query.set('actor', actor);
  if (action) query.set('eventType', action);
  const data = await api('/api/audit?' + query.toString());
  const actorColor = { web: 'var(--accent)', daemon: 'var(--info)', agent: 'var(--warn)', system: 'var(--text-muted)', user: 'var(--accent)' };
  const byDay = {};
  for (const record of data.items) {
    const day = record.occurredAt.slice(0, 10);
    (byDay[day] = byDay[day] || []).push(record);
  }
  pageEl.innerHTML = `
    <div class="card" style="gap:10px">
      <div class="row">
        <span class="mono small faint" style="width:44px">actor</span>
        ${['', 'user', 'agent', 'system', 'daemon'].map((a) => `<span class="chip ${a === actor ? 'on' : ''}" data-actor="${a}">${a || '全部'}</span>`).join('')}
      </div>
      <div class="row">
        <span class="mono small faint" style="width:44px">action</span>
        ${['', 'memory', 'lifecycle', 'feedback', 'forget', 'context'].map((a) => `<span class="chip ${a === action ? 'on' : ''}" data-action-filter="${a}">${a || '全部'}</span>`).join('')}
        <div class="spacer"></div>
        <div class="search-input" style="width:280px;height:34px">${icon('search', 13, 'var(--text-faint)')}
          <input placeholder="按 memory_id / request_id 过滤" id="audit-q"></div>
        <div class="select-lite" style="height:34px">${icon('calendar', 12, 'var(--text-muted)')} 近 7 天 ${icon('chevronDown', 12)}</div>
        <button class="btn small" id="audit-csv">导出 CSV</button>
      </div>
    </div>
    <div class="split">
      <div class="card" style="flex:1 1 480px;min-width:0;padding:8px 22px">
        ${Object.keys(byDay).length === 0 ? emptyState('暂无审计事件') : Object.entries(byDay).map(([day, records]) => `
          <div class="day-head"><span class="mono small faint">${day}</span><div class="line"></div></div>
          ${records.map((r) => `
            <div class="row" style="align-items:flex-start;gap:12px;padding:10px 8px;border-bottom:1px solid var(--border-soft);cursor:pointer" data-event='${esc(JSON.stringify(r))}'>
              <div class="tl-dots"><span class="dot" style="background:${actorColor[r.actor] || 'var(--accent)'}"></span><div class="tl-stem"></div></div>
              <div style="flex:1">
                <div class="row" style="gap:8px">
                  <span class="mono small faint">${fmtTime(r.occurredAt).slice(11)}</span>
                  <span class="badge accent">${esc(r.actor)}${r.actorId ? '/' + esc(r.actorId) : ''}</span>
                  <span class="mono small" style="color:var(--text)">${esc(r.eventType)}</span>
                  <span class="badge ${r.eventType.includes('forget') ? 'danger' : 'ok'}">${r.eventType.includes('forget') ? '已脱敏' : '可回滚'}</span>
                </div>
                <div class="small muted" style="margin-top:3px">${esc(r.reason)}</div>
                <div class="mono small faint">${esc(r.subjectType)}/${esc(r.subjectId)}</div>
              </div>
            </div>`).join('')}`).join('')}
        ${pagerBar('audit', data.total, data.offset ?? offset, data.limit ?? 30)}
      </div>
      <div class="rail">
        <div class="card" id="event-detail">
          <h2>事件详情</h2>
          <div class="small faint">点击左侧事件查看 detail / diff。</div>
        </div>
        <div class="card">
          <h2>回滚</h2>
          <div class="small muted" style="line-height:1.6">变更支持回滚。回滚会生成新的审计事件（action=lifecycle.rollback），不删除历史。请在记忆详情页执行生命周期操作。</div>
          <a class="btn danger-ghost" href="#/memories">前往记忆库</a>
        </div>
        <div class="card">
          <h2>actor 图例</h2>
          ${[['web（人工 / 工作台）', 'var(--accent)'], ['daemon（后台整合）', 'var(--info)'], ['agent（Codex / pi …）', 'var(--warn)']].map(([t, c]) => `
            <div class="row" style="gap:9px"><span class="dot" style="background:${c}"></span><span class="mono small muted">${t}</span></div>`).join('')}
        </div>
      </div>
    </div>`;
  listenPage( (event) => {
    const pg = event.target.closest('[data-pager="audit"]');
    if (pg && !pg.hasAttribute('disabled')) {
      const next = new URLSearchParams();
      if (actor) next.set('actor', actor);
      if (action) next.set('action', action);
      const page = Number(pg.dataset.page);
      if (page > 1) next.set('offset', String((page - 1) * 30));
      location.hash = '#/audit' + (next.toString() ? '?' + next.toString() : '');
      return;
    }
    const chip = event.target.closest('[data-actor]');
    if (chip) {
      const next = new URLSearchParams();
      if (chip.dataset.actor) next.set('actor', chip.dataset.actor);
      if (action) next.set('action', action);
      location.hash = '#/audit' + (next.toString() ? '?' + next.toString() : '');
      return;
    }
    const act = event.target.closest('[data-action-filter]');
    if (act) {
      const next = new URLSearchParams();
      if (actor) next.set('actor', actor);
      if (act.dataset.actionFilter) next.set('action', act.dataset.actionFilter);
      location.hash = '#/audit' + (next.toString() ? '?' + next.toString() : '');
      return;
    }
    const row = event.target.closest('[data-event]');
    if (row) {
      const record = JSON.parse(row.dataset.event);
      $('#event-detail').innerHTML = `
        <h2>事件详情</h2>
        ${kv([['eventType', record.eventType], ['actor', `${record.actor}${record.actorId ? '/' + record.actorId : ''}`],
      ['subject', `${record.subjectType}/${record.subjectId}`], ['occurredAt', record.occurredAt], ['eventHash', record.eventHash]])}
        ${record.payload && Object.keys(record.payload).length ? `
          <div class="frontmatter"><div class="eyebrow">PAYLOAD</div>
            ${Object.entries(record.payload).map(([k, v]) => `<div>${esc(k)}: ${esc(typeof v === 'object' ? JSON.stringify(v) : String(v))}</div>`).join('')}
          </div>` : ''}
        <div class="frontmatter"><div class="eyebrow">REASON</div><div>${esc(record.reason)}</div></div>
        <a class="btn small" href="#/memories/${esc(record.subjectId)}">查看目标记忆</a>`;
    }
    if (event.target.closest('#audit-csv')) {
      const header = ['occurredAt', 'actor', 'eventType', 'subjectType', 'subjectId', 'reason', 'eventHash'];
      const csv = [header.join(',')]
        .concat(data.items.map((record) => header.map((key) => `"${String(record[key] ?? '').replace(/"/g, '""')}"`).join(',')))
        .join('\n');
      downloadFile('taga-audit.csv', csv, 'text/csv;charset=utf-8');
      toast('ok', '已下载审计 CSV', `${data.items.length} 条 · 可回放`);
    }
  });
}

/* ---------- S10 项目与会话 ---------- */
async function renderProjects() {
  const data = await api('/api/projects');
  const sys = await api('/api/system');
  const sess = await api('/api/sessions');
  const bySession = {};
  for (const observation of sess.observations) {
    const entry = bySession[observation.sessionId] || (bySession[observation.sessionId] = { count: 0, last: '' });
    entry.count += 1;
    if (observation.occurredAt > entry.last) entry.last = observation.occurredAt;
  }
  const olimit = 6;
  let ooffset = PAGER.obs || 0;
  if (ooffset >= sess.observations.length) { ooffset = 0; PAGER.obs = 0; }
  const obsPage = sess.observations.slice(ooffset, ooffset + olimit);
  pageEl.innerHTML = `
    <div class="banner info">${icon('info', 15, 'var(--info)')}项目身份在运行时解析（优先 git origin，其次规范化路径）；无项目上下文时只召回 global / domain 记忆。</div>
    <div class="split">
      <div class="main-col">
        <div class="card" style="padding:0">
          <div class="row" style="padding:18px 22px 0">
            <h2>项目</h2><div class="spacer"></div>
            <span class="mono small faint">git origin / 归一化路径 → 稳定身份</span>
            <button class="btn small">新建 .taga/project.yaml</button>
          </div>
          <table>
            <thead><tr><th class="mono">project_id</th><th class="mono">根路径</th><th class="mono">识别来源</th><th class="mono">canonicalKey</th><th class="mono">最近出现</th></tr></thead>
            <tbody>
              ${data.items.length === 0 ? `<tr><td colspan="5">${emptyState('尚无项目记录 · 运行 Agent 会话或项目命令后自动登记', 'folder')}</td></tr>` :
      data.items.map((p) => `<tr>
                <td class="mono">${esc(p.id)}</td><td class="mono">${esc(p.root)}</td>
                <td><span class="badge neutral">${esc(p.source)}</span></td>
                <td class="mono faint">${esc(p.canonicalKey)}</td>
                <td class="mono faint">${fmtTime(p.lastSeenAt)}</td></tr>`).join('')}
            </tbody>
          </table>
        </div>
        <div class="card" style="flex:1">
          <div class="card-head"><h2>会话观察流（采集预览）</h2><div class="spacer"></div>
            <span class="mono small faint">已脱敏 · 仅本机 · ${sess.observations.length} 条</span></div>
          ${sess.observations.length === 0 ? emptyState('暂无观察流 · 会话采集走 daemon / agent 适配器', 'inbox') : obsPage.map((obs) => `
            <div class="row" style="border-bottom:1px solid var(--border-soft);padding:10px 0;align-items:flex-start">
              <div class="mono small faint" style="width:90px">${fmtTime(obs.occurredAt).slice(5, 16)}</div>
              <div style="flex:1">
                <div class="small" style="color:var(--text)">${esc(obs.summary)}</div>
                <div class="row" style="gap:6px;margin-top:3px">
                  <span class="badge neutral">${esc(obs.kind)}</span>
                  <span class="mono small faint">${esc(obs.sessionId)}${obs.taskId ? ' · ' + esc(obs.taskId) : ''}</span>
                  <span class="badge ok">已脱敏</span>
                </div>
              </div>
            </div>`).join('')}
          ${sess.observations.length > olimit ? pagerBar('obs', sess.observations.length, ooffset, olimit) : ''}
          <div class="banner info">观察经敏感值扫描后进入 draft 候选，人工确认后才参与召回。</div>
        </div>
      </div>
      <div class="rail wide">
        <div class="card">
          <div class="card-head"><h2>最近会话</h2><div class="spacer"></div>
            <span class="mono small faint">${Object.keys(bySession).length} 个会话</span></div>
          ${Object.keys(bySession).length === 0 ? emptyState('暂无会话记录', 'history', 'var(--info)') : Object.entries(bySession).slice(0, 6).map(([sessionId, entry]) => `
            <div class="row" style="border-bottom:1px solid var(--border-soft);padding:10px 0">
              <div class="icon-circle" style="width:28px;height:28px">${icon('history', 13, 'var(--warn)')}</div>
              <div style="flex:1">
                <div class="mono small">${esc(sessionId)}</div>
                <div class="small faint">观察 ${entry.count} 条 · 最近 ${fmtTime(entry.last).slice(5, 16)}</div>
              </div>
              <span class="badge ${entry.last > new Date(Date.now() - 86400000).toISOString() ? 'ok' : 'neutral'}">${entry.last > new Date(Date.now() - 86400000).toISOString() ? '24h 内' : '历史'}</span>
            </div>`).join('')}
        </div>
        <div class="card">
          <h2>采集与游标</h2>
          ${kv([['cursor 数', String(sys.cursors)], ['采集策略', '仅本机 · 不联网 · L2 提醒可关闭'], ['观察上限', 'bounded · 去重 · 可关闭']])}
          <div class="row">
            <button class="btn small">立即采集</button>
            <button class="btn small">暂停采集</button>
          </div>
          <div class="banner warn">采集控制走 daemon 卡；此处展示游标状态。</div>
        </div>
      </div>
    </div>`;
  listenPage( (event) => { pagerClick(event, 'obs', olimit, renderProjects); });
}

/* ---------- S11 知识包 ---------- */
async function renderPacks() {
  const [data, packData] = await Promise.all([api('/api/jobs'), api('/api/packs').catch(() => ({ items: [] }))]);
  const jobs = data.items.filter((job) => String(job.kind).includes('knowledge'));
  const plimit = 8;
  let poffset = PAGER.packs || 0;
  if (poffset >= jobs.length) { poffset = 0; PAGER.packs = 0; }
  const jobsPage = jobs.slice(poffset, poffset + plimit);
  pageEl.innerHTML = `
    <div class="banner warn">${icon('alert', 15, 'var(--warn)')}知识包完整管理（DomainPack 安装 / 预览）随 pack 卡接入；本页提供摄取任务队列与摄取约定。</div>
    <div class="card">
      <div class="card-head"><h2>已安装知识包</h2><div class="spacer"></div><span class="mono small faint">DomainPackService</span></div>
      ${packData.items.length === 0 ? emptyState('未安装领域包 · 可通过 knowledge_ingest 或 taga pack 导入', 'package') : `
      <table>
        <thead><tr><th class="mono">pack</th><th class="mono">名称</th><th class="mono">范围</th><th class="mono">状态</th><th></th></tr></thead>
        <tbody>
          ${packData.items.map((pack) => `<tr>
            <td class="mono">${esc(pack.id)}</td>
            <td>${esc(pack.name || pack.title || pack.id)}</td>
            <td class="mono faint">${esc(pack.contextSection || pack.domain || '—')}</td>
            <td><span class="badge ${pack.enabled ? 'ok' : 'neutral'}"><span class="dot"></span>${pack.enabled ? 'enabled' : 'disabled'}</span></td>
            <td><button class="btn small" data-pack="${esc(pack.id)}" data-enabled="${pack.enabled ? 'false' : 'true'}">${pack.enabled ? '停用' : '启用'}</button></td>
          </tr>`).join('')}
        </tbody>
      </table>`}
    </div>
    <div class="card">
      <div class="card-head"><h2>摄取知识（knowledge_ingest）</h2><div class="spacer"></div>
        <span class="mono small faint">多个条目用 --- 分隔 · 首行作为标题</span></div>
      <textarea id="ingest-text" placeholder="粘贴 Markdown 知识条目，例如：&#10;&#10;## 发布流程&#10;发布前必须执行 release:smoke…&#10;&#10;---&#10;&#10;## 路径比较&#10;Windows 路径比较前需归一化…"></textarea>
      <div class="row">
        <select id="ingest-pack" style="max-width:220px">
          <option value="">不关联知识包</option>
          ${packData.items.map((pack) => `<option value="${esc(pack.id)}">${esc(pack.id)}</option>`).join('')}
        </select>
        <select id="ingest-type" style="max-width:160px">
          ${TYPE_OPTIONS.map((t) => `<option ${t === 'lessons' ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
        <div class="spacer"></div>
        <button class="btn primary" id="ingest-run">摄取为 draft</button>
      </div>
      <div class="banner warn">生成 draft 记忆（不直接进入召回，需到审核队列确认）；命中敏感值规则的内容会被整体拒绝且不落盘。</div>
    </div>
    <div class="card">
      <div class="card-head"><h2>摄取任务队列</h2><div class="spacer"></div><span class="mono small faint">jobs · knowledge.*</span></div>
      ${jobs.length === 0 ? emptyState('暂无摄取任务', 'inbox') : `
      <table>
        <thead><tr><th class="mono">任务</th><th class="mono">来源</th><th class="mono">状态</th><th class="mono">生成</th><th class="mono">时间</th></tr></thead>
        <tbody>
          ${jobsPage.map((job) => `<tr>
            <td class="mono">${esc(job.id)}</td><td class="mono">${esc(job.kind)}</td>
            <td><span class="badge ${job.status === 'dead' || job.status === 'failed' ? 'danger' : 'info'}">${esc(job.status)}</span></td>
            <td class="mono faint">draft 候选</td>
            <td class="mono faint">${fmtTime(job.updatedAt || job.createdAt).slice(0, 16)}</td></tr>`).join('')}
        </tbody>
      </table>`}
      ${jobs.length > plimit ? pagerBar('packs', jobs.length, poffset, plimit) : ''}
    </div>
    <div class="card">
      <h2>摄取规则</h2>
      ${kv([['frontmatter', '校验失败即拒绝'], ['敏感值扫描', '命中即阻止'], ['相似度 ≥ 0.95', '提示重复，走花园裁决'],
      ['默认状态', 'draft，需人工确认后生效'], ['审计', '全部写入（actor=web / daemon）']])}
    </div>`;
  listenPage( async (event) => {
    if (pagerClick(event, 'packs', plimit, renderPacks)) return;
    const btn = event.target.closest('[data-pack]');
    if (!btn) return;
    try {
      await api(`/api/packs/${btn.dataset.pack}/toggle`, { method: 'POST', body: JSON.stringify({ enabled: btn.dataset.enabled === 'true' }) });
      toast('ok', '已写入审计', `actor=web · pack.toggle · ${btn.dataset.pack}`, '查看审计');
      renderPacks();
    } catch (error) { toast('danger', '操作失败', error.message); }
  });
  $('#ingest-run').addEventListener('click', async () => {
    const text = $('#ingest-text').value.trim();
    if (!text) { toast('warn', '内容为空', '先粘贴要摄取的 Markdown 内容'); return; }
    try {
      const result = await api('/api/knowledge/ingest', {
        method: 'POST',
        body: JSON.stringify({
          text,
          type: $('#ingest-type').value,
          ...($('#ingest-pack').value ? { packId: $('#ingest-pack').value } : {}),
        }),
      });
      toast('ok', '已写入审计', `actor=web · knowledge.ingest · 生成 ${result.count} 条 draft`, '去审核队列');
      renderPacks();
    } catch (error) {
      toast('danger', '摄取被拒绝', error.message, '查看规则');
    }
  });
}

/* ---------- S12 系统与设置 ---------- */
async function renderSystem() {
  const sys = await api('/api/system');
  const jobs = await api('/api/jobs');
  const jlimit = 8;
  let joffset = PAGER.jobs || 0;
  if (joffset >= jobs.items.length) { joffset = 0; PAGER.jobs = 0; }
  const jobsPage = jobs.items.slice(joffset, joffset + jlimit);
  pageEl.innerHTML = `
    <div class="split">
      <div class="main-col">
        <div class="card">
          <div class="card-head"><h2>有效配置</h2><div class="spacer"></div>
            <span class="badge ok">${icon('shield', 12)}已脱敏</span>
            <button class="btn small">config validate</button></div>
          <div class="table">
            <table>
              <thead><tr><th class="mono">配置项</th><th class="mono">值</th><th class="mono">来源</th></tr></thead>
              <tbody>
                ${[['paths.brain', sys.brainPath, 'yaml'], ['database', sys.databasePath, 'derived'],
      ['retrieval.semantic.mode', 'off（Web 仅 FTS5）', 'default'], ['web.bind', '127.0.0.1（仅本机）', 'yaml'],
      ['llm.api_key', '●●●●●●●●●●（仅 TAGA_LLM_API_KEY）', 'env'], ['defaultTheme', sys.defaultTheme, 'ui']]
      .map(([k, v, src]) => `<tr><td class="mono">${k}</td><td class="mono">${esc(v)}</td>
                <td><span class="badge ${src === 'env' ? 'info' : 'neutral'}">${src}</span></td></tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h2>后台任务 Jobs</h2><div class="spacer"></div>
            <span class="mono small faint">队列持久化于 SQLite · 失败可重试</span></div>
          ${jobs.items.length === 0 ? emptyState('暂无任务', 'inbox') : `
          <table>
            <thead><tr><th class="mono">job</th><th class="mono">kind</th><th class="mono">status</th><th></th></tr></thead>
            <tbody>
              ${jobsPage.map((job) => `<tr>
                <td class="mono">${esc(job.id)}</td><td class="mono">${esc(job.kind)}</td>
                <td><span class="badge ${job.status === 'dead' || job.status === 'failed' ? 'danger' : 'neutral'}">${esc(job.status)}</span></td>
                <td>${job.status === 'dead' || job.status === 'failed' ? `<button class="btn small" data-retry="${esc(job.id)}">重试</button>` : ''}</td></tr>`).join('')}
            </tbody>
          </table>`}
          ${jobs.items.length > jlimit ? pagerBar('jobs', jobs.items.length, joffset, jlimit) : ''}
        </div>
        <div class="card">
          <h2>索引与存储维护</h2>
          ${[['reindex', '从 Markdown 重建 SQLite / FTS5 派生索引', '重建索引', 'sys-reindex'],
      ['vector rebuild', 'enqueueSemanticRebuild：排队重建 bge-m3 / Zvec 语义索引', '重建向量', 'sys-vector'],
      ['audit prune', '归档 90 天前的审计事件（存储层归档接口待接入）', '归档审计', null]]
      .map(([name, desc, btn, actionId]) => `
            <div class="row" style="border-bottom:1px solid var(--border-soft);padding:11px 0">
              ${icon('database', 14, 'var(--text-muted)')}
              <div style="flex:1"><div class="mono small">${name}</div><div class="small faint">${desc}</div></div>
              ${actionId ? `<button class="btn small" id="${actionId}">${btn}…</button>` : `<button class="btn small" disabled>${btn}</button>`}
            </div>`).join('')}
        </div>
      </div>
      <div class="rail wide">
        <div class="card">
          <h2>运行状态</h2>
          ${kv([['daemon', 'running · Fast Path 可用'], ['版本', 'taga 0.1.0 · node 22'], ['平台', 'win32 · x64'], ['绑定', '127.0.0.1（仅本机）']])}
          <div class="row">
            <button class="btn small">重启 daemon</button>
            <button class="btn small">运行 doctor</button>
          </div>
        </div>
        <div class="card">
          <h2>检索与语义</h2>
          ${kv([['FTS5', 'ok · 词法检索就绪'],
      ['semantic', `${sys.semantic.mode} · ${sys.semantic.modelAvailable ? 'bge-m3 模型就绪' : '模型缺失（自动降级）'}`],
      ['modelPath', sys.semantic.modelPath || '未配置'],
      ['语义索引', sys.semantic.indexStatus || '—'],
      ['融合', 'equal-weight RRF（词法 0.5 / 语义 0.5）']])}
        </div>
        <div class="card">
          <h2>LLM 与用量</h2>
          <div class="row">
            <span class="badge ${sys.llm.mode === 'off' ? 'neutral' : 'warn'}"><span class="dot"></span>mode: ${esc(sys.llm.mode)}</span>
            ${sys.llm.apiKeySet ? '<span class="badge ok">API Key 已配置（仅环境变量）</span>' : '<span class="badge danger">API Key 未配置</span>'}
          </div>
          ${kv([['provider', sys.llm.provider || '—'], ['endpoint', sys.llm.endpoint || '—'], ['model', sys.llm.model || '—'],
      ['timeoutMs', String(sys.llm.timeoutMs)], ['dailyCap', sys.llm.dailyCap ? String(sys.llm.dailyCap) : '未设置']])}
          <div class="mono small faint">LLM 用于观察蒸馏（候选生产）、反思提炼（洞见候选）与整合合并裁决；失败自动回退确定性路径，产出一律进入候选层待审。</div>
        </div>
        <div class="card" style="background:var(--accent-soft);border-color:var(--accent)">
          <h2>安全边界</h2>
          ${['仅绑定 127.0.0.1，无远程访问', '敏感值脱敏贯穿 UI / 日志 / 审计', '高风险操作输入式确认 + 可回滚', 'Fast Path 不依赖 daemon / LLM / 网络']
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
  listenPage( async (event) => {
    if (pagerClick(event, 'jobs', jlimit, renderSystem)) return;
    const btn = event.target.closest('[data-retry]');
    if (!btn) return;
    try {
      const result = await api(`/api/jobs/${btn.dataset.retry}/retry`, { method: 'POST', body: '{}' });
      toast('ok', '已写入审计', `actor=web · job.retry → ${result.nextId}`, '查看审计');
      renderSystem();
    } catch (error) { toast('danger', '重试失败', error.message); }
  });
}

/* ---------- S8 Context Pack ---------- */
async function renderContext() {
  pageEl.innerHTML = `
    <div class="card">
      <div class="row">
        <div style="display:flex;flex-direction:column;gap:6px">
          <h2 style="font-size:16px">生成 Context Pack</h2>
          <span class="small faint">确定性 Fast Path · 每次生成写入 context.build 审计 · candidate / draft 默认不进入</span>
        </div>
        <div class="spacer"></div>
        <input id="ctx-agent" value="codex" style="width:120px" placeholder="agent">
        <input id="ctx-project" value="taga" style="width:140px" placeholder="project（可选）">
        <input id="ctx-task" value="" style="width:280px" placeholder="task（可选，用于召回筛选）">
        <input id="ctx-budget" value="1300" style="width:110px" placeholder="token 预算">
        <button class="btn primary" id="ctx-run">生成</button>
      </div>
    </div>
    <div id="ctx-result">${emptyState('填写参数后点击「生成」', 'package', 'var(--info)')}</div>`;

  $('#ctx-run').addEventListener('click', async () => {
    const box = $('#ctx-result');
    box.innerHTML = '<div class="card"><div class="skeleton" style="width:50%"></div><div class="skeleton" style="width:80%"></div><div class="skeleton" style="width:70%"></div></div>';
    try {
      const payload = {
        agentId: $('#ctx-agent').value.trim() || 'web',
        ...(($('#ctx-project').value.trim()) ? { projectId: $('#ctx-project').value.trim() } : {}),
        ...(($('#ctx-task').value.trim()) ? { task: $('#ctx-task').value.trim() } : {}),
        tokenBudget: Number($('#ctx-budget').value) || 1300,
      };
      const data = await api('/api/context/preview', { method: 'POST', body: JSON.stringify(payload) });
      const pack = data.pack;
      const stats = data.stats;
      const bucketEntries = Object.entries(stats.buckets || {});
      box.innerHTML = `
        <div class="card">
          <div class="row">
            <span class="mono" style="background:var(--input);padding:4px 10px;border-radius:6px;font-size:12px">${esc(pack.id)}</span>
            <span class="badge neutral">source: ${esc(data.source)}</span>
            ${data.stale ? '<span class="badge warn">缓存过期</span>' : '<span class="badge ok">新鲜</span>'}
            <div class="spacer"></div>
            <button class="btn small" id="ctx-copy">复制</button>
            <button class="btn small" id="ctx-export">导出 JSON</button>
          </div>
          <div class="row"><b class="small">token 预算</b>
            <span class="mono small">${stats.tokenEstimate} / ${payload.tokenBudget}</span>
            ${pack.truncated ? '<span class="badge warn">已截断</span>' : ''}
            <div class="spacer"></div>
            <span class="badge ok">纳入 ${stats.included}</span>
            <span class="badge warn">截断 ${stats.truncated}</span>
            <span class="badge danger">排除 ${stats.excluded}</span>
          </div>
          <div class="seg-track">
            ${bucketEntries.map(([, b], i) => `<span style="flex:${Math.max(1, b.included + b.truncated)};background:${['var(--accent)', 'var(--info)', 'var(--warn)', 'var(--ok)'][i % 4]}"></span>`).join('')}
            <span style="flex:2;background:var(--border-soft)"></span>
          </div>
          <div class="row">
            ${bucketEntries.map(([name, b], i) => `
              <span class="row" style="gap:6px"><span style="width:10px;height:10px;border-radius:3px;background:${['var(--accent)', 'var(--info)', 'var(--warn)', 'var(--ok)'][i % 4]}"></span>
              <span class="mono small faint">${esc(name)} ${b.included}/${b.truncated}</span></span>`).join('')}
          </div>
        </div>
        <div class="split">
          <div class="main-col">
            <div class="card">
              <h2>Pack 内容 · 每条均标注纳入原因</h2>
              ${(pack.sections || []).length === 0 ? emptyState('空 pack：没有匹配该任务的记忆') : pack.sections.map((section) => `
                <div class="row" style="align-items:flex-start;gap:12px;border:1px solid var(--border-soft);border-radius:10px;padding:14px 18px">
                  <div style="width:3px;border-radius:999px;background:var(--accent);align-self:stretch"></div>
                  <div style="flex:1;display:flex;flex-direction:column;gap:5px">
                    <div class="row" style="gap:8px">
                      <span class="badge accent">${esc(section.kind)}</span>
                      <b class="small">${esc(section.title)}</b>
                      <div class="spacer"></div>
                      <span class="mono small faint">${section.tokenEstimate} tok · ${(section.memoryIds || []).length} 条</span>
                    </div>
                    <div class="code-block" style="font-size:11px;max-height:120px;overflow:hidden">${esc(section.content)}</div>
                  </div>
                </div>`).join('')}
            </div>
            <div class="card scroll-y">
              <h2>纳入 / 截断 / 排除决策</h2>
              ${(pack.decisions || []).map((d) => `
                <div class="row" style="gap:10px;padding:9px 0;border-bottom:1px solid var(--border-soft);align-items:flex-start">
                  <span class="badge ${d.decision === 'included' ? 'ok' : d.decision === 'truncated' ? 'warn' : 'danger'}">${esc(d.decision)}</span>
                  <div style="flex:1">
                    <div class="mono small">${esc(d.memoryId || d.budgetBucket || 'section')}</div>
                    <div class="small faint">${esc((d.reason || []).join(' · '))}</div>
                  </div>
                  ${d.score !== undefined ? `<span class="mono small faint">score ${Number(d.score).toFixed(2)}</span>` : ''}
                </div>`).join('')}
            </div>
          </div>
          <div class="rail">
            <div class="card">
              <h2>生成参数</h2>
              ${kv([['agentId', pack.agentId], ['project', pack.projectId || '—'], ['channel', 'static（preview）'],
      ['generatedAt', fmtTime(pack.generatedAt)], ['tokenEstimate', String(pack.tokenEstimate)],
      ['degraded', String(pack.degraded)], ['source', data.source]])}
            </div>
            <div class="card">
              <h2>注入 Agent 指令</h2>
              <label class="field">targetPath（Agent 指令文件绝对路径）
                <input id="ctx-target" placeholder="例如 D:\\projects\\taga\\AGENTS.md"></label>
              <div class="small faint">仅维护 taga:instructions:begin/end 标记块，重复注入幂等。写文件需显式确认，写入后留 context.inject 审计。</div>
              <button class="btn primary small" id="ctx-inject">注入到 Agent 指令…</button>
            </div>
            <div class="card" style="background:var(--accent-soft);border-color:var(--accent)">
              <h2>可追溯</h2>
              <div class="small muted" style="line-height:1.6">${esc(data.trace?.nextQueryHint || '')}</div>
              <div class="mono small faint">trace: ${esc(data.trace?.packId || pack.id)} · ${((data.trace && data.trace.decisions) || []).length} 条决策</div>
            </div>
          </div>
        </div>`;
      $('#ctx-copy').addEventListener('click', () => {
        navigator.clipboard?.writeText(pack.content || '');
        toast('ok', '已复制 Pack 内容', `${stats.included} 条纳入 · ${stats.tokenEstimate} tok`);
      });
      $('#ctx-export').addEventListener('click', () => {
        downloadFile(`taga-context-${pack.id}.json`, JSON.stringify({ pack, stats, trace: data.trace }, null, 2), 'application/json');
        toast('ok', '已下载调试 JSON', '包含 pack / stats / trace');
      });
      $('#ctx-inject').addEventListener('click', async () => {
        const targetPath = $('#ctx-target').value.trim();
        if (!targetPath) { toast('warn', '缺少 targetPath', '填写 Agent 指令文件的绝对路径'); return; }
        const ok = await confirmAction({
          title: '注入 Context Pack 到 Agent 指令文件？', sub: targetPath,
          body: '将在目标文件中写入 / 更新 taga:instructions 标记块（重复注入幂等）。这是对项目文件的写操作，需要显式确认。',
          impact: [`target: ${targetPath}`, `pack: ${pack.id}`, '写入 taga:instructions:begin/end 标记块', '审计新增 context.inject（actor=web）'],
          confirmLabel: '确认注入',
        });
        if (!ok) return;
        try {
          const injected = await api('/api/context/inject', {
            method: 'POST',
            body: JSON.stringify({
              confirm: true,
              targetPath,
              agentId: payload.agentId,
              ...(payload.projectId ? { projectId: payload.projectId } : {}),
              ...(payload.task ? { task: payload.task } : {}),
            }),
          });
          toast('ok', '已写入审计', `actor=web · context.inject · ${injected.injectedPath}`, '查看审计');
        } catch (error) {
          toast('danger', '注入失败', error.message);
        }
      });
    } catch (error) {
      box.innerHTML = `<div class="card"><div class="banner danger">生成失败：${esc(error.message)}</div></div>`;
    }
  });
}

/* ---------- 知识候选（蒸馏 / 反思产出） ---------- */
async function renderCandidates() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const decision = params.get('decision') || 'pending';
  const data = await api('/api/candidates' + (decision === 'all' ? '' : '?decision=' + decision));
  const counts = data.counts;
  const climit = 4;
  let coffset = PAGER.candidates || 0;
  if (coffset >= data.items.length) { coffset = 0; PAGER.candidates = 0; }
  const visible = data.items.slice(coffset, coffset + climit);
  const originOf = (id) => (String(id).includes('reflect') ? '反思 Reflect' : '蒸馏 Distill');
  const factRow = (fact) => `
    <div class="row" style="gap:8px;align-items:flex-start">
      <span class="dot" style="background:var(--accent);margin-top:6px"></span>
      <div style="flex:1"><div class="small" style="color:var(--text)">${esc(fact.text)}</div>
      <div class="mono faint" style="font-size:10px">evidence: ${esc((fact.evidenceIds || []).join(', ') || '—')} · confidence ${fact.confidence !== undefined ? Number(fact.confidence).toFixed(2) : '—'}</div></div>
    </div>`;
  pageEl.innerHTML = `
    <div class="banner info">${icon('info', 15, 'var(--info)')}候选由蒸馏（观察 → 结构化知识）与反思（记忆组 → 洞见）产出，<b>一律停在待审层</b>；采纳后生成 draft 记忆，经审核队列确认才进入召回。</div>
    <div class="row">
      ${[['pending', `待审 ${counts.pending || 0}`], ['accepted', `已采纳 ${counts.accepted || 0}`], ['rejected', `已拒绝 ${counts.rejected || 0}`], ['all', `全部 ${data.total}`]]
      .map(([key, t]) => `<span class="chip ${decision === key ? 'on' : ''}" data-cand-tab="${key}">${t}</span>`).join('')}
      <div class="spacer"></div>
      <span class="small faint">来源：MCP 观察 / daemon hook / 反思任务（本期展示 mock 数据）</span>
    </div>
    ${data.items.length === 0 ? `<div class="card">${emptyState('暂无候选 · 蒸馏与反思产出会出现在这里', 'inbox')}</div>` :
      visible.map((c) => `
      <div class="card">
        <div class="row">
          <span class="badge ${String(c.id).includes('reflect') ? 'warn' : 'info'}">${originOf(c.id)}</span>
          <span class="badge neutral">${esc(c.memoryType)}</span>
          <span class="badge ${c.decision === 'accepted' ? 'ok' : c.decision === 'rejected' ? 'danger' : 'accent'}"><span class="dot"></span>${esc(c.decision)}</span>
          ${c.worthLearning ? '<span class="badge ok">worth learning</span>' : '<span class="badge neutral">low reuse</span>'}
          <span class="tag">scope: ${esc(c.scopeSuggestion?.kind)}${c.scopeSuggestion?.id ? ':' + esc(c.scopeSuggestion.id) : ''}</span>
          <div class="spacer"></div>
          <span class="mono small faint">confidence</span>
          <div class="score-track" style="width:120px"><span style="width:${Math.round((c.confidence ?? 0.7) * 100)}%"></span></div>
          <span class="mono small faint">${Number(c.confidence ?? 0.7).toFixed(2)}</span>
        </div>
        <h2 style="font-size:16px">${esc(c.title)}</h2>
        <div class="small muted">${esc(c.summary)}</div>
        <div class="code-block scroll-y" style="font-size:11px;max-height:110px">${esc(c.body)}</div>
        ${(c.facts || []).length > 0 ? `
        <div>
          <div class="eyebrow">FACTS · 结构化事实（引用证据）</div>
          <div style="display:flex;flex-direction:column;gap:8px;margin-top:6px">${c.facts.map(factRow).join('')}</div>
        </div>` : ''}
        ${(c.entities || []).length > 0 ? `
        <div class="row" style="gap:8px">
          <span class="eyebrow">ENTITIES</span>
          ${c.entities.map((e) => `<span class="tag">${esc(e.name)}${e.type ? ' · ' + esc(e.type) : ''}</span>`).join('')}
        </div>` : ''}
        ${(c.temporalFacts || []).length > 0 ? `
        <div>
          <div class="eyebrow">TEMPORAL FACTS</div>
          ${c.temporalFacts.map((t) => `<div class="mono small faint">⏱ ${esc(t.text)} ${t.occurredStart ? '（' + esc(String(t.occurredStart).slice(0, 10)) + (t.occurredEnd ? ' ~ ' + esc(String(t.occurredEnd).slice(0, 10)) : '') + '）' : ''}</div>`).join('')}
        </div>` : ''}
        ${(c.causalLinks || []).length > 0 ? `
        <div>
          <div class="eyebrow">CAUSAL LINKS</div>
          ${c.causalLinks.map((l) => `<div class="mono small faint">${esc(String(l.fromFact))} —[${esc(l.relation)}]→ ${esc(String(l.toFact))}</div>`).join('')}
        </div>` : ''}
        ${c.applicabilityDetails ? `
        <div class="row" style="align-items:stretch">
          <div class="cmp a" style="padding:12px 14px"><span class="eyebrow">适用条件</span>
            ${(c.applicabilityDetails.conditions || []).map((t) => `<div class="small muted">✓ ${esc(t)}</div>`).join('') || '<div class="small faint">—</div>'}</div>
          <div class="cmp b" style="padding:12px 14px"><span class="eyebrow">排除条件</span>
            ${(c.applicabilityDetails.exclusions || []).map((t) => `<div class="small muted">✕ ${esc(t)}</div>`).join('') || '<div class="small faint">—</div>'}</div>
        </div>` : ''}
        ${c.model ? `
        <div class="mono faint" style="font-size:10px">model trace: ${esc(c.model.mode)} · ${esc(c.model.model || '')} · ${esc(c.model.promptVersion || '')}${c.model.inputTokens !== undefined ? ' · ' + c.model.inputTokens + '/' + c.model.outputTokens + ' tok' : ''}${c.model.latencyMs !== undefined ? ' · ' + c.model.latencyMs + 'ms' : ''}</div>` : ''}
        <div class="mono faint" style="font-size:10px">${esc(c.id)} · evidence: ${esc((c.evidenceIds || []).join(', '))}${c.createdAt ? ' · ' + esc(String(c.createdAt).slice(0, 16).replace('T', ' ')) : ''}</div>
        ${c.decision === 'pending' ? `
        <div class="row">
          <button class="btn primary small" data-cand="accept" data-id="${esc(c.id)}">采纳为 draft…</button>
          <button class="btn danger-ghost small" data-cand="reject" data-id="${esc(c.id)}">拒绝…</button>
          <div class="spacer"></div>
          <span class="mono small faint">操作写入审计 · 可回滚</span>
        </div>` : `<div class="small faint">已裁决：${esc(c.decision)}${c.decisionReason ? ' · ' + esc(c.decisionReason) : ''}${c.decidedAt ? ' · ' + esc(String(c.decidedAt).slice(0, 16).replace('T', ' ')) : ''}</div>`}
      </div>`).join('')}
    ${data.items.length > climit ? pagerBar('candidates', data.items.length, coffset, climit) : ''}`;
  listenPage( async (event) => {
    const tab = event.target.closest('[data-cand-tab]');
    if (tab) {
      location.hash = '#/candidates' + (tab.dataset.candTab === 'pending' ? '' : '?decision=' + tab.dataset.candTab);
      return;
    }
    if (pagerClick(event, 'candidates', climit, renderCandidates)) return;
    const btn = event.target.closest('[data-cand]');
    if (!btn) return;
    const isAccept = btn.dataset.cand === 'accept';
    const ok = await confirmAction({
      title: isAccept ? '采纳该知识候选？' : '拒绝该知识候选？',
      sub: btn.dataset.id,
      body: isAccept
        ? '采纳将生成一条 draft 记忆（进入审核队列，确认后才参与召回），并把候选标记为 accepted。'
        : '拒绝将把候选标记为 rejected 并保留记录（可在筛选里查看，不会生成记忆）。',
      impact: isAccept
        ? [`候选 ${btn.dataset.id} → decision: accepted`, '生成 draft 记忆（FTS / 语义索引入队）', '审计新增 candidate.accepted（actor=web）']
        : [`候选 ${btn.dataset.id} → decision: rejected`, '审计新增 candidate.rejected（actor=web）'],
      confirmLabel: isAccept ? '确认采纳' : '确认拒绝',
      danger: !isAccept,
    });
    if (!ok) return;
    try {
      const result = await api(`/api/candidates/${btn.dataset.id}/${isAccept ? 'accept' : 'reject'}`, {
        method: 'POST',
        body: JSON.stringify({ reason: isAccept ? 'accepted via web workbench' : 'rejected via web workbench' }),
      });
      if (isAccept) {
        toast('ok', '已采纳为 draft', `${result.memory.id} 待审核确认`, '去审核队列');
      } else {
        toast('ok', '已拒绝候选', `${btn.dataset.id} · 记录保留可追溯`, '查看审计');
      }
      renderCandidates();
    } catch (error) {
      toast('danger', '操作失败', error.message);
    }
  });
}

/* ---------- router ---------- */
const PAGES = {
  overview: { title: '概览', crumb: 'brain / 总览', render: renderOverview },
  memories: { title: '记忆库', crumb: 'brain / 记忆库', render: renderMemories },
  review: { title: '审核队列', crumb: 'brain / 治理 / 审核', render: renderReview },
  candidates: { title: '知识候选', crumb: 'brain / 蒸馏与反思 / 候选', render: renderCandidates },
  garden: { title: '记忆花园', crumb: 'brain / 治理 / 花园', render: renderGarden },
  search: { title: '搜索与召回调试', crumb: 'brain / 检索 / 调试', render: renderSearch },
  context: { title: 'Context Pack', crumb: 'brain / 会话 / context pack', render: renderContext },
  audit: { title: '审计与时间线', crumb: 'brain / 审计', render: renderAudit },
  projects: { title: '项目与会话', crumb: 'brain / 项目', render: renderProjects },
  packs: { title: '知识包', crumb: 'brain / 知识包', render: renderPacks },
  system: { title: '系统与设置', crumb: 'brain / 系统', render: renderSystem },
};

async function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [pathPart] = hash.split('?');
  const segments = (pathPart || 'overview').split('/').filter(Boolean);
  try {
    if (segments[0] === 'memories' && segments[1] === 'new') {
      $('#page-title').textContent = '记忆编辑'; $('#page-crumb').textContent = 'brain / 记忆库 / 新建';
      await renderEdit(null);
    } else if (segments[0] === 'memories' && segments[1] && segments[2] === 'edit') {
      $('#page-title').textContent = '记忆编辑'; $('#page-crumb').textContent = `brain / 记忆库 / ${segments[1]} / 编辑`;
      await renderEdit(segments[1]);
    } else if (segments[0] === 'memories' && segments[1]) {
      $('#page-title').textContent = '记忆详情'; $('#page-crumb').textContent = `brain / 记忆库 / ${segments[1]}`;
      await renderDetail(segments[1]);
    } else {
      const page = PAGES[segments[0] || 'overview'] || PAGES.overview;
      $('#page-title').textContent = page.title;
      $('#page-crumb').textContent = page.crumb;
      await page.render();
    }
  } catch (error) {
    pageEl.innerHTML = `<div class="card"><div class="banner danger">加载失败：${esc(error.message)}</div>
      <div class="row"><button class="btn" onclick="location.reload()">重试</button></div></div>`;
  }
  document.querySelectorAll('#nav a').forEach((link) => {
    link.classList.toggle('active', link.dataset.page === (segments[0] || 'overview'));
  });
}

window.addEventListener('hashchange', route);
initChrome().then(route).catch((error) => {
  pageEl.innerHTML = `<div class="card"><div class="banner danger">初始化失败：${esc(error.message)}</div></div>`;
});
