import { $, esc, pageEl } from './js/core.js';
import { initChrome } from './js/chrome.js';
import { renderOverview } from './js/pages/overview.js';
import { renderDetail, renderEdit, renderMemories } from './js/pages/memories.js';
import { renderReview } from './js/pages/review.js';
import { renderGarden } from './js/pages/garden.js';
import { renderSearch } from './js/pages/search.js';
import { renderAudit } from './js/pages/audit.js';
import { renderProjects } from './js/pages/projects.js';
import { renderPacks } from './js/pages/packs.js';
import { renderSystem } from './js/pages/system.js';
import { renderContext } from './js/pages/context.js';
import { renderCandidates } from './js/pages/candidates.js';

/* ---------- router ---------- */
export const PAGES = {
  overview: { title: '概览', crumb: 'brain / 总览', render: renderOverview },
  memories: { title: '记忆库', crumb: 'brain / 记忆库', render: renderMemories },
  review: { title: '审核队列', crumb: 'brain / 治理 / 审核', render: renderReview },
  candidates: { title: '知识候选', crumb: 'brain / 蒸馏与反思 / 候选', render: renderCandidates },
  garden: { title: '记忆花园', crumb: 'brain / 治理 / 花园', render: renderGarden },
  search: { title: '搜索与召回调试', crumb: 'brain / 检索 / 调试', render: renderSearch },
  context: { title: 'Context Pack', crumb: 'brain / 会话 / context pack', render: renderContext },
  audit: { title: '审计与时间线', crumb: 'brain / 审计', render: renderAudit },
  projects: { title: '项目与会话', crumb: 'brain / 项目', render: renderProjects },
  packs: { title: '知识包', crumb: 'brain / 知识包', render: renderPacks },
  system: { title: '系统与设置', crumb: 'brain / 系统', render: renderSystem },
};

export async function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [pathPart] = hash.split('?');
  const segments = (pathPart || 'overview').split('/').filter(Boolean);
  pageEl.classList.remove('fill');
  try {
    if (segments[0] === 'memories' && segments[1] === 'new') {
      $('#page-title').textContent = '记忆编辑'; $('#page-crumb').textContent = 'brain / 记忆库 / 新建';
      await renderEdit(null);
    } else if (segments[0] === 'memories' && segments[1] && segments[2] === 'edit') {
      $('#page-title').textContent = '记忆编辑'; $('#page-crumb').textContent = `brain / 记忆库 / ${segments[1]} / 编辑`;
      await renderEdit(segments[1]);
    } else if (segments[0] === 'memories' && segments[1]) {
      $('#page-title').textContent = '记忆详情'; $('#page-crumb').textContent = `brain / 记忆库 / ${segments[1]}`;
      await renderDetail(segments[1]);
    } else {
      const page = PAGES[segments[0] || 'overview'] || PAGES.overview;
      $('#page-title').textContent = page.title;
      $('#page-crumb').textContent = page.crumb;
      await page.render();
    }
  } catch (error) {
    pageEl.innerHTML = `<div class="card"><div class="banner danger">加载失败：${esc(error.message)}</div>
      <div class="row"><button class="btn" onclick="location.reload()">重试</button></div></div>`;
  }
  document.querySelectorAll('#nav a').forEach((link) => {
    link.classList.toggle('active', link.dataset.page === (segments[0] || 'overview'));
  });
}

window.addEventListener('hashchange', route);
initChrome().then(route).catch((error) => {
  pageEl.innerHTML = `<div class="card"><div class="banner danger">初始化失败：${esc(error.message)}</div></div>`;
});
