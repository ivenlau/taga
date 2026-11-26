import { icon } from '../icons.js';
import { $, api, confirmAction, diffLines, emptyState, esc, fmtTime, kv, listenPage, pageEl, pagerBar, statusBadge, toast } from '../core.js';

export const TYPE_OPTIONS = ['preferences', 'environment', 'procedures', 'lessons', 'projects'];
export const STATUS_OPTIONS = ['draft', 'candidate', 'active', 'stale', 'superseded', 'forgotten'];

export async function renderMemories() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const type = params.get('type') || '';
  const status = params.get('status') || '';
  const q = params.get('q') || '';
  const offset = Math.max(0, Number(params.get('offset') || '0') || 0);
  const query = new URLSearchParams({ limit: '10', offset: String(offset) });
  if (type) query.set('type', type);
  if (status) query.set('status', status);
  if (q) query.set('q', q);
  const data = await api('/api/memories?' + query.toString());
  const counts = {};
  for (const key of [...TYPE_OPTIONS, ...STATUS_OPTIONS]) counts[key] = '';
  pageEl.classList.add('fill');
  pageEl.innerHTML = `
    <div class="split fill-area">
      <div class="card filter-panel">
        <div class="card-head">${icon('filter', 14, 'var(--text-muted)')}<h2>筛选</h2><div class="spacer"></div>
          <span class="small faint" style="cursor:pointer" id="filter-reset">重置</span></div>
        <div style="display:flex;flex-direction:column;gap:9px">
          <div class="eyebrow">类型</div>
          ${TYPE_OPTIONS.map((t) => filterRow('type', t, type === t)).join('')}
        </div>
        <div style="display:flex;flex-direction:column;gap:9px">
          <div class="eyebrow">状态</div>
          ${STATUS_OPTIONS.map((t) => filterRow('status', t, status === t)).join('')}
        </div>
        <div style="display:flex;flex-direction:column;gap:9px">
          <div class="eyebrow">范围</div>
          <div class="row" style="gap:8px">
            ${['global', 'domain', 'project'].map((t) => `<span class="chip ${params.get('scope') === t ? 'on' : ''}" data-scope="${t}">${t}</span>`).join('')}
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:9px">
          <div class="eyebrow">项目</div>
          <div class="select-lite">taga · ivenlau/taga ${icon('chevronDown', 13, 'var(--text-faint)')}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:9px">
          <div class="eyebrow">时间</div>
          <div class="select-lite">最近 30 天 ${icon('chevronDown', 13, 'var(--text-faint)')}</div>
        </div>
      </div>
      <div class="main-col">
        <div class="row">
          <div class="search-input" style="flex:1">${icon('search', 15, 'var(--text-faint)')}
            <input id="mem-q" placeholder="搜索记忆内容、ID、标签…（支持语义检索）" value="${esc(q)}"></div>
          <div class="select-lite">更新时间 ↓ ${icon('chevronDown', 13, 'var(--text-faint)')}</div>
          <a class="btn primary" href="#/memories/new">新建记忆</a>
        </div>
        <div class="row">
          ${type ? `<span class="chip on">状态: ${esc(type)} ×</span>` : ''}
          ${status ? `<span class="chip on">状态: ${esc(status)} ×</span>` : ''}
          <span class="chip">共命中 ${data.total} 条</span>
          <span class="small faint" style="cursor:pointer" id="clear-all">清除全部</span>
        </div>
        <div class="table list-card" style="flex:1">
          <div class="list-scroll">
          <table>
            <thead><tr>
              <th></th><th class="mono">记忆 ID</th><th class="mono">摘要 / 内容</th><th class="mono">类型</th>
              <th class="mono">状态</th><th class="mono">范围</th><th class="mono">有用/无用</th><th class="mono">更新</th><th></th>
            </tr></thead>
            <tbody>
              ${data.items.length === 0 ? `<tr><td colspan="9">${emptyState('没有匹配的记忆')}</td></tr>` : data.items.map((m) => `
                <tr onclick="location.hash='#/memories/${esc(m.id)}'">
                  <td><span class="checkbox"></span></td>
                  <td class="mono">${esc(m.id)}</td>
                  <td><b>${esc(m.title)}</b><br><span class="small muted">${esc(m.summary)}</span></td>
                  <td class="mono faint">${esc(m.type)}</td>
                  <td>${statusBadge(m.status)}</td>
                  <td class="mono faint">${esc(m.scope?.kind)}${m.scope?.id ? ':' + esc(m.scope.id) : ''}</td>
                  <td class="mono">${m.usefulCount ?? 0} / ${m.notUsefulCount ?? 0}</td>
                  <td class="mono faint">${esc((m.updated || '').slice(0, 10))}</td>
                  <td>${icon('more', 16, 'var(--text-faint)')}</td>
                </tr>`).join('')}
            </tbody>
          </table>
          </div>
          ${pagerBar('memories', data.total, data.offset ?? offset, data.limit ?? 10)}
        </div>
      </div>
    </div>`;
  const go = (next) => { location.hash = '#/memories' + (next.toString() ? '?' + next.toString() : ''); };
  const build = () => {
    const next = new URLSearchParams();
    const activeType = document.querySelector('[data-filter="type"].on');
    const activeStatus = document.querySelector('[data-filter="status"].on');
    if (activeType) next.set('type', activeType.dataset.value);
    if (activeStatus) next.set('status', activeStatus.dataset.value);
    if ($('#mem-q').value) next.set('q', $('#mem-q').value);
    return next;
  };
  listenPage( (event) => {
    const row = event.target.closest('[data-filter]');
    if (row) {
      const group = row.dataset.filter;
      const wasOn = row.classList.contains('on');
      document.querySelectorAll(`[data-filter="${group}"]`).forEach((el) => el.classList.remove('on'));
      if (!wasOn) row.classList.add('on');
      go(build());
      return;
    }
    if (event.target.closest('#filter-reset') || event.target.closest('#clear-all')) { go(new URLSearchParams()); }
    const scope = event.target.closest('[data-scope]');
    if (scope) {
      const next = build();
      next.set('scope', scope.dataset.scope);
      go(next);
      return;
    }
    const pg = event.target.closest('[data-pager="memories"]');
    if (pg && !pg.hasAttribute('disabled')) {
      const next = build();
      const page = Number(pg.dataset.page);
      if (page > 1) next.set('offset', String((page - 1) * 10));
      go(next);
    }
  });
  $('#mem-q').addEventListener('keydown', (event) => { if (event.key === 'Enter') go(build()); });
}

