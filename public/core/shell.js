'use strict';
/**
 * 导航外壳：侧边栏（树 + 折叠）+ 当前页高亮 + 页面分发 + 地址栏同步。
 * 只认 `registry` 里的结构，不认任何具体的页。
 */
import { $, el } from './dom.js';
import { S } from './state.js';
import { MODULES, moduleOf, rendererOf } from './registry.js';

/* ------------------------------------------------------------ 侧栏形态 */

const NAV_NARROW = 860; // 与 style.css 里的断点一致

/* 宽屏侧栏**常驻**（占一个栏位，不缩宽度、不记偏好）—— 只有窄屏才是盖在内容上的抽屉，
 * 所以"收着"这个状态只在窄屏有意义（见 style.css 的 `@media (max-width: 860px)`）。 */
function setNavOpen(open) {
  const app = $('.app');
  if (!app) return;
  app.classList.toggle('nav-collapsed', !open);
  const btn = $('#navToggle');
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

/** 进页面时定侧栏形态：宽屏常驻展开；窄屏一律先收起（抽屉一进来就挡着内容不合理） */
export function applyNavState() {
  setNavOpen(window.innerWidth > NAV_NARROW);
}

/** 顶栏 ☰（只在窄屏出现）：开 / 关抽屉 */
export function toggleNav() {
  const app = $('.app');
  if (!app) return;
  setNavOpen(app.classList.contains('nav-collapsed'));
}

/** 收起侧栏（窄屏点遮罩用） */
export function collapseNav() {
  setNavOpen(false);
}

/** 窄屏下点完模块就把抽屉收起来；宽屏不动它 */
export function closeNavIfNarrow() {
  if (window.innerWidth > NAV_NARROW) return;
  const app = $('.app');
  if (app && !app.classList.contains('nav-collapsed')) setNavOpen(false);
}

export function switchPage(page) {
  S.page = page;
  renderPage();
}

/* ------------------------------------------------------------ 侧栏树的折叠 */

/** 收起来的父节点（模块 id）。只在内存里 —— 刷新回到默认（**全折叠**，见下面的初始化）。 */
const foldedGroups = new Set(MODULES.map((m) => m.id));

/** 收 / 开一个父节点：换箭头，并记住状态（重建侧栏时照它恢复） */
function setGroupFolded(group, folded) {
  group.classList.toggle('collapsed', folded);
  const caret = group.querySelector('.nav-caret');
  if (caret) caret.textContent = folded ? '▸' : '▾';
  if (folded) foldedGroups.add(group.dataset.module);
  else foldedGroups.delete(group.dataset.module);
}

/** 父节点是**文件夹**：点一下收起 / 展开这一栏的子项，不跳页（跳页由子节点负责） */
export function toggleNavGroup(head) {
  const group = head.closest('.nav-group');
  if (group) setGroupFolded(group, !group.classList.contains('collapsed'));
}

/** 切到某一页时把它那一栏打开 —— 高亮落在收起来的栏里等于看不见 */
function revealGroupOf(page) {
  const child = document.querySelector('#nav .nav-child[data-page="' + page + '"]');
  const group = child && child.closest('.nav-group');
  if (group) setGroupFolded(group, false);
}

/* ------------------------------------------------------------ 地址栏同步 */

/* 当前页写进地址栏（#/模块id/页id，如 #/agg/agg-search）：刷新、收藏、前进后退都回到同一页。
 * 写 hash 只发生在 renderPage 末尾这一个出口 —— 页面被顶掉（比如源停了、没有「配置中心」了）
 * 时地址栏也跟着纠正，不会留个指向不存在页面的 hash。 */

/* 页 id 允许字母数字下划线连字符 —— 「配置中心」是按源动态生成的，id 形如 `website-src_mu8n285wr714` */
const PAGE_HASH = /^#\/[a-z-]+\/([A-Za-z0-9_-]+)$/;

function pageInHash() {
  const m = PAGE_HASH.exec(location.hash || '');
  return m ? m[1] : '';
}

/** 进页面时按地址栏定位（在渲染之前调；页面当前不可用时 renderPage 会自己退回本类第一页） */
export function applyHash() {
  const page = pageInHash();
  if (!page) return;
  S.page = page;
}

/** 写回地址栏：还没有 hash（首次进入）用 replace，之后按正常导航压栈，浏览器能后退 */
function syncHash() {
  const want = '#/' + moduleOf(S.page).id + '/' + S.page;
  if (location.hash === want) return;
  if (location.hash) location.hash = want;
  else history.replaceState(null, '', want);
}

/** 浏览器前进/后退：切回地址栏里的页；和当前页相同就什么都不做（自己写 hash 也会触发本事件） */
export function onHashChange() {
  const page = pageInHash();
  if (!page || page === S.page) return;
  switchPage(page);
}

/**
 * 当前页高亮。
 *
 * ⚠️ 原先这里还给两个角标写数字（顶栏那个源站点数 / 聚合勾选数）—— 都随源插件化去掉了：
 * 「源托管」那一栏没了，而"勾了几个站点"现在按**模板**算（不同域各一套），顶栏写一个数必然误导。
 * 高亮只落在**子节点**上：父节点（栏名）是分组标题，本身不表示"当前在哪一页"。
 */
export function renderNav() {
  document.querySelectorAll('#nav .nav-child').forEach((b) => b.classList.toggle('menu-active', b.dataset.page === S.page));
}

/**
 * 侧栏：照 MODULES 现画成**树** —— 一栏一个父节点，栏里的页（以及三类插件栏下的各插件 UI）
 * 是它的子节点。原先子项画在内容区顶上那条子标签栏里，与侧栏的栏目分两处说同一件事；
 * 树把"这一栏下面有哪些页"收在一处（见 docs/adr/0029 已定 18）。
 *
 * 父节点是**文件夹**：点一下收起 / 展开这一栏（`foldedGroups` 记着收起来的那几个），
 * 不是"跳到这一栏的某一页" —— 一栏里哪一页当前亮着由子节点上的高亮说话。
 * 每行 = 图标 + 文字 + 右侧折叠箭头（箭头靠 `margin-left:auto` 顶到行尾）。
 *
 * 结构是 **daisyUI 的 menu**（`ul.menu > li > button`，嵌套的 `ul` 给子项缩进与那条竖导引线），
 * 所以往 `#navGroups` 里画的是 `li` —— 它本身就是 `index.html` 里那个 `ul`。
 *
 * ⚠️ 往 `#navGroups` 里画，**不是整条 `#nav`** —— 侧栏顶上那行品牌（`.nav-brand`）是
 * `index.html` 里的静态节点，往 `#nav` 里 `textContent=''` 会把它一起清掉。
 *
 * ⚠️ 原先这几颗按钮**写死在 index.html 里**，加一栏要改两处；现在只有 MODULES 一处。
 * 没有子项的栏目**不画** —— 三类插件栏里一个插件都没启用时，侧栏不留空栏目。
 * （`.workspace` 本来就要等接口回来才显示，所以这里晚一点画不会闪。）
 */
export function renderNavButtons() {
  const host = $('#navGroups');
  if (!host) return;
  host.textContent = '';
  for (const m of MODULES) {
    const pages = m.pages();
    if (!pages.length) continue;
    const kids = el('ul', { class: 'nav-kids' });
    for (const [id, label] of pages) {
      kids.append(el('li', {}, el('button', { class: 'nav-child', 'data-page': id, text: label })));
    }
    const group = el(
      'li',
      { class: 'nav-group', 'data-module': m.id },
      el(
        'button',
        { class: 'nav-head', title: `${m.label}：收起 / 展开`, 'data-module': m.id },
        el('span', { class: 'nav-ico-wrap', html: m.icon || '' }),
        el('span', { class: 'nav-label', text: m.label }),
        el('span', { class: 'nav-caret', text: '▾' })
      ),
      kids
    );
    setGroupFolded(group, foldedGroups.has(m.id));
    host.append(group);
  }
}

/** 插件启停 / 装卸之后调：侧栏可能多一栏少一栏，当前页也可能已经不存在了 */
export function refreshNav() {
  renderNavButtons();
  const pages = moduleOf(S.page).pages();
  if (!pages.some((x) => x[0] === S.page)) {
    switchPage(pages.length ? pages[0][0] : MODULES[0].pages()[0][0]);
    return;
  }
  renderNav();
}

/** 分发到当前页的渲染函数 */
export function renderPage() {
  // 当前页可能因为源已停止而不在导航里，退回该大类第一页
  const pages = moduleOf(S.page).pages();
  if (!pages.some((x) => x[0] === S.page)) S.page = pages[0][0];

  /* 页渲染函数大多是 async（要先 await 数据），而这里并不 await 它们 ——
   * 连着两下导航（比如点模块 tab 又立刻点子标签）就会有两份渲染同时在往同一个
   * #view 里 append，页面叠成两份。所以每次渲染**换一个新节点**：没跑完的那次攥着的
   * 是已脱离文档的旧节点，它后面 append 什么都看不见。渲染函数因此不必自己判断有没有过期。 */
  const old = $('#view');
  const v = old.cloneNode(false);
  old.replaceWith(v);
  const spec = rendererOf(S.page);
  v.className = 'view' + (spec && spec.nopad ? ' nopad' : '');
  if (spec) spec.render(v);
  renderNav();
  /* 栏目默认是**收起来**的（见上面的 `foldedGroups` 初始化）—— 当前页所在那一栏得自动展开，
   * 否则高亮落在一个看不见的子节点上。放在这里而不是 `switchPage`：首次进页面是 boot 直接
   * 调的 `renderPage`，不走 `switchPage`，只挂在那儿首次进来就不展开。 */
  revealGroupOf(S.page);
  syncHash();
}
