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
  aggLoadedFor: null,   // 上面两个的缓存指纹（源集合变了才重拉）
  siteFilter: '',
  siteSort: '',         // 站点表的显示顺序：'' = 原顺序 / 'fast' = 延迟快→慢 / 'slow' = 慢→快
  page: 'agg-templates', // 当前页；启动时若地址栏有 #/模块/页 会被它覆盖（见 shell.applyHash）

  lastPage: {},
  aggKeyword: '',
  aggPage: '1',
  aggUseAll: false,
  aggResult: null,
  aggView: 'merged',
  aggBusy: false,
  apiError: null,
  busy: false,
  emby: { settings: null, accounts: null, homePlugins: null, homeRun: {} },
  panel: { settings: null },
};
