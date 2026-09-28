'use strict';
/**
 * 面板级共享数据层：**唯一**需要拼后端路径的地方（各页模块只用它，不自己拼 URL）。
 *
 * 放在 `core/` 而不是某个模块里，是因为这些数据是跨模块的 ——
 * 「模板」页与「聚合搜索」页都要看源与站点。
 * 分层规则：`modules/<id>/` 只许 import `core/*`，模块之间不许互相 import；
 * 谁要动别人的数据，就调这里，而不是去 import 那个模块。
 *
 * ⚠️ 源与站点现在都**来自源插件的申报**（面板侧只是转一下，见 `agg/source-bridge.js`）：
 * 所以这里没有"添加源 / 保存源清单"这类写操作 —— 那些是插件自己设置页的事。
 */
import { api } from './api.js';
import { S } from './state.js';

/** `(源, 站点)` 的复合键 —— 多实例下站点 key 只在各自实例内唯一，比较必须带上源 */
export const sid = (source, key) => `${source}\u0001${key}`;

/** 源集合的指纹：只有"源清单变了"才需要重拉站点。
 *  ⚠️ `url` 必须进指纹 —— 本地部署的实例**端口是启动时定的**，重启后换了端口就是另一条地址了，
 *  指纹不变的话会拿着旧站点清单当新的。 */
export function aggSourcesKey(sources) {
  return (sources || []).map((s) => `${s.id}:${s.url}:${s.enabled === false ? 0 : 1}`).join('|');
}

/** 正在飞的那次拉取。几次渲染可能同时触发它 —— 别重复拉 */
let aggInflight = null;

/**
 * 源清单 + 站点清单懒加载：`GET /api/agg/sites` 一次拿全。
 * 面板转给源插件的「站点清单」动作，插件那边有缓存（一分钟），所以通常是一次管道往返。
 */
export async function ensureAggSites({ force = false } = {}) {
  const key = aggSourcesKey(S.aggSources);
  /* 空源清单的指纹是空串 —— 不能拿它当"还没拉过"（`null` 才是未拉过的标记，见 state.js） */
  if (!force && S.aggLoadedFor !== null && S.aggLoadedFor === key && S.aggSites.length) return;
  if (aggInflight) return aggInflight;
  aggInflight = (async () => {
    const d = await api('/api/agg/sites');
    S.aggSources = d.sources || [];
    S.aggSites = d.sites || [];
    /* 模板 / 域对照 / 已注册的域：站点表要按"当前这套模板"画勾选，
     * 并且要能看出"每个站点还被哪几套模板用了"（见 docs/adr/0033）。 */
    S.aggTemplates = d.templates || [];
    S.aggDomains = d.domains || {};
    S.aggProviders = d.providers || [];
    S.aggLoadedFor = aggSourcesKey(S.aggSources);
  })();
  try {
    await aggInflight;
  } finally {
    aggInflight = null;
  }
}

/** 飞行中的模板拉取（搜索页与模板页可能同时要） */
let tplInflight = null;

/**
 * 模板 / 域对照 / 已注册的域（`GET /api/agg/templates`）—— 不碰插件、不碰上游，几十毫秒就回来。
 * 与 `ensureAggSites()` 分开：搜索页只要模板（决定默认参数与域）。
 */
export async function ensureTemplates({ force = false } = {}) {
  if (!force && S.aggTemplates) return;
  if (tplInflight) return tplInflight;
  tplInflight = (async () => {
    const d = await api('/api/agg/templates');
    S.aggTemplates = d.templates || [];
    S.aggDomains = d.domains || {};
    S.aggProviders = d.providers || [];
  })();
  try {
    await tplInflight;
  } finally {
    tplInflight = null;
  }
}

/** 某个域用的模板 —— **没配就返回 null**（调用方如实为空，见 docs/adr/0033） */
export function templateOf(domain) {
  const id = (S.aggDomains || {})[String(domain || '')];
  return id ? (S.aggTemplates || []).find((t) => t.id === id) || null : null;
}
