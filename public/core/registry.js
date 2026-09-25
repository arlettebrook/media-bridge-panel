'use strict';
/**
 * 导航与页面的**声明**（只有结构，不含任何渲染实现）。
 *
 *   MODULES        一个 tab = 一个模块，模块内若干页（数组顺序 = 子标签顺序）
 *   registerPages  各页的渲染函数由页面自己登记进来（见 app.js 顶部）
 *
 * 这样 shell 只管"画外壳 + 分发"，不必认识任何具体的页；反过来页也不必认识外壳。
 */
/**
 * 导航结构。
 *
 * ⚠️ 原先这里还有一栏「源托管」（猫源地址 + 每个运行中的源一个「配置中心」），
 * 随源插件化**整栏去掉**：源实例归源插件管，入口在「插件 → 管理 →（那个插件）设置」里
 * （见 docs/plugin-migration-plan.md 批次 4）。
 */
export const MODULES = [
  {
    id: 'agg',
    label: '聚合设置',
    pages: () => [
      ['agg-templates', '模板'],
      ['agg-search', '聚合搜索'],
    ],
  },
  { id: 'emby', label: 'Emby', pages: () => [['emby-setup', '连接设置'], ['emby-home', '首页插件']] },
  /* 插件宿主：装 / 卸 / 启停 + 每插件一个常驻子进程（见 docs/adr/0028）。
   * 「某个插件自己的设置页」按它的**类型**挂到对应那一栏下（见 docs/adr/0029 的已定 18），
   * 等元数据 / 首页插件进来时装上（批次 6 / 9）；现在从「管理」页上的「设置」按钮进。 */
  { id: 'plugin', label: '插件', pages: () => [['plugin-manage', '管理']] },
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

export function moduleById(id) {
  return MODULES.find((m) => m.id === id) || MODULES[0];
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

export function rendererOf(page) {
  return RENDERERS.get(page) || null;
}
