import { icon } from './icons.js';

export const state = { themes: [], defaultTheme: 'morandi', navCounts: { review: 0, garden: 0 } };
export const $ = (selector) => document.querySelector(selector);
export const pageEl = $('#page');

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

export async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({ ok: false, message: '响应解析失败' }));
  if (!response.ok || payload.ok !== true) throw new Error(payload.message || `请求失败 (${response.status})`);
  return payload.data;
}
export const TOAST_ROUTES = { '去审核队列': '#/review', '查看审计': '#/audit', '查看规则': '#/packs' };
export function toast(kind, title, body, action) {
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

export function confirmAction({ title, sub = '', body = '', impact = [], confirmLabel = '确认', danger = false, typed = null }) {
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

export function previewModal({ title, sub = '', html = '' }) {
  $('#modal-root').innerHTML = `
    <div class="modal-backdrop">
      <div class="modal preview-modal">
        <div class="modal-head">
          <div class="icon-circle">${icon('book', 18)}</div>
          <div style="flex:1">
            <h3>${esc(title)}</h3>
            ${sub ? `<div class="mono small faint">${esc(sub)}</div>` : ''}
          </div>
        </div>
        <div class="preview-body">${html}</div>
        <div class="actions">
          <button class="btn" id="modal-cancel">关闭</button>
        </div>
      </div>
    </div>`;
  $('#modal-cancel').addEventListener('click', () => { $('#modal-root').innerHTML = ''; });
  $('#modal-root').querySelector('.modal-backdrop').addEventListener('click', (event) => {
    if (event.target.classList.contains('modal-backdrop')) $('#modal-root').innerHTML = '';
  });
}

export async function openMemoryPreview(id, fallbackTitle = '') {
  previewModal({ title: fallbackTitle || '加载中…', sub: id, html: '<div class="skeleton" style="width:60%"></div><div class="skeleton" style="width:80%"></div>' });
  try {
    const data = await api('/api/memories/' + encodeURIComponent(id));
    const m = data.memory;
    previewModal({
      title: m.title,
      sub: `${m.id} · ${m.type} · ${m.status} · ${m.scope?.kind}${m.scope?.id ? ':' + m.scope.id : ''}`,
      html: `
        <div class="small muted" style="margin-bottom:10px">${esc(m.summary)}</div>
        <div class="code-block preview-main">${esc(data.body ?? '')}</div>
        ${kv([['更新', fmtTime(m.updated)], ['useful / not_useful', `${m.usefulCount ?? 0} / ${m.notUsefulCount ?? 0}`], ['tags', (m.tags || []).join(', ') || '—'], ['sourceTrust', m.sourceTrust]])}
        <div class="row" style="margin-top:12px">
          <a class="btn small" href="#/memories/${esc(m.id)}" data-close-preview>查看详情页 →</a>
          <a class="btn small" href="#/memories/${esc(m.id)}/edit" data-close-preview>编辑 →</a>
        </div>`,
    });
    $('#modal-root').querySelectorAll('[data-close-preview]').forEach((link) => {
      link.addEventListener('click', () => { $('#modal-root').innerHTML = ''; });
    });
  } catch (error) {
    previewModal({ title: fallbackTitle || '预览失败', sub: id, html: `<div class="banner danger">${esc(error.message)}</div>` });
  }
}

export function statusBadge(status) {
  const kind = { active: 'ok', draft: 'warn', candidate: 'info', stale: 'neutral', superseded: 'neutral', forgotten: 'danger' }[status] || 'neutral';
  return `<span class="badge ${kind}"><span class="dot"></span>${esc(status)}</span>`;
}
export function kv(rows) {
  return `<div class="kv">${rows.map(([k, v]) => `<div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>`).join('')}</div>`;
}
export function emptyState(text, iconName = 'inbox', color = 'var(--ok)') {
  return `<div class="empty"><div class="icon-circle" style="background:var(--accent-soft);color:${color}">${icon(iconName, 20)}</div>${esc(text)}</div>`;
}
export function fmtTime(value) { return String(value || '').slice(0, 19).replace('T', ' '); }

/* ---------- pagination & delegation ---------- */
export const PAGER = {};
export const listenPage = (handler) => { pageEl.onclick = handler; };

export function pagerBar(key, total, offset, limit) {
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

export function pagerClick(event, key, limit, rerender) {
  const btn = event.target.closest(`[data-pager="${key}"]`);
  if (!btn || btn.hasAttribute('disabled')) return false;
  PAGER[key] = (Number(btn.dataset.page) - 1) * limit;
  rerender();
  return true;
}

export function downloadFile(name, content, mime) {
  const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function diffLines(oldText, newText) {
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
export function setNavCounts(review, garden) {
  state.navCounts = { review, garden };
  $('#nav-review-count').textContent = review > 0 ? String(review) : '';
  $('#nav-garden-count').textContent = garden > 0 ? String(garden) : '';
}

/* ---------- S2 记忆库 ---------- */
