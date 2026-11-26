import { icon } from '../icons.js';
import { PAGER, api, emptyState, esc, fmtTime, kv, listenPage, pageEl, pagerBar, pagerClick } from '../core.js';

export async function renderProjects() {
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
