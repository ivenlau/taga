import { icon } from '../icons.js';
import { $, PAGER, api, confirmAction, emptyState, esc, fmtTime, listenPage, openMemoryPreview, pageEl, pagerBar, pagerClick, setNavCounts, state, statusBadge, toast } from '../core.js';

export async function renderReview() {
  const [drafts, candidates] = await Promise.all([
    api('/api/memories?status=draft&limit=50'), api('/api/memories?status=candidate&limit=50'),
  ]);
  const items = [...drafts.items, ...candidates.items]
    .sort((left, right) => String(right.updated ?? '').localeCompare(String(left.updated ?? '')));
  setNavCounts(items.length, state.navCounts.garden);
  const selected = new Set();
  const limit = 10;
  let offset = PAGER.review || 0;
  if (offset >= items.length) { offset = 0; PAGER.review = 0; }
  const visible = items.slice(offset, offset + limit);
  pageEl.classList.add('fill');
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
    <div class="fill-area list-card">
      <div class="list-scroll stack">
        ${items.length === 0 ? `<div class="card">${emptyState('审核队列已清空')}</div>` : visible.map((m) => `
      <div class="card" data-preview="${esc(m.id)}" style="gap:10px;cursor:pointer">
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
      </div>
      <div class="card" style="padding:0;overflow:hidden">${pagerBar('review', items.length, offset, limit)}</div>
    </div>`;
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
    const pv = event.target.closest('[data-preview]');
    if (pv && !event.target.closest('button, a')) { openMemoryPreview(pv.dataset.preview); return; }
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
