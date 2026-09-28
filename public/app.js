'use strict';
/* 媒体桥面板（前端入口）
 *
 * 核心模型：
 *   1) 源（猫源实例）归**源插件**管：面板只按动作名向它要"站点清单 / 候选 / 取播放项 / 解析地址"，
 *      自己不认识源地址，也不认识 `/config`、`/search` 这些路径（见 docs/plugin-migration-plan.md 批次 4）
 *   2) 一个**模板** = 一份配置（选中的站点 + 打分过滤参数 + 超时与并发），按**元数据域**取用
 *   3) 一个请求就能并发搜索模板里那些站点，把结果按打分排序后汇总（不去重）
 *
 * 结构（详细见 README「目录」）：
 *   core/      通用件与外壳
 *     dom       选择器 · 建节点 · 提示 · 代码块
 *     api       请求封装（非 2xx 抛错）
 *     state     全局状态 S（页面间唯一共享出口）
 *     store     面板级共享数据：模板 / 站点清单 / 聚合接续
 *     registry  导航结构与页渲染器登记表（三类插件各占一栏，子项现算）
 *     plugin-ui 插件自带 UI 的那一页（一个 iframe 嵌它的 webui，三栏下的子项共用）
 *     shell     顶栏 · 子标签 · 页面分发 · 地址栏同步（#/模块/页，刷新不掉页）
 *     boot      启动 · 全局数据加载 · 轮询
 *     docs      结构化接口文档渲染器
 *   modules/<id>/  各模块的页（agg / emby / plugin / panel）
 *
 * 分层规则：`modules/<id>/` 只许 import `core/*`，**模块之间不许互相 import**
 * —— 谁要动别人的数据就调 core/store。
 *
 * 本文件只剩引导：把各页登记进注册表，然后启动。
 */
import { registerPages, setPluginUiRenderer } from './core/registry.js';
import { paintBrand } from './core/branding.js';
import { renderPluginUi } from './core/plugin-ui.js';
import { init } from './core/boot.js';

import { renderTemplates } from './modules/agg/templates.js';
import { renderAgg } from './modules/agg/search.js';
import { renderAggOther } from './modules/agg/other.js';
import { renderEmbyInstances } from './modules/emby/instances.js';
import { renderEmbyAccounts } from './modules/emby/accounts.js';
import { renderPluginManage } from './modules/plugin/manage.js';
import { renderPluginLibrary } from './modules/plugin/library.js';
import { renderPanelOverview } from './modules/panel/overview.js';
import { renderPanelSettings, renderPanelAbout } from './modules/panel/settings.js';
import { renderPanelLogs } from './modules/panel/logs.js';

/* 页渲染函数登记（必须在 init() 之前跑完） */
registerPages({
  'agg-templates': renderTemplates,
  'agg-search': renderAgg,
  'agg-other': renderAggOther,
  'emby-instances': renderEmbyInstances,
  'emby-accounts': renderEmbyAccounts,
  'plugin-library': renderPluginLibrary,
  'plugin-manage': renderPluginManage,
  panel: renderPanelOverview,
  'panel-settings': renderPanelSettings,
  'panel-about': renderPanelAbout,
  'panel-logs': renderPanelLogs,
});

/* 插件自带 UI 的页（侧栏「元数据 / 片源 / 首页」三栏下的子项）**不逐个登记**：
 * 它们的页 id 是开页面时现算的，统一交给这一个渲染器（见 core/registry.js 的 rendererOf）。 */
setPluginUiRenderer({ render: renderPluginUi, nopad: true });

/* 侧栏品牌与网页标题（读 core/branding.js —— 改名只改那一处；index.html 里那份只是首屏兜底） */
paintBrand();

init();
