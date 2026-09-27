'use strict';
/**
 * MissAV 元数据插件 · 入口（动作层）
 *
 * 契约见 docs/plugin-contract.md 第六节。这个插件注册域 id = `missav`（条目 Id 的前缀）：
 * 自己存站点 / 封面基地址、自己缓存、自己归一化，面板只按域向它要东西。
 *
 *   register  注册      —                          域 id + 能力申报 + 图片基地址
 *   lookup    取元数据   {entryId,type}             一个条目的规范字段
 *   season    取一季分集 {entryId,season}           电影式 → 如实回空
 *   search    搜索       {wd}                       按名字的候选列表
 *   get       任意路径   {path,params}              响应体本体
 *   test      连通性自检 {…界面上没保存的值}         设置页那颗「测试」
 *   http      webui 转发 {method,path,body}         插件自己设置页的后端
 *
 * ⚠️ 本站给的海报就是**整串 URL**（`<封面基地址>/<slug>/cover-t.jpg`），没有"基地址 + 相对路径"
 * 这一层可拼，所以 `register` 的 `imageBase` **如实回空串**；面板侧 `imageUrlOf` 见到绝对
 * http(s) 地址会原样透传（见 `server/modules/emby/tmdb.js`）。
 *
 * 这里只做两件事：**把面板给的动作参数翻成插件内部的叫法**、把失败如实说清楚。
 */
const settings = require('./lib/settings');
const cache = require('./lib/cache');
const client = require('./lib/fetch');
const parse = require('./lib/parse');
const pkg = require('./plugin.json');

/** 本插件注册的域 id（= 条目 Id 的前缀），与 `plugin.json` 的 `domain` 同一个来源 */
const DOMAIN = String(pkg.domain || 'missav');

/**
 * 能力申报（契约第六节的字段清单）：**它会哪些、缺哪些**。
 * 本站影片页只给标题 / 封面 / 简介，以及按名字搜索；类型与演职拿不到，如实不申报。
 */
const CAPABILITIES = {
  series: false,
  fields: ['identity', 'titles', 'searchTitle', 'overview', 'images', 'search'],
};

/** 自检用的探测词：一个真实存在的番号，能同时验"搜索页通"与"列表解析对" */
const PROBE_WD = 'SSIS-001';

/** 失败对象 → 动作层的失败回复（面板照实记日志、照实空） */
const failFrom = (e) => ({
  code: (e && e.code) || 'NETWORK',
  status: (e && e.status) || 0,
  message: (e && e.message) || String(e),
});

/** 每个动作进来先把宿主给的 `ctx.dataDir` 交给设置层（缓存与设置都相对它） */
const bind = (ctx) => settings.setDataDir(ctx && ctx.dataDir);

/* ---------------------------------------------------------------- 取数 */

/** 影片页地址：`<站点>/<语言段>/<slug>` */
const pageUrl = (c, slug) => `${settings.stripSlash(c.siteBase)}/${encodeURIComponent(c.language)}/${slug}`;

/** 列表页地址：`<站点>/<语言段>/search/<urlencode(wd)>?page=1` */
const searchUrl = (c, wd) => `${settings.stripSlash(c.siteBase)}/${encodeURIComponent(c.language)}/search/${encodeURIComponent(wd)}?page=1`;

/**
 * 取一个条目的元数据（带落盘缓存）。
 * `entryId` 就是本站条目编号（slug），直接拼页面地址，不依赖任何预先登记过的编号表。
 * 失败一律 `{ ok:false, error }`，不编占位数据。
 */
