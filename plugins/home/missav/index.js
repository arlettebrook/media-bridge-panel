'use strict';
/**
 * MissAV 首页插件 · 动作层
 *
 * 行声明与行处理器在 `lib/rows.js`。这里只负责**面板要的那几个动作**与"参数合并 / 结果缓存 /
 * 分页透传"这套规矩：
 *
 *   rows   → 申报行清单（面板据此做 Emby 的「媒体库」）
 *   run    → 跑一行：入参 `{ rowId, params, startIndex, limit }`，回 `{ items, total }`
 *   http   → 自带 webui 的后端（设置页：基地址 + 每行入口路径 + 缓存用量）
 *
 * **分页原样透传**：`startIndex` / `limit` 是客户端从请求里取出来的，取哪一页由本插件决定
 * （见 `lib/rows.js` 的 `listPage`），面板与本层都**不切片**。
 *
 * **缓存归插件**（契约第十节）：行声明里的 `cacheDuration` 由这里执行。这一份落在插件的
 * 数据目录里（`lib/storage.js`），所以重启之后热门行还是热的，设置页也能报用量并一键清空。
 */
const settings = require('./lib/settings');
const storage = require('./lib/storage');
const { ROWS, handlers } = require('./lib/rows');
const pkg = require('./plugin.json');

/** 缓存条数上限：超了先清过期的，还超就按写入顺序淘汰最旧的（小仓库，不必上 LRU） */
const CACHE_SOFT_MAX = 200;

/** 面板给的上下文：`{ type, id, dataDir, log }` */
function bindCtx(ctx) {
  settings.bind(ctx && ctx.dataDir);
  storage.bind(ctx && ctx.dataDir);
}

const fail = (code, message) => {
  const e = new Error(message);
  e.code = code;
  return e;
};

/* ------------------------------------------------------------- 参数 */

/** 声明默认值 ← 已保存值 ← 本次临时覆盖 */
function mergeParamValues(decls, saved, overrides) {
  const out = {};
  for (const p of decls || []) {
    let v = p.value;
    if (saved && Object.prototype.hasOwnProperty.call(saved, p.name)) v = saved[p.name];
    if (overrides && Object.prototype.hasOwnProperty.call(overrides, p.name)) v = overrides[p.name];
    out[p.name] = v === undefined || v === null ? '' : String(v);
  }
  return out;
}

/** 只留清单里声明过的行 / 参数（防止网页 POST 任意键进设置文件） */
function sanitizeRowParams(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const row of ROWS) {
    const src = input[row.id];
    if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
    const vals = {};
    for (const p of row.params || []) {
      if (!Object.prototype.hasOwnProperty.call(src, p.name)) continue;
      vals[p.name] = String(src[p.name] === undefined || src[p.name] === null ? '' : src[p.name]);
    }
    if (Object.keys(vals).length) out[row.id] = vals;
  }
  return out;
}

/* ------------------------------------------------------------- 缓存 */

/** 命中就回缓存的结果；过期的**当场删掉**（别让过期条目一直占着配额） */
function cacheGet(key) {
  const v = storage.get(key);
  if (!v || typeof v !== 'object') return null;
  if (!(Number(v.expiresAt) > Date.now())) {
    storage.del(key);
    return null;
  }
  return v.result || null;
}

function cachePut(key, result, seconds) {
  storage.set(key, { expiresAt: Date.now() + seconds * 1000, result });
  const ks = storage.keys();
  if (ks.length <= CACHE_SOFT_MAX) return;
  for (const k of ks) {
    if (storage.keys().length <= CACHE_SOFT_MAX / 2) break;
    const v = storage.get(k);
    if (!v || !(Number(v.expiresAt) > Date.now())) storage.del(k);
  }
}

/* ------------------------------------------------------------- 执行 */

/** 跑一行：超时只是"放弃结果"，失败一律抛带 code 的 Error（面板如实转成失败码） */
async function executeRow(row, params, paging) {
  const fn = handlers[row.functionName];
  if (typeof fn !== 'function') {
    throw fail('BAD_MANIFEST', `行 ${row.id}: functionName「${row.functionName}」解析不到处理器`);
  }
  const timeoutMs = Number(row.timeoutMs) > 0 ? Number(row.timeoutMs) : 20000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const ctx = { params, startIndex: paging.startIndex, limit: paging.limit, signal: ctrl.signal };
  try {
    const timeoutReject = new Promise((_, reject) =>
      ctrl.signal.addEventListener('abort', () => reject(fail('TIMEOUT', `插件执行超时（${timeoutMs}ms）`)))
    );
    const raw = await Promise.race([Promise.resolve().then(() => fn(ctx)), timeoutReject]);
    const list = raw && Array.isArray(raw.items) ? raw.items : raw;
    if (!Array.isArray(list)) throw fail('BAD_RESULT', '处理器必须返回数组（或 {items:[…]}）');
    const declared = raw && typeof raw === 'object' && !Array.isArray(raw) ? Number(raw.total) : NaN;
    return {
      items: list,
      /* 插件没说自己总共有多少 ⇒ 就按本页条数如实报 */
      total: Number.isFinite(declared) && declared > 0 ? declared : list.length,
    };
  } finally {
    clearTimeout(timer);
  }
}

const flying = new Map();

/**
 * 跑一行（带缓存与单飞）。`paging` 由调用方原样透传。
 *
 * ⚠️ 分页必须进缓存键 —— 同一行的第 1 页与第 2 页是两个结果，混了就会串页。
 */
