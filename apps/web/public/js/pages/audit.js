import { icon } from '../icons.js';
import { $, api, downloadFile, emptyState, esc, fmtTime, kv, listenPage, pageEl, pagerBar, toast } from '../core.js';

export async function renderAudit() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const actor = params.get('actor') || '';
  const action = params.get('action') || '';
  const offset = Math.max(0, Number(params.get('offset') || '0') || 0);
  const query = new URLSearchParams({ limit: '10', offset: String(offset) });
  if (actor) query.set('actor', actor);
  if (action) query.set('eventType', action);
  const data = await api('/api/audit?' + query.toString());
  const actorColor = { web: 'var(--accent)', daemon: 'var(--info)', agent: 'var(--warn)', system: 'var(--text-muted)', user: 'var(--accent)' };
  const byDay = {};
  for (const record of data.items) {
    const day = record.occurredAt.slice(0, 10);
    (byDay[day] = byDay[day] || []).push(record);
  }
  pageEl.classList.add('fill');
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
    <div class="split fill-area">
      <div class="card list-card" style="flex:1 1 480px;min-width:0;padding:8px 22px">
        <div class="list-scroll">
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
        </div>
        ${pagerBar('audit', data.total, data.offset ?? offset, data.limit ?? 10)}
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
      if (page > 1) next.set('offset', String((page - 1) * 10));
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
