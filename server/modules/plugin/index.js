'use strict';
/**
 * 插件模块：宿主（装/卸/启停/管道调用/日志/内存）+ 管理页。
 *
 * 契约见 docs/plugin-contract.md，决策见 docs/adr/0028（插件体系与执行模型）与
 * docs/adr/0029（走管道 / 动作名 / 能力申报）。
 *
 *   · 对外：`/api/plugins/*`（管理面；都在 `/api/` 下 ⇒ **天然受门禁**）
 *   · 数据：`data/plugins/`（`registry.json` + `<类型>/<插件 id>/`）
 *   · 依赖：无（`upstream: null`）—— 插件自己联网、自己读写自己的目录，不经过别的模块
 *
 * 三个钩子给 server.js 用：开机同步内置插件、开机拉起**启用中**的插件、退出时**停掉所有插件**
 * （"面板停、插件就停"由宿主保证，不依赖插件配合 —— 见 docs/adr/0028）。
 */
const routes = require('./routes');
const store = require('./store');
const host = require('./host');

module.exports = {
  id: 'plugin',
  label: '插件',
  apiPrefix: ['/api/plugins'],
  upstream: null,

  settings: {
    defaults: () => ({
      /* 装一个插件之前要不要那道确认（插件能读写数据、能联网、能起进程 —— 见 docs/adr/0028）。
       * 默认要：那是它唯一的安全阀，默认别关。 */
      confirmInstall: true,
    }),
    validate: (o) => {
      if (o.confirmInstall !== undefined && typeof o.confirmInstall !== 'boolean') return 'confirmInstall 必须是 true / false';
      return null;
    },
  },

  routes,

  /**
   * 开机：把**仓库里随包发行的内置插件**同步进数据目录（内容指纹变了才重装），
   * 然后拉起所有**启用中**的插件。
   *
   * ⚠️ 失败**不挡面板启动**：插件坏了不该连累整个面板（与内置首页示例同一口径）。
   */
  autostart: async () => {
    try {
      const notes = store.syncBuiltins();
      for (const n of notes) {
        if (n.action === 'skip') continue;
        const mark = n.action === 'failed' ? '✘' : n.action === 'updated' ? '↻' : '✔';
        console.log(
          `  ${mark} 内置插件 ${n.type}/${n.id}：` +
            (n.action === 'failed' ? '同步失败（面板继续）' + (n.reason ? '：' + n.reason : '') : n.action === 'updated' ? `已更新到 v${n.version}` : `已装入 v${n.version}`)
        );
      }
    } catch (e) {
      console.log('  ✘ 内置插件同步失败（面板继续）：' + ((e && e.message) || e));
    }
    const started = host.bootAll();
    for (const one of started) {
      if (one && one.ok === false) console.log(`  ✘ 插件没起来 ${one.type}/${one.id}：${one.error}`);
    }
    if (started.length) console.log(`  ✔ 插件：${started.length} 个启用中`);
  },

  /** 退出时停掉所有插件进程（**不依赖插件配合**） */
  stopAll: () => host.stopAll(),
};
