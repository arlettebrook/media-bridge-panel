'use strict';
/**
 * 面板配置备份 / 还原（原「导出」模块的能力）
 *
 * 只备份**面板自己的配置**：`settings/<模块>.json`。
 * 不含：
 *   · 插件的数据（`data/plugins/<类型>/<id>/data/`）—— 那是**插件自己的东西**，
 *     源实例清单、自动更新设置都在里面；按"声明归插件、存储也归插件"的口径，由它自己导出
 *   · 源包本体（6MB 级产物，可重新下载）与 runtime/（源自己的凭证缓存，含 cookie/token，不导出）
 */
const fs = require('fs');
const { SETTINGS_DIR } = require('../../core/paths');
const settings = require('../../core/settings');
const registry = require('../../core/registry');

function exportAll() {
  const out = {
    service: 'catpaw-panel',
    exportedAt: new Date().toISOString(),
    settingsDir: SETTINGS_DIR,
    settings: {},
  };
  for (const id of settings.ids()) out.settings[id] = settings.read(id);
  return out;
}

function restore(bundle) {
  const restored = [];
  for (const [id, val] of Object.entries((bundle && bundle.settings) || {})) {
    if (!settings.has(id) || !val || typeof val !== 'object') continue;
    settings.write(id, val);
    restored.push('settings/' + id + '.json');
    /* 还原完要**像 PUT /api/modules/:id/settings 那样跑一遍变更钩子**，否则"文件改了、进程里还是旧值"。
     * 已知边界：panel.logMax 还原成 812 之后，内存里的日志缓冲上限仍是 500。 */
    const mod = registry.get(id);
    if (mod && typeof mod.onSettingsChange === 'function') {
      try {
        mod.onSettingsChange(settings.read(id), id);
      } catch {
        /* 收尾失败不影响还原本身（与 PUT 那条路一致） */
      }
    }
  }
  return {
    ok: true,
    restored,
    note: restored.length
      ? '插件的数据没有随备份走（源实例清单在插件自己的 data/ 里）—— 需要迁移时到插件的设置页重新加一遍实例'
      : '没有可还原的模块设置',
  };
}

module.exports = { exportAll, restore };
