'use strict';
/**
 * 聚合层模块
 *
 *   对外：/api/agg/*
 *   依赖：**源插件**（取数与"有哪些源、有哪些站点"都过 `source-bridge.js` 转给插件；
 *         源不再活在面板进程里，所以没有可直连的模块）
 *
 * 另外它还养着一个**后台任务**：站点测速（`./site-test.js`，每 6 小时自动一轮、手动可开）。
 * 开机与设置变更各有一个钩子给 `server.js` 与 `core/settings` 调。
 */
const routes = require('./routes');
const siteTest = require('./site-test');

module.exports = {
  id: 'agg',
  label: '聚合设置',
  apiPrefix: ['/api/agg'],
  upstream: null,

  routes,

  /** 设置保存后按新配置重排测速定时器（见 site-test.js 的 apply） */
  onSettingsChange: () => siteTest.apply(),

  /** 开机启动自动测速的计时（server.js 在面板起来后调一次；默认就是开） */
  startSiteTest: () => siteTest.boot(),
};
