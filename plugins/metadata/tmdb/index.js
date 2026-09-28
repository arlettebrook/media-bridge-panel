'use strict';
/**
 * TMDB 元数据插件 · 入口（动作层）
 *
 * 契约见 docs/plugin-contract.md 第六节。这个插件把一个**元数据域**（域 id = `tmdb`，
 * 就是条目 Id 的前缀）接了过来：自己存 token 与基地址、自己缓存、自己归一化，
 * 面板只按域向它要东西，不再认识 TMDB 的接口形状。
 *
 *   register  注册      —                         域 id + 能力申报 + 图片基地址
 *   lookup    取元数据   {entryId,type,rich?,withSeasons?}   一个条目的规范字段
 *   season    取一季分集 {entryId,season}                   某一季的分集
 *   search    搜索       {wd,type}                          按名字的候选列表
 *   get       任意路径   {path,params}                      响应体本体（首页插件取榜单用）
 *   test      连通性自检 {…界面上没保存的值}                 设置页那颗「测试」
 *   http      webui 转发 {method,path,body}                 插件自己设置页的后端
 *
 * ⚠️ 归一化归插件（见 docs/adr/0029 的已定 5）：返回的字段名是**域中立的**
 * （`entryId` / `type` / `personId`…），面板侧只把它翻成 Emby 的 DTO。
 * 入口这一层只做两件事：**把面板给的动作参数翻成插件内部的叫法**、把失败如实说清楚。
 */
const settings = require('./lib/settings');
const cache = require('./lib/cache');
const client = require('./lib/tmdb');
const meta = require('./lib/meta');
const pkg = require('./plugin.json');

/** 本插件注册的域 id（= 条目 Id 的前缀），与 `plugin.json` 的 `domain` 同一个来源 */
const DOMAIN = String(pkg.domain || 'tmdb');

/**
 * 能力申报（契约第六节的字段清单）：**它会哪些、缺哪些**。
 * 现在整份都齐（TMDB 取得到），所以这里只列"有哪些"；面板这一批还没有按申报分支的行为，
 * 缺字段时如实空 —— 申报先立着，接第二个元数据来源时才有东西可判。
 */
const CAPABILITIES = {
  series: true,
  fields: [
    'identity', // 条目 id 与类型
    'titles', // 主标题 / 原始标题 / 年份 / 首播
    'searchTitle', // 给源侧搜索用的名字（主标题没中文时回退中文别名）
    'overview',
    'images', // 海报 / 背景 / 图集 / logo
    'genres', // 类型名 + 带 id 的类型项
    'scale', // 季数
    'rating',
    'tagline',
    'status',
    'runtime',
    'certification',
    'companies', // 制作公司（带 id）
    'countries',
    'keywords',
    'externalIds', // imdb / tvdb / wikidata
    'trailers',
    'people', // 演员与幕后
    'recommendations',
    'seasons', // 取元数据时可一并带出
    'episodes', // 取一季分集
    'search',
  ],
};

/** 失败对象 → 动作层的失败回复（面板照实记日志、照实空） */
const failFrom = (e) => ({
  code: (e && e.code) || 'NETWORK',
  status: (e && e.status) || 0,
  message: (e && e.message) || String(e),
});

/* ============================================================ 动作 */

