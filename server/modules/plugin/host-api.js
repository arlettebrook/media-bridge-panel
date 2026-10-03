'use strict';
/**
 * 插件 → 宿主 的反向调用面（`ctx.hostCall(target, action, args)`）。
 *
 * 正向通道（宿主 → 插件，`host.call`）一直都有；反向通道是给 **output 插件**这类
 * "自己不产出内容、要把面板已有的首页 / 聚合能力再吐给外部客户端"的插件用的：
 * 它的子进程想读首页行清单、想取播放地址，又不该自己再实现一遍，就通过 hostCall
 * 让宿主替它调面板主进程里的 home / agg 模块。
 *
 * 白名单制：这里列了的 `(target, action)` 才接，插件不能借 hostCall 调到任意模块
 * （宿主给插件的能力面必须是显式、可数的）。所有处理器**不抛**，统一回
 *   `{ ok:true, value }` / `{ ok:false, error:{code,message} }`
 *
 * 为什么用懒 require：本文件被 host.js 引用，而 home 层又引用 host.js
 * （home/index.js 顶部 require('../../plugin/host')）—— 顶层直连会形成 require 圈，
 * 在处理器第一次被调用时再 require 就没有环的问题（那时所有模块都加载完了）。
 */

/** 单次 hostCall 的上限：与插件 http 动作转发同档（30s） */
const HOSTCALL_TIMEOUT_MS = 30000;

function ok(value) {
  return { ok: true, value: value === undefined ? null : value };
}
function fail(code, message) {
  return { ok: false, error: { code: code || 'HOSTCALL_ERROR', message: String(message || '调用失败') } };
}

/* ------------------------------------------------------------------ home */

const homeHandlers = {
  /** 启用中的首页插件清单（output 插件让用户挑"浏览哪个首页"） */
  async plugins() {
    const host = require('./host');
    const list = host
      .states()
      .filter((x) => x.type === 'home')
      .map((x) => ({ id: x.id, type: x.type, name: x.name || x.id, enabled: !!x.enabled, running: x.status === 'running' }));
    return ok({ plugins: list });
  },

  /** 某个首页插件的行清单（直接问插件动作，不用快照——这是给外部客户端的新鲜数据） */
  async rows(args) {
    const host = require('./host');
    const pluginId = String((args && args.pluginId) || '').trim();
    if (!pluginId) return fail('BAD_INPUT', '缺少 pluginId');
    const r = await host.call('home', pluginId, 'rows', {}, { timeoutMs: HOSTCALL_TIMEOUT_MS });
    return r.ok ? ok(r.value || { rows: [] }) : fail((r.error && r.error.code) || 'PLUGIN_ERROR', (r.error && r.error.message) || '行清单取数失败');
  },

  /** 跑某一行：{ pluginId, rowId, startIndex, limit } → 首页插件的 { items:HomeItem[], total }
   *  注意 host.call 回来的是**首页插件的原始条目**；归一化（字段白名单 / type 校验 / 去重 /
   *  上限）复用 emby/home 的 normalizeItems —— output 插件看到的形状与 Emby 层完全一致。 */
  async run(args) {
    const host = require('./host');
    const homeMod = require('../emby/home');
    const a = args || {};
    const pluginId = String(a.pluginId || '').trim();
    const rowId = String(a.rowId || '').trim();
    if (!pluginId || !rowId) return fail('BAD_INPUT', '缺少 pluginId / rowId');
    const startIndex = Math.max(0, Number(a.startIndex) || 0);
    const limit = Math.max(0, Number(a.limit) || 0);
    const r = await host.call('home', pluginId, 'run', { rowId, startIndex, limit }, { timeoutMs: HOSTCALL_TIMEOUT_MS });
    if (!r.ok) return fail((r.error && r.error.code) || 'PLUGIN_ERROR', (r.error && r.error.message) || '首页取数失败');
    const v = r.value || {};
    let n;
    try {
      n = homeMod.normalizeItems(v.items);
    } catch (e) {
      return fail((e && e.code) || 'BAD_RESULT', (e && e.message) || '首页条目形状不合法');
    }
    const declared = Number(v.total);
    return ok({
      items: n.items,
      total: Number.isFinite(declared) && declared > 0 ? declared : n.items.length,
      dropped: n.dropped,
      dup: n.dup,
      cached: !!v.cached,
    });
  },
};

/* ------------------------------------------------------------------- agg */

