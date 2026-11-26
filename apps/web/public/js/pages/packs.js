import { icon } from '../icons.js';
import { $, PAGER, api, emptyState, esc, fmtTime, kv, listenPage, pageEl, pagerBar, pagerClick, toast } from '../core.js';
import { TYPE_OPTIONS } from './memories.js';

export async function renderPacks() {
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