const actions = {
  /** 注册：把"这个域是什么、它有什么、图片去哪儿取"报给面板（面板据此分派前缀） */
  register() {
    const c = settings.read();
    return {
      domain: DOMAIN,
      series: true,
      name: pkg.name || DOMAIN,
      version: pkg.version || '',
      language: c.language,
      /* 图片基地址随注册报出去：**替客户端取图的是面板**（契约第六节），它拼串要用这个值 */
      imageBase: c.imageBase,
      capabilities: CAPABILITIES,
    };
  },

  /** 取元数据 —— 面板按域分派过来，一次一个条目 */
  async lookup(args = {}) {
    const out = await meta.lookup({
      type: args.type === 'movie' ? 'movie' : 'tv',
      tmdbId: args.entryId,
      rich: !!args.rich,
      withSeasons: !!args.withSeasons,
    });
    if (!out.ok) return out;
    return { ok: true, item: out.item };
  },

  /** 取一季分集 */
  async season(args = {}) {
    return meta.lookupSeason({ tmdbId: args.entryId, season: args.season });
  },

  /** 搜索：按名字给候选（面板的搜索端点与首页插件都用它） */
  async search(args = {}) {
    try {
      const rows = await meta.search(args.type === 'movie' ? 'movie' : 'tv', args.wd, args.page);
      return { ok: true, rows };
    } catch (e) {
      return { ok: false, error: failFrom(e) };
    }
  },

  /**
   * 任意路径 —— **响应体本体**，不解析、不裁剪。
   * 给首页插件取榜单/发现这类"面板不认识的 TMDB 路径"用（原来是面板 core 那份 `get`）。
   */
  async get(args = {}) {
    const p = String(args.path || '').trim();
    if (!p) return { ok: false, error: { code: 'BAD_ID', message: 'TMDB 路径不能为空' } };
    try {
      const body = await client.get(p, { params: args.params || {} });
      return { ok: true, body };
    } catch (e) {
      return { ok: false, error: failFrom(e) };
    }
  },

  /** 连通性自检（设置页那颗「测试」）：一律返回对象，成败看 `ok`，**绝不回显 token** */
  async test(args = {}) {
    return client.test(args.form || args || {});
  },

  /**
   * webui 的后端（面板把 `/api/plugins/<类型>/<id>/api/**` 原样转过来，它不解析内容）。
   * 设置与存储都在插件自己这边（契约第十一节）。
   */
  async http(args = {}) {
    const method = String(args.method || 'GET').toUpperCase();
    const p = String(args.path || '/').replace(/\/+$/, '') || '/';
    let body = {};
    if (args.body) {
      try {
        body = JSON.parse(args.body);
      } catch {
        return { status: 400, body: { error: '请求体不是 JSON' } };
      }
    }

    if (p === '/settings' && method === 'GET') return { body: view() };

    if (p === '/settings' && method === 'POST') {
      const cur = settings.raw();
      const next = Object.assign({}, cur);
      /* token 空串 = 没改（免得只想改基地址却被空密码框清掉）；要清就给 `clearToken` */
      if (body.clearToken === true) next.token = '';
      else if (typeof body.token === 'string' && body.token.trim()) next.token = body.token.trim();
      for (const k of ['apiBase', 'imageBase']) {
        if (body[k] === undefined) continue;
        const v = String(body[k] || '').trim();
        if (v && !/^https?:\/\//i.test(v)) return { status: 400, body: { error: `${k} 必须是 http(s) 地址，或留空用官方地址` } };
        next[k] = v;
      }
      if (body.language !== undefined) {
        const v = String(body.language || '').trim();
        if (!v) return { status: 400, body: { error: '语言不能为空（例如 zh-CN）' } };
        next.language = v;
      }
      for (const k of ['cacheTtlDays', 'cacheMaxMB']) {
        if (body[k] === undefined) continue;
        const n = Number(body[k]);
        if (!Number.isFinite(n) || n < 0) return { status: 400, body: { error: `${k} 必须是不小于 0 的数字` } };
        next[k] = n;
      }
      settings.write(next);
      /* 上限调小后**立刻淘汰**（不然设置页会显示"已用 60MB / 上限 10MB"，看着像坏了） */
      cache.sweep('meta', { force: true });
      cache.sweep('names', { force: true });
      return { body: Object.assign({ ok: true }, view()) };
    }

    if (p === '/test' && method === 'POST') return { body: await client.test(body.form || body || {}) };

    if (p === '/cache' && method === 'GET') return { body: cache.stats() };

    if (p === '/cache/clear' && method === 'POST') {
      const out = cache.clear(body.table ? String(body.table) : '');
      return { body: { ok: true, cache: out } };
    }

    return { status: 404, body: { error: `插件设置页没有这个路径：${method} ${p}` } };
  },
};

/** 设置页要看的那些（**token 只回"有没有配、多长"**，不回本体） */
function view() {
  const c = settings.read();
  return {
    settings: {
      apiBase: c.apiBase,
      imageBase: c.imageBase,
      language: c.language,
      cacheTtlDays: c.cacheTtlDays,
      cacheMaxMB: c.cacheMaxMB,
    },
    token: { set: !!c.token, length: c.token.length },
    official: { apiBase: settings.DEFAULT_API_BASE, imageBase: settings.DEFAULT_IMAGE_BASE },
    cache: cache.stats(),
  };
}

module.exports = { actions };
