import { $, api, esc, state } from './core.js';
import { route } from '../app.js';


/* ---------- theme ---------- */
export function applyTheme(id) {
  const theme = state.themes.find((t) => t.id === id) || state.themes.find((t) => t.id === state.defaultTheme);
  if (!theme) return;
  const root = document.documentElement;
  root.setAttribute('data-theme', theme.id);
  for (const [key, value] of Object.entries(theme.colors)) {
    root.style.setProperty('--' + key.replace(/[A-Z]/g, (ch) => '-' + ch.toLowerCase()), value);
  }
  localStorage.setItem('taga.theme', theme.id);
  const label = $('#theme-dd-label');
  if (label) label.textContent = theme.name;
  const swatch = $('#theme-dd-swatch');
  if (swatch) swatch.style.background = theme.colors.accent;
  document.querySelectorAll('[data-theme-id]').forEach((item) => {
    item.classList.toggle('on', item.dataset.themeId === theme.id);
  });
}

export async function initChrome() {
  const data = await api('/api/themes');
  state.themes = data.themes;
  state.defaultTheme = data.default;

  const dd = $('#theme-dd');
  const menu = $('#theme-dd-menu');
  menu.innerHTML = state.themes.map((t) => `
    <div class="theme-dd-item" data-theme-id="${esc(t.id)}" role="option">
      <span class="swatch" style="background:${esc(t.colors.accent)}"></span>
      <span class="name">${esc(t.name)}</span>
      <span class="mode">${t.mode === 'dark' ? '深色' : '浅色'}</span>
    </div>`).join('');
  $('#theme-dd-btn').addEventListener('click', (event) => {
    event.stopPropagation();
    dd.classList.toggle('open');
  });
  menu.addEventListener('click', (event) => {
    const item = event.target.closest('[data-theme-id]');
    if (!item) return;
    applyTheme(item.dataset.themeId);
    dd.classList.remove('open');
  });
  document.addEventListener('click', () => dd.classList.remove('open'));
  applyTheme(localStorage.getItem('taga.theme') || state.defaultTheme);

  const sidebar = $('#sidebar');
  const saved = localStorage.getItem('taga.sidebar');
  const shouldCollapse = saved !== null ? saved === 'collapsed' : window.innerWidth < 1100;
  sidebar.classList.toggle('collapsed', shouldCollapse);
  $('#sidebar-toggle').addEventListener('click', () => {
    const collapsed = sidebar.classList.toggle('collapsed');
    localStorage.setItem('taga.sidebar', collapsed ? 'collapsed' : 'expanded');
  });

  const searchInput = $('#top-search-input');
  const runTopSearch = () => {
    const q = searchInput.value.trim();
    if (!q) return;
    const next = '#/search?' + new URLSearchParams({ q }).toString();
    if (location.hash === next) route();
    else location.hash = next;
  };
  $('#top-search-btn').addEventListener('click', runTopSearch);
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') runTopSearch();
  });
}

/* ---------- ui atoms ---------- */
