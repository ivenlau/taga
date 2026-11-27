import { icon } from '../icons.js';
import { $, PAGER, api, confirmAction, emptyState, esc, listenPage, pageEl, pagerBar, pagerClick, previewModal, toast } from '../core.js';

export async function renderCandidates() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const decision = params.get('decision') || 'pending';
  const data = await api('/api/candidates' + (decision === 'all' ? '' : '?decision=' + decision));
  const counts = data.counts;
  const climit = 5;
  let coffset = PAGER.candidates || 0;
  if (coffset >= data.items.length) { coffset = 0; PAGER.candidates = 0; }
  const visible = data.items.slice(coffset, coffset + climit);
  const selected = new Set();
  const originOf = (id) => (String(id).includes('reflect') ? '反思 Reflect' : '蒸馏 Distill');
  const originIcon = (id) => (String(id).includes('reflect') ? 'sprout' : 'layers');
  const factRow = (fact) => `
    <div class="row" style="gap:8px;align-items:flex-start">
      <span class="dot" style="background:var(--accent);margin-top:6px"></span>
      <div style="flex:1"><div class="small" style="color:var(--text)">${esc(fact.text)}</div>
      <div class="mono faint" style="font-size:10px">evidence: ${esc((fact.evidenceIds || []).join(', ') || '—')} · confidence ${fact.confidence !== undefined ? Number(fact.confidence).toFixed(2) : '—'}</div></div>
    </div>`;
  pageEl.classList.add('fill');
  pageEl.innerHTML = `
    <div class="banner info">${icon('info', 15, 'var(--info)')}候选由蒸馏（观察 → 结构化知识）与反思（记忆组 → 洞见）产出，<b>一律停在待审层</b>；采纳后生成 draft 记忆，经审核队列确认才进入召回。</div>
    <div class="row">
      ${[['pending', `待审 ${counts.pending || 0}`], ['accepted', `已采纳 ${counts.accepted || 0}`], ['rejected', `已拒绝 ${counts.rejected || 0}`], ['all', `全部 ${data.total}`]]
      .map(([key, t]) => `<span class="chip ${decision === key ? 'on' : ''}" data-cand-tab="${key}">${t}</span>`).join('')}
      <div class="spacer"></div>
      <span class="small faint">来源：蒸馏（观察 → 结构化）· 反思（记忆组 → 洞见）· 手动创建 · 存储于 SQLite</span>
    </div>
    <div class="row" style="background:var(--accent-soft);border:1px solid var(--accent);border-radius:10px;padding:10px 16px">
      ${icon('check', 15, 'var(--warn)')}
      <b class="small">已选 <span id="cand-sel-count">0</span> / ${data.items.length} 条</b>
      <div class="spacer"></div>
      <button class="btn small" id="cand-select-all">${icon('check', 13)}全选</button>
      <button class="btn small" id="cand-select-clear">${icon('x', 13)}清空</button>
      <button class="btn primary small" id="cand-batch-accept" disabled>${icon('circleCheck', 13)}批量采纳…</button>
      <button class="btn danger-ghost small" id="cand-batch-reject" disabled>${icon('circleX', 13)}批量拒绝…</button>
    </div>
    <div class="fill-area list-card">
      <div class="list-scroll stack">
    ${data.items.length === 0 ? `<div class="card">${emptyState('暂无候选 · 蒸馏与反思产出会出现在这里', 'inbox')}</div>` :
      visible.map((c) => `
      <div class="card" data-cand-preview="${esc(c.id)}" style="cursor:pointer">
        <div class="row">
          <span class="checkbox ${selected.has(c.id) ? 'on' : ''}" data-cand-sel="${esc(c.id)}"></span>
          <span class="badge ${String(c.id).includes('reflect') ? 'warn' : 'info'}">${icon(originIcon(c.id), 12)}${originOf(c.id)}</span>
          <span class="badge neutral">${esc(c.memoryType)}</span>
          <span class="badge ${c.decision === 'accepted' ? 'ok' : c.decision === 'rejected' ? 'danger' : 'accent'}"><span class="dot"></span>${esc(c.decision)}</span>
          ${c.worthLearning ? `<span class="badge ok">${icon('circleCheck', 11)}worth learning</span>` : `<span class="badge neutral">${icon('alert', 11)}low reuse</span>`}
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
          <div class="eyebrow">${icon('database', 12)} FACTS · 结构化事实（引用证据）</div>
          <div style="display:flex;flex-direction:column;gap:8px;margin-top:6px">${c.facts.map(factRow).join('')}</div>
        </div>` : ''}
        ${(c.entities || []).length > 0 ? `
        <div class="row" style="gap:8px">
          <span class="eyebrow">${icon('package', 12)} ENTITIES</span>
          ${c.entities.map((e) => `<span class="tag">${esc(e.name)}${e.type ? ' · ' + esc(e.type) : ''}</span>`).join('')}
        </div>` : ''}
        ${(c.temporalFacts || []).length > 0 ? `
        <div>
          <div class="eyebrow">${icon('history', 12)} TEMPORAL FACTS</div>
          ${c.temporalFacts.map((t) => `<div class="mono small faint">⏱ ${esc(t.text)} ${t.occurredStart ? '（' + esc(String(t.occurredStart).slice(0, 10)) + (t.occurredEnd ? ' ~ ' + esc(String(t.occurredEnd).slice(0, 10)) : '') + '）' : ''}</div>`).join('')}
        </div>` : ''}
        ${(c.causalLinks || []).length > 0 ? `
        <div>
          <div class="eyebrow">${icon('chevronRight', 12)} CAUSAL LINKS</div>
          ${c.causalLinks.map((l) => `<div class="mono small faint">${esc(String(l.fromFact))} —[${esc(l.relation)}]→ ${esc(String(l.toFact))}</div>`).join('')}
        </div>` : ''}
        ${c.applicabilityDetails ? `
        <div class="row" style="align-items:stretch">
          <div class="cmp a" style="padding:12px 14px"><span class="eyebrow">${icon('circleCheck', 12)} 适用条件</span>
            ${(c.applicabilityDetails.conditions || []).map((t) => `<div class="small muted">✓ ${esc(t)}</div>`).join('') || '<div class="small faint">—</div>'}</div>
          <div class="cmp b" style="padding:12px 14px"><span class="eyebrow">${icon('circleX', 12)} 排除条件</span>
            ${(c.applicabilityDetails.exclusions || []).map((t) => `<div class="small muted">✕ ${esc(t)}</div>`).join('') || '<div class="small faint">—</div>'}</div>
        </div>` : ''}
        ${c.model ? `
        <div class="mono faint" style="font-size:10px">model trace: ${esc(c.model.mode)} · ${esc(c.model.model || '')} · ${esc(c.model.promptVersion || '')}${c.model.inputTokens !== undefined ? ' · ' + c.model.inputTokens + '/' + c.model.outputTokens + ' tok' : ''}${c.model.latencyMs !== undefined ? ' · ' + c.model.latencyMs + 'ms' : ''}</div>` : ''}
        <div class="mono faint" style="font-size:10px">${esc(c.id)} · evidence: ${esc((c.evidenceIds || []).join(', '))}${c.createdAt ? ' · ' + esc(String(c.createdAt).slice(0, 16).replace('T', ' ')) : ''}</div>
        ${c.decision === 'pending' ? `
        <div class="row">
          <button class="btn primary small" data-cand="accept" data-id="${esc(c.id)}">${icon('circleCheck', 13)}采纳为 draft…</button>
          <button class="btn danger-ghost small" data-cand="reject" data-id="${esc(c.id)}">${icon('circleX', 13)}拒绝…</button>
          <div class="spacer"></div>
          <span class="mono small faint">操作写入审计 · 可追溯</span>
        </div>` : `<div class="small faint">已裁决：${esc(c.decision)}${c.decisionReason ? ' · ' + esc(c.decisionReason) : ''}${c.decidedAt ? ' · ' + esc(String(c.decidedAt).slice(0, 16).replace('T', ' ')) : ''}</div>`}
      </div>`).join('')}
      </div>
      <div class="card" style="padding:0;overflow:hidden">${pagerBar('candidates', data.items.length, coffset, climit)}</div>
    </div>`;

  const refreshSel = () => {
    const count = $('#cand-sel-count');
    if (count) count.textContent = String(selected.size);
    const pendingSelected = [...selected].filter((id) => data.items.find((x) => x.id === id)?.decision === 'pending').length;
    const accept = $('#cand-batch-accept');
    const reject = $('#cand-batch-reject');
    if (accept) accept.disabled = pendingSelected === 0;
    if (reject) reject.disabled = pendingSelected === 0;
    pageEl.querySelectorAll('[data-cand-sel]').forEach((box) => {
      box.classList.toggle('on', selected.has(box.dataset.candSel));
    });
  };

  const runBatch = async (isAccept) => {
    const ids = [...selected].filter((id) => data.items.find((x) => x.id === id)?.decision === 'pending');
    const skipped = selected.size - ids.length;
    if (ids.length === 0) return;
    const ok = await confirmAction({
      title: isAccept ? `批量采纳 ${ids.length} 条知识候选？` : `批量拒绝 ${ids.length} 条知识候选？`,
      sub: ids.slice(0, 3).join(' · ') + (ids.length > 3 ? ' …' : ''),
      body: isAccept
        ? '采纳将为每条候选生成 draft 记忆（进入审核队列，确认后才参与召回），并标记为 accepted。'
        : '拒绝将把所选候选标记为 rejected 并保留记录（不会生成记忆）。',
      impact: [
        ...ids.slice(0, 4).map((id) => `${id} → ${isAccept ? 'accepted + draft 记忆' : 'rejected'}`),
        ...(ids.length > 4 ? [`${ids.length - 4} 条同理…`] : []),
        ...(skipped > 0 ? [`跳过 ${skipped} 条非待审项`] : []),
        '审计逐条记录（actor=web）',
      ],
      confirmLabel: isAccept ? '确认批量采纳' : '确认批量拒绝',
      danger: !isAccept,
    });
    if (!ok) return;
    let done = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        await api(`/api/candidates/${id}/${isAccept ? 'accept' : 'reject'}`, {
          method: 'POST',
          body: JSON.stringify({ reason: isAccept ? 'batch accepted via web workbench' : 'batch rejected via web workbench' }),
        });
        done += 1;
      } catch {
        failed += 1;
      }
    }
    if (failed === 0) {
      toast('ok', isAccept ? '批量采纳完成' : '批量拒绝完成', `${done} 条${skipped > 0 ? ` · 跳过 ${skipped} 条非待审` : ''}${isAccept ? ' · draft 记忆待审核确认' : ''}`, isAccept ? '去审核队列' : '查看审计');
    } else {
      toast('warn', '批量操作部分失败', `成功 ${done} 条 · 失败 ${failed} 条${skipped > 0 ? ` · 跳过 ${skipped} 条非待审` : ''}`);
    }
    renderCandidates();
  };

  $('#cand-select-all').addEventListener('click', () => {
    data.items.forEach((c) => selected.add(c.id));
    refreshSel();
  });
  $('#cand-select-clear').addEventListener('click', () => {
    selected.clear();
    refreshSel();
  });
  $('#cand-batch-accept').addEventListener('click', () => runBatch(true));
  $('#cand-batch-reject').addEventListener('click', () => runBatch(false));
  refreshSel();

  listenPage( async (event) => {
    const tab = event.target.closest('[data-cand-tab]');
    if (tab) {
      location.hash = '#/candidates' + (tab.dataset.candTab === 'pending' ? '' : '?decision=' + tab.dataset.candTab);
      return;
    }
    if (pagerClick(event, 'candidates', climit, renderCandidates)) return;
    const sel = event.target.closest('[data-cand-sel]');
    if (sel) {
      const id = sel.dataset.candSel;
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      refreshSel();
      return;
    }
    const cp = event.target.closest('[data-cand-preview]');
    if (cp && !event.target.closest('button, a, [data-cand-sel]')) {
      const c = data.items.find((x) => x.id === cp.dataset.candPreview);
      if (c) previewModal({
        title: c.title,
        sub: `${c.id} · ${originOf(c.id)} · ${c.memoryType} · confidence ${Number(c.confidence ?? 0.7).toFixed(2)}`,
        html: `
          <div class="small muted" style="margin-bottom:10px">${esc(c.summary)}</div>
          <div class="code-block preview-main">${esc(c.body)}</div>
          ${(c.facts || []).length ? `<div class="eyebrow">FACTS · 结构化事实（引用证据）</div><div style="display:flex;flex-direction:column;gap:8px;margin:6px 0 10px">${c.facts.map(factRow).join('')}</div>` : ''}
          ${(c.entities || []).length ? `<div class="row" style="gap:8px;margin-bottom:10px"><span class="eyebrow">ENTITIES</span>${c.entities.map((e) => `<span class="tag">${esc(e.name)}${e.type ? ' · ' + esc(e.type) : ''}</span>`).join('')}</div>` : ''}
          ${(c.causalLinks || []).length ? `<div class="eyebrow">CAUSAL LINKS</div>${c.causalLinks.map((l) => `<div class="mono small faint">${esc(String(l.fromFact))} —[${esc(l.relation)}]→ ${esc(String(l.toFact))}</div>`).join('')}` : ''}`,
      });
      return;
    }
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
