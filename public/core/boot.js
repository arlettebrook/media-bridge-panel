'use strict';
/**
 * 启动与连通性检查：确认后端在 → 画壳 → 交给各页自己取数。
 *
 * ⚠️ 原先这里每 5 秒轮询一次"运行中的源 / 本地托管源"给「源托管」「配置中心」两页用 ——
 * 那两页随源插件化没了，**全局轮询也一起去掉**（要实时刷新的页自己轮询：
 * 站点测速那页在 `modules/agg/templates.js`、插件管理页在 `modules/plugin/manage.js`）。
 */
import { $, el } from './dom.js';
import { api } from './api.js';
import { ensureAuth } from './auth.js';
import { S } from './state.js';
import { applyHash, applyNavState, closeNavIfNarrow, collapseNav, onHashChange, renderPage, switchModule, switchPage, toggleNav } from './shell.js';

export async function init() {
  applyNavState(); // 先定侧栏形态，别等数据回来才闪一下
  /* 面板门禁：没登录就把登录框铺上，后面一步都不做（拉了也是 401） */
  if (!(await ensureAuth())) return;
  applyHash(); // 地址栏里有页就按它来（刷新后停在同一页），下面的 renderPage 会用上
  window.addEventListener('hashchange', onHashChange); // 前进/后退切页
  $('#navToggle').addEventListener('click', toggleNav);
  $('#navScrim').addEventListener('click', collapseNav);
  $('#nav').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-module]');
    if (!b) return;
    switchModule(b.dataset.module);
    closeNavIfNarrow(); // 窄屏是抽屉，选完就该收起来
  });
  $('#subnav').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-page]');
    if (b) switchPage(b.dataset.page);
  });
  await loadAll();
}

/**
 * 启动时拉一次全局数据。
 *
 * 只有一件事要做：**确认后端活着**。各页的数据由页自己取（谁需要谁拉，见 core/store.js 的懒加载），
 * 所以这里打的是最轻的那条 `/api/meta`（不碰插件、不碰上游）。
 */
export async function loadAll() {
  try {
    await api('/api/meta');
    S.apiError = null;
  } catch (e) {
    S.apiError = e.message;
  }
  if (S.apiError) {
    renderError();
    return;
  }
  $('#empty').classList.add('hidden');
  $('#workspace').classList.remove('hidden');
  renderPage();
}

function renderError() {
  const box = $('#empty');
  box.classList.remove('hidden');
  box.textContent = '';
  $('#workspace').classList.add('hidden');
  box.append(
    el(
      'div',
      { class: 'empty-inner' },
      el('div', { class: 'empty-icon', text: '⚠️' }),
      el('h2', { text: '连接不到后端服务' }),
      el('p', {
        class: 'muted',
        html: `当前页面地址：<code>${location.origin}</code><br>接口错误：<code>${String(S.apiError).replace(/[<>&]/g, '')}</code><br><br>请先启动后端：<code>npm start</code>，再用它启动后打印的地址打开面板。`,
      }),
      el('button', { class: 'btn primary', text: '重试连接', onclick: () => loadAll() })
    )
  );
}