const aggHandlers = {
  /** 源 + 站点清单（外部客户端可选：让用户限定站点时用） */
  async sites() {
    const api = require('../agg/api');
    const out = await api.loadSites();
    return ok(out);
  },

  /**
   * 模板清单（id + name 摘要）：输出插件让用户**直接挑模板**，
   * 不必先装元数据插件、按域走一遍（模板自带站点与参数）。
   */
  async templates() {
    const api = require('../agg/api');
    const list = api.templates.list().map((t) => ({ id: t.id, name: t.name }));
    return ok({ templates: list });
  },

  /**
   * 聚合搜索：参数与 HTTP `POST /api/agg/search` 同义
   * { domain 或 tpl, wd, page, year, season, episode, minScore, maxItems, keys }
   * 编排与那条路由保持同一形状（作用域 → 站点 → 并发搜+打分）。
   */
  async search(args) {
    const api = require('../agg/api');
    const { aggregateSearch, selectSites } = require('../agg/service');
    const a = args || {};
    const wd = String(a.wd || '').trim();
    if (!wd) return fail('BAD_INPUT', '缺少 wd（搜索词）');
    const dom = api.scopeOf(a);
    if (dom.error) return fail(dom.error.error.code || 'NO_DOMAIN', dom.error.error.message);
    const { sources, sites } = await api.loadSites();
    if (!sources.length) return fail('NO_SOURCE', '还没有可用的源');
    const picked = selectSites(sites, dom.selection, Array.isArray(a.keys) ? a.keys : undefined);
    if (!picked.length) return fail('NO_SITE', '没有可聚合的站源（模板里没勾站点）');
    const out = await aggregateSearch(sources, picked, {
      wd,
      page: a.page || '1',
      timeoutMs: a.timeoutMs,
      want: { name: a.name || wd, year: a.year, season: a.season, episode: a.episode },
      matchOptions: { minScore: a.minScore, maxItems: a.maxItems },
      params: dom.params,
    });
    delete out.ranked; // 内部字段，不跨进程吐
    return ok(out);
  },

  /** 取详情（含搜索；或 source+site+vodId 快路径）。参数同 HTTP /api/agg/detail */
  async detail(args) {
    const api = require('../agg/api');
    const out = await api.detail(args || {});
    return out.ok ? ok(out) : fail((out.error && out.error.code) || 'AGG_ERROR', (out.error && out.error.message) || '取详情失败');
  },

  /** 取播放地址：{ domain, ref, clientHost? } → { urls, header, parse, nonHttp } */
  async play(args) {
    const api = require('../agg/api');
    const out = await api.play(args || {});
    return out.ok ? ok(out) : fail((out.error && out.error.code) || 'AGG_ERROR', (out.error && out.error.message) || '取播放地址失败');
  },
};

/* ------------------------------------------------------------------ panel */

const panelHandlers = {
  /**
   * 校验外部访问令牌：output 插件生成 widget 时，模块 URL 里可带 `?token=`，
   * 插件拿它问宿主，**验过才把令牌注入生成的 JS**，匿名下载依旧拿不到令牌。
   */
  async ingressTokenCheck(args) {
    const auth = require('../../core/auth');
    const token = String((args && args.token) || '').trim();
    return ok({ valid: !!auth.verifyIngressToken(token) });
  },
};

const HANDLERS = { home: homeHandlers, agg: aggHandlers, panel: panelHandlers };

/**
 * 派发一次插件反向调用。超时由这里兜（比插件侧的等待短或相等都没关系——
 * 两边各自计时，谁先超时谁先回错）。
 */
async function dispatch(msg) {
  const target = String((msg && msg.target) || '');
  const action = String((msg && msg.action) || '');
  const bucket = HANDLERS[target];
  const fn = bucket && bucket[action];
  if (!fn) {
    const known = Object.keys(HANDLERS).map((t) => `${t}:${Object.keys(HANDLERS[t]).join('/')}`).join('  ');
    return fail('NO_HOSTCALL', `宿主不提供 ${target}/${action || '(空)'}；现有的：${known}`);
  }
  try {
    return await Promise.race([
      Promise.resolve(fn(msg.args || {})),
      new Promise((resolve) => setTimeout(() => resolve(fail('TIMEOUT', `hostCall ${target}/${action} 超时（${HOSTCALL_TIMEOUT_MS}ms）`)), HOSTCALL_TIMEOUT_MS)),
    ]);
  } catch (e) {
    return fail((e && e.code) || 'HOSTCALL_ERROR', (e && e.message) || String(e));
  }
}

module.exports = { dispatch, HANDLERS };
