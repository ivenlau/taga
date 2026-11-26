import { $, api, confirmAction, downloadFile, emptyState, esc, fmtTime, kv, pageEl, toast } from '../core.js';

export async function renderContext() {
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
