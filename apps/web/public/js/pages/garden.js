import { icon } from '../icons.js';
import { $, PAGER, api, confirmAction, emptyState, esc, listenPage, openMemoryPreview, pageEl, pagerBar, pagerClick, setNavCounts, state, statusBadge, toast } from '../core.js';

export async function renderGarden() {
  const data = await api('/api/garden');
  const counts = { duplicate: 0, stale: 0, conflict: 0 };
  data.proposals.filter((p) => p.status === 'pending').forEach((p) => { counts[p.category] = (counts[p.category] || 0) + 1; });
  setNavCounts(state.navCounts.review, counts.duplicate + counts.stale + counts.conflict);
  const cat = PAGER.gardenCat || 'all';
  const all = data.proposals.filter((p) => cat === 'all' || p.category === cat);
  const glimit = 5;
  let goffset = PAGER.garden || 0;
  if (goffset >= all.length) { goffset = 0; PAGER.garden = 0; }
  const visible = all.slice(goffset, goffset + glimit);
  const panel = (m, role) => `
    <div class="cmp ${role === 'primary' ? 'a' : 'b'}" data-preview="${esc(m.id)}" style="cursor:pointer">
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
  pageEl.classList.add('fill');
  pageEl.innerHTML = `
    <div class="row">
      ${[['all', '全部', data.proposals.length], ['duplicate', '重复 duplicate', counts.duplicate], ['stale', '过期 stale', counts.stale], ['conflict', '冲突 conflict', counts.conflict]]
      .map(([key, t, n]) => `<span class="chip ${cat === key ? 'on' : ''}" data-garden-cat="${key}">${t} <b>${n}</b></span>`).join('')}
      <div class="spacer"></div>
      <span class="small faint">裁决不会自动执行：LLM 只出建议，接受才走治理服务并写审计</span>
      <button class="btn" id="garden-scan">${icon('refresh', 14)}重新扫描</button>
    </div>
    <div class="fill-area list-card">
      <div class="list-scroll stack">
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
            <div class="small faint">「采纳合并稿」= 改写主记忆为合并稿（supersede + 审计）→ 淘汰重复候选 → 合并稿经审核队列确认后生效。全程留痕可追溯。</div>
          ` : '<div class="small faint">LLM 判定无需合并文本（duplicate / keep）。</div>'}
        </div>` : ''}
        ${p.adjudication && p.adjudication.adjudicated !== false ? `
        <div class="card" style="background:var(--accent-soft);border-color:var(--warn);padding:16px 18px">
          <div class="row" style="gap:10px">
            <span class="badge ${p.adjudication.verdict === 'merge' ? 'warn' : p.adjudication.verdict === 'keep-both' ? 'ok' : 'danger'}"><span class="dot"></span>LLM 裁决建议：${esc(String(p.adjudication.verdict))}</span>
            <span class="small muted">${esc(String(p.adjudication.reason || ''))}</span>
          </div>
          ${p.adjudication.mergedText ? `
            <div class="eyebrow">合并草稿（裁决建议）</div>
            <div class="code-block" style="font-size:12px">${esc(String(p.adjudication.mergedText))}</div>` : ''}
          <div class="small faint">建议仅供参考；快捷按钮走治理服务执行并写审计。A/B 对应下方两块记忆（prefer-a = 保留 A）。</div>
        </div>` : ''}
        ${p.status === 'pending' ? `
        ${p.adjudication && p.adjudication.adjudicated !== false ? `
        <div class="row">
          ${p.adjudication.verdict === 'keep-both' ? `<button class="btn small" data-garden="ignored" data-id="${esc(p.id)}">按建议：保留双方…</button>` : ''}
          ${p.adjudication.verdict === 'prefer-a' ? `<button class="btn small" data-garden="accepted" data-id="${esc(p.id)}" data-action="mark_stale" data-target="${esc((p.affectedIds || [])[1] || '')}">按建议：淘汰 B…</button>` : ''}
          ${p.adjudication.verdict === 'prefer-b' ? `<button class="btn small" data-garden="accepted" data-id="${esc(p.id)}" data-action="mark_stale" data-target="${esc((p.affectedIds || [])[0] || '')}">按建议：淘汰 A…</button>` : ''}
          ${p.adjudication.verdict === 'merge' && p.adjudication.mergedText ? `<button class="btn primary small" data-adopt="${esc(p.id)}">按建议：采纳合并稿…</button>` : ''}
        </div>` : ''}
        <div class="row">
          ${(p.llm && p.llm.mergedText) || (p.adjudication && p.adjudication.adjudicated !== false && p.adjudication.mergedText) ? `<button class="btn primary small" data-adopt="${esc(p.id)}">采纳 LLM 合并稿…</button>` : ''}
          <button class="btn small" data-garden="accepted" data-id="${esc(p.id)}" data-action="${esc(p.suggestedAction)}" data-target="${esc((p.affectedIds || [])[0] || '')}">接受提案（${esc(p.suggestedAction)}）…</button>
          <button class="btn small" data-garden="ignored" data-id="${esc(p.id)}">忽略</button>
          <div class="spacer"></div>
          <span class="mono small faint">裁决均写入审计 · 可追溯</span>
          <button class="btn danger-ghost small" data-garden="rejected" data-id="${esc(p.id)}">拒绝</button>
        </div>` : ''}
      </div>`).join('')}
      </div>
      <div class="card" style="padding:0;overflow:hidden">${pagerBar('garden', all.length, goffset, glimit)}</div>
    </div>`;
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
    const pv = event.target.closest('[data-preview]');
    if (pv && !event.target.closest('button, a')) { openMemoryPreview(pv.dataset.preview); return; }
    const adopt = event.target.closest('[data-adopt]');
    if (adopt) {
      const proposal = data.proposals.find((item) => item.id === adopt.dataset.adopt);
      const members = (proposal?.memories || []).filter((m) => !m.missing);
      const primary = members.find((m) => m.role === 'primary') ?? members[0];
      const candidate = members.find((m) => m !== primary);
      const mergedText = proposal?.adjudication?.mergedText ?? proposal?.llm?.mergedText;
      if (!primary || !mergedText) { toast('warn', '无法采纳', '缺少主记忆或合并稿'); return; }
      const ok = await confirmAction({
        title: '采纳 LLM 合并稿？', sub: `提案 ${proposal.id}`,
        body: '这将执行一次受治理的合并：改写主记忆为合并稿并淘汰重复候选。合并稿以新版本形式生成，需在审核队列确认后进入召回。',
        impact: [
          `主记忆 ${primary.id} → 正文改为合并稿（supersede + 审计）`,
          candidate ? `候选 ${candidate.id} → forgotten（审计）` : '候选淘汰（审计）',
          '合并稿进入审核队列，确认后生效',
          'actor=web · 全部留痕',
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
          body: '接受会按建议动作执行治理变更（例如标记 stale / supersede），全部写入审计，可追溯。',
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
