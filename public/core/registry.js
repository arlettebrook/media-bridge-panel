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
  {
    id: 'plugin-meta',
    label: '元数据',
    type: 'metadata',
    icon: ico(
      '<ellipse cx="8" cy="3.6" rx="5.4" ry="2"/>' +
        '<path d="M2.6 3.6v8.8c0 1.1 2.42 2 5.4 2s5.4-.9 5.4-2V3.6"/>' +
        '<path d="M2.6 8c0 1.1 2.42 2 5.4 2s5.4-.9 5.4-2"/>'
    ),
  },
  {
    id: 'plugin-source',
    label: '片源',
    type: 'source',
    icon: ico(
      '<rect x="1.6" y="2.6" width="12.8" height="10.8" rx="1.6"/>' +
        '<path d="M4.6 2.6v10.8M11.4 2.6v10.8M1.6 8h12.8"/>'
    ),
  },
  {
    id: 'plugin-home',
    label: '首页',
    type: 'home',
    icon: ico('<path d="M2 7.1 8 2.3l6 4.8"/><path d="M3.7 6.2v7.5h8.6V6.2"/>'),
  },
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
 * 侧栏那一行的图标（内联 SVG）。
 *
 * 只写图形本身，外面那圈属性（`viewBox` / 线宽 / 圆角端点 / 颜色跟随文字）在这里统一给 ——
 * 每个图标各写一遍必然粗细不齐。`fill="none"` + `stroke="currentColor"` 让图标跟着
 * 当前行的文字色走（悬停 / 高亮时一起变色），不必再为状态各配一份颜色。
 */
function ico(body) {
  return (
    '<svg class="nav-ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
    'stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    body +
    '</svg>'
  );
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
    icon: ico(
      '<rect x="2.2" y="2.2" width="4.8" height="4.8" rx="1.2"/>' +
        '<rect x="9" y="2.2" width="4.8" height="4.8" rx="1.2"/>' +
        '<rect x="2.2" y="9" width="4.8" height="4.8" rx="1.2"/>' +
        '<rect x="9" y="9" width="4.8" height="4.8" rx="1.2"/>'
    ),
    pages: () => [
      ['agg-templates', '模板'],
      ['agg-search', '聚合搜索'],
      ['agg-other', '域 → 模板'],
    ],
  },
  /* Emby 层多实例：`实例` 是每台服务器一份（名 / 端口 / 首页插件），`账号` 按实例分。 */
  {
    id: 'emby',
    label: 'Emby',
    icon: ico(
      '<rect x="1.6" y="2.6" width="12.8" height="8.8" rx="1.4"/>' + '<path d="M6 13.6h4"/>'
    ),
    pages: () => [
      ['emby-instances', '实例'],
      ['emby-accounts', '账号'],
    ],
  },
  /* 插件宿主：装 / 卸 / 启停 + 每插件一个常驻子进程（见 docs/adr/0028）；
   * 「某个插件自己的设置页」按类型挂到下面那三栏里（见 docs/adr/0029 已定 18）。
   * 「插件库」= 从独立插件仓库装（插件不随面板发行，见 docs/adr/0035）；
   * 「管理」= 已装的装卸启停 + 手动上传包。 */
  {
    id: 'plugin',
    label: '插件',
    icon: ico('<rect x="2.2" y="2.2" width="11.6" height="11.6" rx="3.2"/><circle cx="8" cy="8" r="2.4"/>'),
    pages: () => [
      ['plugin-library', '插件库'],
      ['plugin-manage', '管理'],
    ],
  },
  /* 三类插件栏：子项现算（`pages()` 每次都重新读 S.plugins），所以插件启停之后要调
   * shell.refreshNav() 把侧栏重画一遍；**一栏里一个子项都没有时整栏不显示**
   * （见 shell.renderNavButtons —— 侧栏不留空栏目）。
   * 侧栏是树，子项永远亮着，所以不必再区分"只有一个子项时要不要亮名字"。 */
  ...PLUGIN_UI_TYPES.map((t) => ({
    id: t.id,
    label: t.label,
    icon: t.icon,
    pages: () => pluginUiPages(t.type),
  })),
  {
    id: 'panel',
    label: '面板设置',
    icon: ico(
      '<path d="M2 4.6h7.3M13.4 4.6H14M2 11.4h1.6M7.7 11.4H14"/>' +
        '<circle cx="11.3" cy="4.6" r="1.7"/><circle cx="5.4" cy="11.4" r="1.7"/>'
    ),
    pages: () => [
      ['panel', '概览'],
      ['panel-settings', '设置'],
      ['panel-backup', '备份与还原'],
      ['panel-security', '安全'],
      ['panel-about', '关于'],
      ['panel-logs', '日志'],
    ],
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