async function runRow(rowId, overrides, paging) {
  const row = ROWS.find((r) => r.id === rowId);
  if (!row) throw fail('NOT_FOUND', `行不存在：${rowId}`);

  const page = {
    startIndex: Math.max(0, Number(paging && paging.startIndex) || 0),
    limit: Math.max(0, Number(paging && paging.limit) || 0),
  };
  const params = mergeParamValues(row.params, settings.read().rowParams[rowId], overrides);
  const key = `${rowId}:${JSON.stringify(params)}:${page.startIndex}:${page.limit}`;

  const hit = cacheGet(key);
  if (hit) return Object.assign({}, hit, { cached: true });

  const inflight = flying.get(key);
  if (inflight) return Object.assign({}, await inflight, { cached: false, shared: true });

  const task = executeRow(row, params, page);
  flying.set(key, task);
  let out;
  try {
    out = await task;
  } finally {
    flying.delete(key);
  }

  if (Number(row.cacheDuration) > 0) cachePut(key, out, Number(row.cacheDuration));
  return Object.assign({}, out, { cached: false });
}

/* ------------------------------------------------------------- 自检 */

/** 拿当前的（可能还没保存的）设置去打一次真实列表页，回"通不通、拿到几条" */
async function test(body) {
  const cfg = settings.current(body);
  const t0 = Date.now();
  try {
    const raw = String((body && body.path) || '').trim() || '/dm291/cn/today-hot?sort=today_views';
    const { getHtml } = require('./lib/fetch');
    const { parseVideoList, parseTotalPages, canonicalSlug } = require('./lib/parse');
    const u = new URL(settings.stripSlash(cfg.siteBase) + (raw.startsWith('/') ? raw : '/' + raw));
    const html = await getHtml(u.toString(), { siteBase: cfg.siteBase });
    const items = parseVideoList(html, { imageBase: cfg.imageBase });
    return {
      ok: true,
      elapsedMs: Date.now() - t0,
      siteBase: cfg.siteBase,
      imageBase: cfg.imageBase,
      url: u.toString(),
      count: items.length,
      totalPages: parseTotalPages(html),
      first: items[0] ? { id: items[0].id, slug: canonicalSlug(items[0].id), title: items[0].title, poster: items[0].poster } : null,
    };
  } catch (e) {
    return {
      ok: false,
      elapsedMs: Date.now() - t0,
      siteBase: cfg.siteBase,
      url: (body && body.path) || '',
      error: { code: (e && e.code) || 'NETWORK', message: (e && e.message) || String(e) },
    };
  }
}

/* ------------------------------------------------------------- 动作 */

/**
 * 面板要的行形状（不含 handler —— 那是插件自己的事）。
 * `collectionType` 一律 `movies`：站上每个条目都是单本影片，没有剧集式的内容，库类型不随参数变。
 * 声明了 `feed` 的行**必须把它报出去** —— 面板靠它把客户端"只要推荐"的查询路由到那一行。
 */
function publicRow(r) {
  const out = {
    id: r.id,
    title: r.title,
    collectionType: 'movies',
    cacheDuration: r.cacheDuration || 0,
    params: r.params || [],
  };
  if (r.feed) out.feed = r.feed;
  return out;
}

const actions = {
  /** 申报行清单：面板据此做「媒体库」（`Views`），并把某个 `feed` 的查询路由到对应行 */
  rows(args, ctx) {
    bindCtx(ctx);
    return { ok: true, rows: ROWS.map(publicRow) };
  },

  /** 跑一行：`{ rowId, params?, startIndex?, limit? }` → `{ items, total, cached? }` */
  async run(args = {}, ctx) {
    bindCtx(ctx);
    return runRow(String(args.rowId || ''), args.params, { startIndex: args.startIndex, limit: args.limit });
  },

  /**
   * webui 的后端（面板把 `/api/plugins/<类型>/<id>/api/**` 原样转过来，它不解析内容）。
   * 设置与行参数都在插件自己这边（契约第十一节）。
   */
  async http(args = {}, ctx) {
    bindCtx(ctx);
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

    if (p === '/state' && method === 'GET') {
      const rawCfg = settings.raw();
      const cfg = settings.read();
      return {
        body: {
          plugin: { id: pkg.id, name: pkg.name, version: pkg.version },
          settings: { siteBase: cfg.siteBase, imageBase: cfg.imageBase },
          defaults: settings.defaults(),
          cache: storage.stats(),
          rows: ROWS.map(publicRow),
          rowParams: rawCfg.rowParams || {},
        },
      };
    }

    if (p === '/settings' && method === 'POST') {
      const next = Object.assign({}, settings.raw());
      for (const k of ['siteBase', 'imageBase']) {
        if (body[k] !== undefined) next[k] = String(body[k] || '').trim();
      }
      /* 行参数：整份替换（网页每次提交都带全），并且只留声明过的行 / 参数 */
      if (body.rowParams !== undefined) next.rowParams = sanitizeRowParams(body.rowParams);
      settings.write(next);
      return { body: { ok: true } };
    }

    if (p === '/test' && method === 'POST') return { body: await test(body) };

    if (p === '/cache/clear' && method === 'POST') {
      storage.clear();
      return { body: { ok: true, cache: storage.stats() } };
    }

    if (p === '/cache' && method === 'GET') return { body: { ok: true, cache: storage.stats() } };

    return { status: 404, body: { error: `没有这个路径：${method} ${p}` } };
  },
};

module.exports = { actions };