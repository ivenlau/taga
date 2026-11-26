import { icon } from '../icons.js';
import { $, api, confirmAction, downloadFile, emptyState, esc, fmtTime, listenPage, pageEl, setNavCounts, toast } from '../core.js';

export async function renderOverview() {
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
  pageEl.classList.add('fill');
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
    <div class="grid cols-2 fill-area" style="align-items:stretch">
      <div class="card list-card">
        <div class="card-head"><h2>待审核队列</h2><div class="spacer"></div>
          ${data.reviewBacklogCount ? `<span class="badge warn">${data.reviewBacklogCount} 待处理</span>` : ''}</div>
        <div class="list-scroll">
          ${data.reviewBacklog.length === 0 ? emptyState('审核队列已清空') : data.reviewBacklog.map((item) => `
          <div class="row" style="border-bottom:1px solid var(--border-soft);padding:10px 0">
            <div style="flex:1"><a href="#/memories/${esc(item.id)}" class="small"><b>${esc(item.title)}</b></a>
              <div class="mono faint" style="font-size:11px">${esc(item.id)} · ${esc(item.status)} · ${esc(item.type)} · ${fmtTime(item.updated)}</div></div>
            <button class="btn small" data-quick="promote" data-id="${esc(item.id)}">确认</button>
            <button class="btn danger-ghost small" data-quick="forget" data-id="${esc(item.id)}">丢弃</button>
          </div>`).join('')}
        </div>
      </div>
      <div class="card list-card">
        <div class="card-head"><h2>最近审计</h2><div class="spacer"></div><a class="small" style="color:var(--warn)" href="#/audit">查看全部 →</a></div>
        <div class="timeline list-scroll">
          ${data.audit.recent.map((r) => `
            <div class="tl-item" style="padding:10px 0">
              <div class="time">${fmtTime(r.occurredAt).slice(5)}</div>
              <div class="desc" style="display:flex;gap:8px;align-items:center">
                <span class="badge accent">${esc(r.actor)}${r.actorId ? '/' + esc(r.actorId) : ''}</span>
                <span class="mono" style="color:var(--text)">${esc(r.eventType)}</span>
                <span class="mono faint" style="flex:1;min-width:0;word-break:break-all">${esc(r.subjectId)}</span>
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
