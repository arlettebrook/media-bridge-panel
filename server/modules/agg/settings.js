'use strict';
/**
 * 聚合模块自己的设置（data/settings/agg.json）
 *
 *   sources   **自定义**聚合源（外部地址）：{ id, url, name, enabled }
 *             —— 站点身份是 (source, key) 这一对。**本地部署的源不在这里**：
 *                它们自动进聚合（名字取部署源自己的名字、地址每次现算），
 *                见 source/service.js 的 `deployed()` 与 agg/api.js 的 `listSources()`。
 *                所以这份清单只剩"面板够不到、得手填地址"的那一半。
 *                `name` 可以留空（显示时退回 url），填了就**必须各不相同**（见 validate）
 *
 * ⚠️ **只到这里**。原先还在这份文件里的东西都各归各家了：
 *   · 站点勾选与顺序、超时与并发、打分参数、线路过滤 → **模板**
 *     （`data/templates/<模板 id>.json`，按**元数据域**取用，见 docs/adr/0033 与 agg/templates.js）
 *   · 站点测速的开关与间隔 → **面板设置**（site-test.js 读 `panel`）
 *     （测速是"这台机器与这条网络"的体检，与内容偏好无关；测速结果也是面板级共享的一份）
 *   · `initFirst` 早已删掉：有的源不 init 就搜不出来，"要不要 init"由源的性质决定
 *     （现在恒开，见 agg/service.js 的 `ensureInit`）
 */
module.exports = {
  /**
   * ⚠️ 这一份**只剩源清单**：站点勾选、超时、并发、打分、线路过滤都搬进了**模板**
   * （`data/templates/`，见 docs/adr/0033），测速的开关与间隔搬去了**面板设置**。
   * 面板上的「源列表」页仍用它保存自定义源。
   */
  defaults: () => ({
    sources: [],
  }),

  /**
   * ⚠️ **校验只剩源清单这一块**：站点勾选、超时、并发、打分、线路过滤都搬进了模板
   * （那边由 `agg/templates.js` 的 `validate` 管），测速的开关与间隔搬去了面板设置。
   * 留着旧键的校验会**挡回"只改源清单"的保存**（缺键 → NaN → 判不合法），所以整段删掉了。
   */
  validate: (o) => {
    if (!Array.isArray(o.sources)) return 'sources 必须是数组';
    const ids = new Set();
    const names = new Set(); // 名字用来区分源，重了在界面上就分不清哪个是哪个
    for (const s of o.sources) {
      if (!s || typeof s !== 'object') return 'sources 的每一项必须是对象';
      if (!s.id || typeof s.id !== 'string') return 'sources[].id 必填（短标识，如 s1）';
      if (!s.url || typeof s.url !== 'string') return `源 ${s.id} 缺少 url`;
      if (ids.has(s.id)) return `源 id 重复：${s.id}`;
      ids.add(s.id);
      if (s.name != null && typeof s.name !== 'string') return `源 ${s.id} 的 name 必须是字符串`;
      const nm = String(s.name || '').trim();
      if (nm) {
        const key = nm.toLowerCase();
        if (names.has(key)) return `源名字重复：${nm}（名字可以留空，填了就得各不相同）`;
        names.add(key);
      }
    }
    return null;
  },
};
