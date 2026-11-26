import { icon } from '../icons.js';
import { $, PAGER, api, confirmAction, emptyState, esc, kv, listenPage, pageEl, pagerBar, pagerClick, toast } from '../core.js';

export async function renderSystem() {
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
