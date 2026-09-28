'use strict';
/**
 * 全局状态：一个对象装下所有页面共享的东西。
 *
 * 项目规模还小，就没上"状态库"：各页面直接读写 `S.xxx`，改完调 `renderPage()` 重渲染。
 * 拆模块之后这里仍是**唯一**的共享状态出口 —— 页面之间不许用全局变量偷偷传值。
 */
export const S = {
  /* 源清单与站点清单都来自**源插件的申报**（面板只转一下，见 core/store.js 的 ensureAggSites）：
   * 探好的那几项（ok/ms/siteCount/error）也在这一份里，所以界面上不会再出现"探测中…"。 */
  aggSources: null,
  aggSites: [],         // 各实例的站点（每项带 source/sourceName）
  aggLoadedFor: null,   // 上面两个的缓存指纹（源集合变了才重拉）；`null` = 还没拉过（空源清单的指纹是空串，别拿它当"没拉过"）
  siteFilter: '',
  siteSort: '',         // 站点表的显示顺序：'' = 原顺序 / 'fast' = 延迟快→慢 / 'slow' = 慢→快
  siteGroup: '',        // 站点表当前打开的那个来源（模板页把来源做成页签，一次只画一组）
  page: 'agg-templates', // 当前页；启动时若地址栏有 #/模块/页 会被它覆盖（见 shell.applyHash）

  aggKeyword: '',
  /* 「聚合搜索」页这次用哪套模板（按模板选，不按域选）：模板 id。站点与参数都从那套模板来。 */
  aggTpl: '',
  aggUseAll: false,
  aggKind: 'tv',        // 「聚合搜索」页这次要的是哪种：'tv' = 剧集（季、集必填）/ 'movie' = 电影（不问季集）
  aggResult: null,
  aggView: 'merged',
  aggBusy: false,
  apiError: null,
  busy: false,
  /* 插件清单（`/api/plugins` 那一份，形如 `{ plugins: [...], builtins: [...] }`）。
   * 开机在 core/boot.js 里拉一次；侧栏「元数据 / 片源 / 首页」三栏下的子项靠它现算，
   * 所以「插件 → 管理」那一页拉完也会顺手刷新侧栏（见 shell.refreshNav）。 */
  plugins: null,
  /* Emby 侧：实例清单（多实例，见 server/modules/emby/instance.js）、可选首页插件（实例编辑的下拉）、
   * 以及**当前选中实例**的账号表 —— 账号是按实例分的，所以 `accounts` 必须带上是哪个实例的那一份。 */
  emby: { instances: null, homePlugins: null, metaDomains: null, accounts: null, accountsFor: '', iid: '' },
  panel: { settings: null },
};
