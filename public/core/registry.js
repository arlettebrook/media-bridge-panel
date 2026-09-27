'use strict';
/**
 * 导航与页面的**声明**（只有结构，不含任何渲染实现）。
 *
 *   MODULES        一个模块 = 侧栏树的一个父节点，模块内若干页（数组顺序 = 子节点顺序）
 *   registerPages  各页的渲染函数由页面自己登记进来（见 app.js 顶部）
 *
 * 这样 shell 只管"画外壳 + 分发"，不必认识任何具体的页；反过来页也不必认识外壳。
 */
import { S } from './state.js';

/**
 * 三类插件各占侧栏一栏（ADR-0029 已定 18：**插件设置页按类型挂栏**）。
 *
 * 插件自带 UI 是它自己的 HTML（`plugin.json` 的 `webui`），不是面板的页 ——
 * 所以这里只登记"哪一栏、叫什么"，具体有几个子项**开页面时现算**（读 `S.plugins`）。
 * 详见 core/plugin-ui.js（那一个通用渲染器把 webui 嵌进面板）。
 */
const PLUGIN_UI_TYPES = [
  { id: 'plugin-meta', label: '元数据', type: 'metadata' },
  { id: 'plugin-source', label: '片源', type: 'source' },
  { id: 'plugin-home', label: '首页', type: 'home' },
];

/** 插件 UI 页的 id：`pui-<类型>-<插件id>`（hash 里不能带 `/`，所以拍平成一串） */
const PLUGIN_UI_PREFIX = 'pui-';

/** 反解插件 UI 页 id；不是这种页就回 null（认不出来时 shell 会当"没有这一页"） */
export function parsePluginUiPage(page) {
  const s = String(page || '');
  if (!s.startsWith(PLUGIN_UI_PREFIX)) return null;
  const rest = s.slice(PLUGIN_UI_PREFIX.length);
  for (const t of PLUGIN_UI_TYPES) {
    const head = t.type + '-';
    if (rest.startsWith(head) && rest.length > head.length) return { type: t.type, id: rest.slice(head.length) };
  }
  return null;
}

/** 这一栏里有哪些子项：**启用中且带 webui** 的插件，一个一行 */
function pluginUiPages(type) {
  const list = (S.plugins && S.plugins.plugins) || [];
  return list
    .filter((p) => p && p.type === type && p.enabled && p.hasWebui)
    .map((p) => [PLUGIN_UI_PREFIX + type + '-' + p.id, p.name || p.id]);
}

/**
 * 导航结构。
 *
 * ⚠️ 原先这里还有一栏「源托管」（猫源地址 + 每个运行中的源一个「配置中心」），
 * 随源插件化**整栏去掉**：源实例归源插件管（见 docs/plugin-migration-plan.md 批次 4）——
 * 它的入口就是下面「片源」那一栏里该插件自己的设置页。
 */
export const MODULES = [
  {
    id: 'agg',
    label: '聚合设置',
    pages: () => [
      ['agg-templates', '模板'],
      ['agg-search', '聚合搜索'],
      ['agg-other', '其他设置'],
    ],
  },
  /* Emby 层多实例：`实例` 是每台服务器一份（名 / 端口 / 首页插件），`账号` 按实例分。 */
  {
    id: 'emby',
    label: 'Emby',
    pages: () => [
      ['emby-instances', '实例'],
      ['emby-accounts', '账号'],
    ],
  },
  /* 插件宿主：装 / 卸 / 启停 + 每插件一个常驻子进程（见 docs/adr/0028）；
   * 「某个插件自己的设置页」按类型挂到下面那三栏里（见 docs/adr/0029 已定 18）。 */
  { id: 'plugin', label: '插件', pages: () => [['plugin-manage', '管理']] },
  /* 三类插件栏：子项现算（`pages()` 每次都重新读 S.plugins），所以插件启停之后要调
   * shell.refreshNav() 把侧栏重画一遍；**一栏里一个子项都没有时整栏不显示**
   * （见 shell.renderNavButtons —— 侧栏不留空栏目）。
   * 侧栏是树，子项永远亮着，所以不必再区分"只有一个子项时要不要亮名字"。 */
  ...PLUGIN_UI_TYPES.map((t) => ({
    id: t.id,
    label: t.label,
    pages: () => pluginUiPages(t.type),
  })),
  {
    id: 'panel',
    label: '面板设置',
    pages: () => [['panel', '概览'], ['panel-settings', '设置'], ['panel-about', '关于'], ['panel-logs', '日志']],
  },
];

export function moduleOf(page) {
  for (const m of MODULES) {
    if (m.pages().some((x) => x[0] === page)) return m;
  }
  return MODULES[0];
}

/* ------------------------------------------------------------ 页渲染器登记表 */

const RENDERERS = new Map();

/**
 * 登记页渲染函数。值可以是函数，也可以带 `nopad`（该页自己管留白）：
 *   registerPages({ 'agg-search': renderAgg, 'plugin-manage': renderPluginManage })
 */
export function registerPages(map) {
  for (const [id, spec] of Object.entries(map)) {
    RENDERERS.set(id, typeof spec === 'function' ? { render: spec } : spec);
  }
}

/**
 * 插件 UI 页的**通用**渲染器（`pui-*` 那些页共用这一个，不必每个插件登记一份）。
 * 由 app.js 在启动时登记一次，见 core/plugin-ui.js。
 */
let PLUGIN_UI_RENDERER = null;

export function setPluginUiRenderer(spec) {
  PLUGIN_UI_RENDERER = typeof spec === 'function' ? { render: spec } : spec;
}

export function rendererOf(page) {
  const hit = RENDERERS.get(page);
  if (hit) return hit;
  /* 认不出的页但如果它长得像插件 UI 页，就交给那个通用渲染器
   * （页 id 是现算的，插件停用之后它的渲染函数也没了 —— 但那一页本来也就不会显示） */
  return parsePluginUiPage(page) ? PLUGIN_UI_RENDERER : null;
}