async function doLookup(entryId) {
  const slug = parse.canonicalSlug(entryId);
  if (!slug) return { ok: false, error: { code: 'BAD_ID', message: '条目编号不能为空：' + entryId } };

  const c = settings.read();
  const key = `${c.language}|movie|${slug}`;
  const hit = cache.get('meta', key);
  if (hit) {
    try {
      const item = JSON.parse(hit);
      if (item && item.entryId) return { ok: true, item };
    } catch {
      /* 坏条目当没缓存，走网络 */
    }
  }

  let r;
  try {
    r = await client.htmlOf(pageUrl(c, slug), { siteBase: c.siteBase });
  } catch (e) {
    return { ok: false, error: failFrom(e) };
  }
  const item = parse.parseDetail(r.text, slug, c.imageBase);
  cache.put('meta', key, JSON.stringify(item), cache.limits('meta').ttlMs);
  return { ok: true, item };
}

/**
 * 按名字搜索 —— 走站点搜索页，归一成候选列表（每项带 `entryId` = slug）。
 * 查询词命中**番号形状**（`/^[A-Za-z]+-?\d+$/i`）时按番号精确过滤：
 * 两边去掉 `-` 后大写比较（照 `missav.js`），避免同名片混进来。
 */
async function doSearch(wd) {
  const q = String(wd || '').trim();
  if (!q) return { ok: true, rows: [] };

  const c = settings.read();
  const key = `${c.language}|${q}`;
  const hit = cache.get('names', key);
  if (hit) {
    try {
      const rows = JSON.parse(hit);
      if (Array.isArray(rows) && rows.length) return { ok: true, rows };
    } catch {
      /* 坏条目当没缓存 */
    }
  }

  let r;
  try {
    r = await client.htmlOf(searchUrl(c, q), { siteBase: c.siteBase });
  } catch (e) {
    return { ok: false, error: failFrom(e) };
  }

  let rows = parse.parseList(r.text, c.imageBase);
  if (/^[A-Za-z]+-?\d+$/i.test(q)) {
    const want = q.toUpperCase().replace(/-/g, '');
    rows = rows.filter((row) => {
      const fromSlug = parse.videoCode(row.entryId).replace(/-/g, '');
      const m = String(row.title || '').match(/^([A-Za-z]+-?\d+)/);
      const fromTitle = m ? m[1].toUpperCase().replace(/-/g, '') : '';
      return fromSlug === want || fromTitle === want;
    });
  }
  /* 只存有结果的响应：负结果存了会让新上线的条目一直看不见 */
  if (rows.length) cache.put('names', key, JSON.stringify(rows), cache.NAME_TTL_MS);
  return { ok: true, rows };
}

/**
 * 连通性自检（设置页那颗「测试」）：发一发搜索，量一次耗时。
 * 永远返回对象（不抛），成败看 `ok`；`form` 里是界面上还没保存的当前值。
 */
async function doTest(form) {
  const t0 = Date.now();
  const cfg = settings.effective(form || {}, settings.raw());
  const out = {
    ok: false,
    siteBase: cfg.siteBase,
    imageBase: cfg.imageBase,
    language: cfg.language,
    probe: { wd: PROBE_WD },
    elapsedMs: 0,
  };
  const done = (err) => {
    if (err) out.error = err;
    out.elapsedMs = Date.now() - t0;
    return out;
  };

  let r;
  try {
    r = await client.htmlOf(searchUrl(cfg, PROBE_WD), { siteBase: cfg.siteBase });
  } catch (e) {
    const f = failFrom(e);
    out.status = f.status;
    return done(f);
  }
  out.status = r.status;
  const rows = parse.parseList(r.text, cfg.imageBase);
  out.rows = rows.length;
  if (rows[0]) out.sample = { entryId: rows[0].entryId, title: rows[0].title, posterPath: rows[0].posterPath };
  out.ok = true;
  return done(null);
}

/* ---------------------------------------------------------------- 动作 */