export function filterRow(group, value, on) {
  return `<div class="checkbox-row" data-filter="${group}" data-value="${value}" style="cursor:pointer">
    <span class="checkbox ${on ? 'on' : ''}">${on ? icon('check', 10) : ''}</span>
    <span class="mono small" style="flex:1;color:var(--text)">${value}</span></div>`;
}

/* ---------- S3 记忆详情 ---------- */
export async function renderDetail(id) {
  const data = await api('/api/memories/' + encodeURIComponent(id));
  const m = data.memory;
  const body = data.body ?? '';
  const canPromote = m.status === 'draft' || m.status === 'candidate';
  const canStale = m.status === 'active';
  const canRefresh = m.status === 'stale';
  const forgotten = m.status === 'forgotten';
  const audit = data.audit || [];
  pageEl.classList.add('fill');
  pageEl.innerHTML = `
    <div class="card">
      <div class="row">
        <span class="mono" style="background:var(--input);padding:4px 10px;border-radius:6px;font-size:12px">${esc(m.id)}</span>
        ${statusBadge(m.status)}
        <span class="tag">scope: ${esc(m.scope?.kind)}${m.scope?.id ? ':' + esc(m.scope.id) : ''}</span>
        <span class="tag">type: ${esc(m.type)}</span>
        ${m.projectId ? `<span class="tag">project: ${esc(m.projectId)}</span>` : ''}
        <div class="spacer"></div>
        <span class="badge info">可回滚</span>
      </div>
      <h2 style="font-size:22px;font-weight:700">${esc(m.title)}</h2>
      <div class="mono small faint">创建 ${fmtTime(m.created)} · 更新 ${fmtTime(m.updated)} · content-hash ${esc((m.contentHash || '').slice(0, 10))}… · sourceTrust ${esc(m.sourceTrust)}</div>
      <div class="row">
        <a class="btn" href="#/memories/${esc(m.id)}/edit">${icon('pencil', 14)}编辑</a>
        ${canStale ? `<button class="btn" data-act="stale">标记 stale</button>` : ''}
        ${canRefresh ? `<button class="btn primary" data-act="refresh">刷新为 active</button>` : ''}
        <button class="btn" data-act="fb-useful">反馈 · 有用</button>
        <div class="spacer"></div>
        ${canPromote ? `<button class="btn primary" data-act="promote">确认晋升为 active</button>` : ''}
        ${forgotten ? '' : `<button class="btn danger-ghost" data-act="forget">${icon('trash', 14)}遗忘…</button>`}
      </div>
    </div>
    <div class="tabs">
      ${['内容', '时间线', `审计 ${audit.length}`, '召回记录', '关联记忆'].map((t, i) => `<span class="tab ${i === 0 ? 'on' : ''}" data-tab="${i}">${t}</span>`).join('')}
    </div>
    <div class="split fill-area">
      <div class="main-col" id="detail-tab-content">
        <div class="card list-card" style="flex:1">
          <div class="mono" style="font-size:15px;font-weight:700;color:var(--text)"># ${esc(m.title)}</div>
          <div class="small muted" style="line-height:1.7">${esc(m.summary)}</div>
          <div class="code-block list-scroll" style="background:var(--accent-soft)">${esc(body)}</div>
        </div>
      </div>
      <div class="rail" style="overflow-y:auto">
        <div class="card">
          <h2>元数据</h2>
          ${kv([
            ['type', m.type], ['status', m.status], ['scope', `${m.scope?.kind}${m.scope?.id ? ':' + m.scope.id : ''}`],
            ['project', m.projectId || '—'], ['use_count', String((m.usefulCount ?? 0) + (m.notUsefulCount ?? 0))],
            ['useful / not_useful', `${m.usefulCount ?? 0} / ${m.notUsefulCount ?? 0}`],
            ['sourceTrust', m.sourceTrust], ['visibility', m.visibility],
            ['tags', (m.tags || []).join(', ') || '—'], ['supersedes', m.supersedes || '—'],
          ])}
        </div>
        <div class="card">
          <h2>反馈</h2>
          ${kv([['useful', String(m.usefulCount ?? 0)], ['not_useful', String(m.notUsefulCount ?? 0)], ['review', String(m.reviewCount ?? 0)]])}
          <div class="banner info">反馈影响 confidence 与整合裁决，全部写入审计。</div>
        </div>
        <div class="card">
          <h2>整合判定 · consolidation</h2>
          ${data.dedup ? `
            <div class="row">
              <span class="badge ${data.dedup.verdict === 'merge' ? 'warn' : data.dedup.verdict === 'duplicate' ? 'danger' : 'ok'}"><span class="dot"></span>verdict: ${esc(String(data.dedup.verdict))}</span>
              ${data.dedup.score !== undefined ? `<span class="mono small faint">score ${Number(data.dedup.score).toFixed(3)}</span>` : ''}
              ${data.dedup.bestMatchId ? `<a class="mono small" style="color:var(--warn)" href="#/memories/${esc(String(data.dedup.bestMatchId))}">best match: ${esc(String(data.dedup.bestMatchId))}</a>` : ''}
            </div>
            ${data.dedup.mergedText ? `
              <div class="eyebrow">LLM 合并建议（mimo）</div>
              <div class="code-block" style="font-size:11px">${esc(String(data.dedup.mergedText))}</div>` : ''}
            <div class="small faint">0.95+ 判重（确定性）；0.88–0.95 由 LLM 裁决 merge / keep 并生成合并建议。</div>
          ` : '<div class="small faint">暂无整合判定 · draft 与 active 比对后由 daemon 记录。</div>'}
        </div>
      </div>
    </div>`;

  pageEl.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
    pageEl.querySelectorAll('.tab').forEach((t) => t.classList.remove('on'));
    tab.classList.add('on');
    const idx = tab.dataset.tab;
    const content = $('#detail-tab-content');
    if (idx === '0') return renderDetail(id);
    if (idx === '1' || idx === '2') {
      content.innerHTML = `<div class="card list-card" style="flex:1"><h2>${idx === '1' ? '时间线' : '审计记录'}</h2>
        <div class="list-scroll"><div class="timeline">
        ${audit.length === 0 ? emptyState('暂无审计事件') : audit.map((r) => `
          <div class="tl-item"><div class="time">${fmtTime(r.occurredAt)}</div>
          <div class="desc"><b>${esc(r.eventType)}</b> · ${esc(r.actor)}${r.actorId ? '/' + esc(r.actorId) : ''}<br>
          <span class="faint">${esc(r.reason)} · hash ${esc(r.eventHash)}</span></div></div>`).join('')}
      </div></div></div>`;
    } else if (idx === '3') {
      const recalls = audit.filter((r) => /recall|shadow|context/i.test(r.eventType));
      content.innerHTML = `<div class="card list-card" style="flex:1">
        <h2>召回记录</h2>
        ${kv([['lastRecalled', m.lastRecalled ? fmtTime(m.lastRecalled) : '—'], ['召回事件', String(recalls.length)]])}
        <div class="list-scroll">
        ${recalls.length === 0 ? emptyState('暂无召回事件 · memory_search 命中后会记录 recall 审计', 'search', 'var(--info)') : `
        <div class="timeline">
          ${recalls.map((r) => `
            <div class="tl-item"><div class="time">${fmtTime(r.occurredAt)}</div>
            <div class="desc"><b>${esc(r.eventType)}</b> · ${esc(r.actor)}<br>
            <span class="faint">${esc(r.reason)}${Object.keys(r.payload || {}).length ? ' · ' + esc(JSON.stringify(r.payload).slice(0, 120)) : ''}</span></div></div>`).join('')}
        </div>`}
        </div>
        <div class="banner info">召回轨迹与 S7 搜索调试、S8 Context Pack 的纳入决策互相印证；完整 trace 可在审计页按 subject 过滤。</div>
      </div>`;
    } else {
      content.innerHTML = `<div class="card list-card" style="flex:1">
        <h2>关联记忆</h2>
        <div class="list-scroll">
          ${(data.related || []).length === 0 ? '<div class="small faint">暂无词法相关记忆</div>' : (data.related || []).map((rel) => `
            <div class="row" style="border-bottom:1px solid var(--border-soft);padding:8px 0">
              <div style="flex:1">
                <a class="mono small" href="#/memories/${esc(rel.id)}">${esc(rel.id)}</a>
                <div class="small faint">${esc((rel.reason || []).join(' · '))}</div>
              </div>
              <span class="mono small" style="color:var(--warn)">${Number(rel.score).toFixed(2)}</span>
            </div>`).join('')}
        </div>
        <div class="small faint">基于词法相关性；语义相似度随语义检索卡接入。</div>
      </div>`;
    }
  }));

  listenPage( async (event) => {
    const btn = event.target.closest('button[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    try {
      if (act === 'forget') {
        const ok = await confirmAction({
          title: '确认遗忘这条记忆？', sub: `${m.id} · ${m.title}`,
          body: '该记忆将标记为 forgotten 并退出所有默认召回；Markdown 归档保留，审计事件完整记录。此操作需要输入式确认。',
          impact: [`status：${m.status} → forgotten`, '退出 Context Pack 与搜索召回', '审计新增 lifecycle.forget（actor=web）', '可从归档恢复，但需重新确认启用'],
          confirmLabel: '确认遗忘', danger: true, typed: 'FORGET',
        });
        if (!ok) return;
        await api(`/api/memories/${id}/transition`, { method: 'POST', body: JSON.stringify({ type: 'forget', confirm: true, reason: 'forgotten via web workbench' }) });
        toast('ok', '已写入审计', `actor=web · lifecycle.forget · ${id}`, '查看审计');
      } else if (act === 'promote' || act === 'stale' || act === 'refresh') {
        const type = { promote: 'activate', stale: 'mark_stale', refresh: 'refresh' }[act];
        await api(`/api/memories/${id}/transition`, { method: 'POST', body: JSON.stringify({ type, reason: `${type} via web workbench` }) });
        toast('ok', '已写入审计', `actor=web · lifecycle.${type} · ${id}`, '查看审计');
      } else if (act.startsWith('fb-')) {
        const kind = act === 'fb-useful' ? 'useful' : 'not_useful';
        await api(`/api/memories/${id}/feedback`, { method: 'POST', body: JSON.stringify({ kind, note: `${kind} via web workbench` }) });
        toast('ok', '反馈已记录', `actor=web · feedback.${kind} · ${id}`, '查看审计');
      }
      renderDetail(id);
    } catch (error) { toast('danger', '操作失败', error.message); }
  });
}