const actions = {
  /** 注册：把"这个域是什么、它有什么、图片去哪儿取"报给面板（面板据此分派前缀） */
  register(args, ctx) {
    bind(ctx);
    const c = settings.read();
    return {
      ok: true,
      domain: DOMAIN,
      series: false,
      name: pkg.name || DOMAIN,
      version: pkg.version || '',
      language: c.language,
      /* 海报是整串 URL，不上报基地址（面板见到绝对地址会原样透传） */
      imageBase: '',
      capabilities: CAPABILITIES,
    };
  },

  /** 取元数据 —— 面板按域分派过来，一次一个条目 */
  async lookup(args = {}, ctx) {
    bind(ctx);
    return doLookup(args.entryId);
  },

  /** 电影式：没有分集可给，如实回空 */
  async season(args = {}, ctx) {
    bind(ctx);
    return { ok: true, item: { episodes: [] } };
  },

  /** 搜索：按名字给候选（面板的搜索端点与首页插件都用它） */
  async search(args = {}, ctx) {
    bind(ctx);
    return doSearch(args.wd);
  },

  /**
   * 任意路径 —— **响应体本体**，不解析、不裁剪。
   * 失败抛错由动作层转成失败回复（与 `lookup` 同一取向）。
   */
  async get(args = {}, ctx) {
    bind(ctx);
    const p = String(args.path || '').trim();
    if (!p) return { ok: false, error: { code: 'BAD_PATH', message: '站点路径不能为空' } };
    const c = settings.read();
    const base = settings.stripSlash(c.siteBase);
    let url = base + (p.startsWith('/') ? p : '/' + p);
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(args.params || {})) {
      if (v === undefined || v === null || v === '') continue;
      qs.set(k, String(v));
    }
    if (qs.toString()) url += (url.includes('?') ? '&' : '?') + qs.toString();
    try {
      const r = await client.htmlOf(url, { siteBase: c.siteBase });
      return { ok: true, status: r.status, body: r.text };
    } catch (e) {
      return { ok: false, error: failFrom(e) };
    }
  },

  /** 连通性自检（设置页那颗「测试」）：一律返回对象，成败看 `ok` */
  async test(args = {}, ctx) {
    bind(ctx);
    return doTest(args.form || args || {});
  },

  /**
   * webui 的后端（面板把 `/api/plugins/<类型>/<id>/api/**` 原样转过来，它不解析内容）。
   * 设置与缓存都在插件自己这边（契约第十一节）。
   */
  async http(args = {}, ctx) {
    bind(ctx);
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
      const next = Object.assign({}, settings.raw());
      for (const k of ['siteBase', 'imageBase']) {
        if (body[k] === undefined) continue;
        const v = String(body[k] || '').trim();
        if (v && !/^https?:\/\//i.test(v)) return { status: 400, body: { error: `${k} 必须是 http(s) 地址，或留空用内置地址` } };
        next[k] = v;
      }
      if (body.language !== undefined) {
        const v = String(body.language || '').trim();
        if (!v) return { status: 400, body: { error: '语言段不能为空（例如 cn）' } };
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

    if (p === '/test' && method === 'POST') return { body: await doTest(body.form || body || {}) };

    if (p === '/cache' && method === 'GET') return { body: cache.stats() };

    if (p === '/cache/clear' && method === 'POST') {
      const out = cache.clear(body.table ? String(body.table) : '');
      return { body: { ok: true, cache: out } };
    }

    return { status: 404, body: { error: `插件设置页没有这个路径：${method} ${p}` } };
  },
};

/** 设置页要看的那些（本站没有 token 这类凭据，全部可直接回显） */
function view() {
  const c = settings.read();
  return {
    settings: {
      siteBase: c.siteBase,
      imageBase: c.imageBase,
      language: c.language,
      cacheTtlDays: c.cacheTtlDays,
      cacheMaxMB: c.cacheMaxMB,
    },
    official: {
      siteBase: settings.DEFAULT_SITE_BASE,
      imageBase: settings.DEFAULT_IMAGE_BASE,
      language: settings.DEFAULT_LANGUAGE,
    },
    cache: cache.stats(),
  };
}

module.exports = { actions, DOMAIN, CAPABILITIES };