/* ---------- S4 记忆编辑 ---------- */
export const SENSITIVE_RE = /(api[_-]?key|secret|token)\s*[:=]|sk-[A-Za-z0-9]{8,}/i;

export async function renderEdit(id) {
  const isNew = id === null;
  const data = isNew ? null : await api('/api/memories/' + encodeURIComponent(id));
  const m = data ? data.memory : null;
  const needsConfirm = m && (m.status === 'active' || m.status === 'stale');
  const initBody = data?.body || '';
  pageEl.classList.add('fill');
  pageEl.innerHTML = `
    <div class="banner warn" id="sensitive-banner" style="display:none">
      ${icon('alert', 16, 'var(--danger)')}
      <div style="flex:1"><b>已阻止保存：检测到疑似敏感值</b><br>
      <span class="small">内容命中内置脱敏规则（token / API Key 模式）。请移除密钥后重试；Taga 不会把敏感值写入 Markdown、SQLite、日志或审计。</span></div>
      <button class="btn small">查看规则</button>
    </div>
    <div class="split fill-area">
      <div class="main-col">
        <div class="editor">
          <div class="editor-head">${icon('pencil', 14, 'var(--text-muted)')}
            <span>${isNew ? 'mem_new.md' : esc(id) + '.md'}</span>
            <span class="faint">Markdown 事实源</span>
            <div class="spacer"></div>
            <span class="faint" id="editor-stats">0 行</span>
          </div>
          <div class="editor-area">
            <div class="editor-gutter" id="editor-gutter"></div>
            <textarea class="editor-text" id="f-body" spellcheck="false">${esc(initBody)}</textarea>
          </div>
        </div>
        <div class="card" id="diff-card" style="display:none">
          <div class="card-head"><h2>变更预览（−/+ 行 diff）</h2><div class="spacer"></div>
            <span class="mono small faint" id="diff-stats"></span></div>
          <div class="code-block" id="diff-body" style="max-height:260px;overflow-y:auto"></div>
        </div>
      </div>
      <div class="rail" style="overflow-y:auto">
        <div class="card">
          <h2>保存前校验</h2>
          ${[['frontmatter 完整', '通过', 'ok', 'circleCheck'], ['ID 保持不变', isNew ? '生成新 ID' : '通过', 'ok', 'circleCheck'],
      ['敏感值扫描', '扫描中…', 'ok', 'circleCheck'], ['长度 0 / 2000', '通过', 'ok', 'circleCheck']]
      .map(([name, status, kind, ic]) => `
            <div class="row" id="val-${name.replace(/\s/g, '')}">${icon(ic, 14, `var(--${kind})`)}
              <span class="small" style="flex:1">${name}</span>
              <span class="mono small" style="color:var(--${kind})">${status}</span></div>`).join('')}
        </div>
        <div class="card">
          <h2>元数据</h2>
          <label class="field">type
            <select id="f-type">${TYPE_OPTIONS.map((t) => `<option ${t === m?.type ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
          <label class="field">status
            <input value="${esc(m?.status || 'draft')}（改写需确认）" disabled style="opacity:.6"></label>
          <label class="field">scope
            <select id="f-scope">${['global', 'domain', 'project'].map((t) => `<option ${t === m?.scope?.kind ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
          <label class="field">scope id<input id="f-scope-id" value="${esc(m?.scope?.id || '')}" placeholder="domain / project 时必填"></label>
          <label class="field">title<input id="f-title" value="${esc(m?.title || '')}"></label>
          <label class="field">summary<textarea id="f-summary" style="min-height:64px">${esc(m?.summary || '')}</textarea></label>
          <label class="field">变更原因（写入审计）<input id="f-reason" placeholder="why this change"></label>
        </div>
        <div class="card" style="background:var(--accent-soft);border-color:var(--accent)">
          <h2>保存影响说明</h2>
          <div class="bullet-row"><span class="d">—</span>写入 Markdown 事实源并同步派生索引</div>
          <div class="bullet-row"><span class="d">—</span>审计新增 memory.update（actor=web）</div>
          <div class="bullet-row"><span class="d">—</span>保留旧版本，可从时间线回滚</div>
          ${needsConfirm ? '<div class="bullet-row"><span class="d">—</span>提交后弹出二次确认</div>' : ''}
        </div>
      </div>
    </div>
    <div class="save-bar">
      ${icon('info', 15, 'var(--info)')}
      <span class="small muted" style="flex:1">${needsConfirm
        ? '改写 active 记忆需要二次确认，保存将写入审计（actor=web）并保留可回滚的历史版本。'
        : '保存写入 Markdown 事实源并同步派生索引；draft 确认后才进入召回。'}</span>
      <a class="btn" href="${isNew ? '#/memories' : '#/memories/' + esc(id)}">取消</a>
      <button class="btn" id="f-save">保存草稿</button>
      <button class="btn primary" id="f-submit">${needsConfirm ? '提交更改…' : '提交更改'}</button>
    </div>`;

  const gutter = $('#editor-gutter');
  const textarea = $('#f-body');
  const originalBody = initBody;
  const refreshDiff = () => {
    const rows = diffLines(originalBody, textarea.value);
    const changed = rows.some(([kind]) => kind !== 'same');
    $('#diff-card').style.display = changed ? 'flex' : 'none';
    if (!changed) return;
    const adds = rows.filter(([kind]) => kind === '+').length;
    const dels = rows.filter(([kind]) => kind === '-').length;
    $('#diff-stats').textContent = `+${adds} / -${dels} 行`;
    $('#diff-body').innerHTML = rows.map(([kind, line]) => {
      const color = kind === '+' ? 'var(--ok)' : kind === '-' ? 'var(--danger)' : 'var(--text-faint)';
      return `<div style="color:${color}">${kind === 'same' ? '&nbsp;&nbsp;' : kind} ${esc(line)}</div>`;
    }).join('');
  };
  const refreshGutter = () => {
    const lines = textarea.value.split('\n');
    gutter.innerHTML = lines.map((line, i) => `<div class="${SENSITIVE_RE.test(line) ? 'warn' : ''}">${i + 1}</div>`).join('');
    $('#editor-stats').textContent = `${lines.length} 行 · ${textarea.value.length} 字`;
    const hit = SENSITIVE_RE.test(textarea.value) || SENSITIVE_RE.test($('#f-summary')?.value || '');
    $('#sensitive-banner').style.display = hit ? 'flex' : 'none';
    refreshDiff();
  };
  textarea.addEventListener('input', refreshGutter);
  refreshGutter();

  const submit = async (asDraft) => {
    const content = textarea.value;
    if (SENSITIVE_RE.test(content) || SENSITIVE_RE.test($('#f-summary').value)) {
      toast('danger', '已阻止保存', '检测到疑似敏感值，内容未持久化', '查看规则');
      return;
    }
    const scopeKind = $('#f-scope').value;
    const payload = {
      type: $('#f-type').value,
      scope: { kind: scopeKind, ...(scopeKind === 'global' ? {} : { id: $('#f-scope-id').value || 'default' }) },
      title: $('#f-title').value.trim() || '未命名记忆',
      summary: $('#f-summary').value.trim() || $('#f-title').value.trim() || '未命名记忆',
      body: content,
      reason: $('#f-reason').value.trim() || undefined,
      ...(needsConfirm && !asDraft ? { confirm: true } : {}),
    };
    if (needsConfirm && !asDraft) {
      const diffRows = diffLines(originalBody, content);
      const adds = diffRows.filter(([kind]) => kind === '+').length;
      const dels = diffRows.filter(([kind]) => kind === '-').length;
      const ok = await confirmAction({
        title: '确认改写 active 记忆？', sub: `${id} · ${payload.title}`,
        body: '改写会生成新版本并 supersede 旧记忆，写入审计并保留历史版本，可从时间线回滚。',
        impact: [`内容变更 +${adds} / -${dels} 行`, '- 内容与元数据变更生成新 draft', '+ 旧版本标记 superseded', '审计新增 memory.superseded + memory.created（actor=web）'],
        confirmLabel: '确认提交',
      });
      if (!ok) return;
    }
    try {
      const result = isNew
        ? await api('/api/memories', { method: 'POST', body: JSON.stringify(payload) })
        : await api('/api/memories/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify(payload) });
      toast('ok', '已写入审计', `actor=web · ${isNew ? 'memory.created' : 'memory.update'} · ${result.memory.id}`, '查看审计');
      location.hash = '#/memories/' + result.memory.id;
    } catch (error) { toast('danger', '保存失败', error.message); }
  };
  $('#f-save').addEventListener('click', () => submit(true));
  $('#f-submit').addEventListener('click', () => submit(false));
}

/* ---------- S5 审核队列 ---------- */
