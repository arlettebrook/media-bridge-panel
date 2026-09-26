'use strict';
/**
 * 首页示例插件 · 动作层
 *
 * 行声明与行处理器在 `lib/rows.js`（批次 9 从老的 `emby/home` 那份示例搬来）。
 * 这里只负责**面板要的那几个动作**与"参数合并 / 结果缓存 / 分页透传"这套规矩：
 *
 *   rows   → 申报行清单（面板据此做 Emby 的「媒体库」；`collectionType` 已按当前参数定好）
 *   run    → 跑一行：入参 `{ rowId, params, startIndex, limit }`，回 `{ items, total }`
 *   http   → 自带 webui 的后端（设置页：token / 语言 / 图床 + 每行参数）
 *
 * **分页原样透传**：`startIndex` / `limit` 是客户端（Emby）从请求里取出来的，
 * 插件自己决定取哪一页、要不要按页打上游 —— 面板与本层都**不切片**。
 *
 * **缓存归插件**（契约第十节）：每行声明的 `cacheDuration` 由这里执行，
 * 缓存就在本进程内存里 —— 与改造前"面板内存缓存"的行为一致（重启即空）。
 */
const settings = require('./lib/settings');
const tmdb = require('./lib/tmdb');
const { ROWS, handlers } = require('./lib/rows');
const pkg = require('./plugin.json');

/** 与面板侧的上限一致（真正裁剪在面板，这里只是序列化前的粗保护） */
const MAX_ITEMS = 200;
const MAX_ITEMS_SERIALIZE = 2000;
const CACHE_SOFT_MAX = 300;

/** 结果缓存：key = 行id:参数JSON:startIndex:limit；只缓存成功结果 */
const cache = new Map();
/** 单飞：同 key 的并发请求共享一个 Promise，避免同时打上游 */
const flying = new Map();

const fail = (code, message) => {
  const e = new Error(message);
  e.code = code;
  return e;
};

/* ------------------------------------------------------------- 参数 */

/** 声明默认值 ← 已保存值 ← 本次临时覆盖（`count` 顺带转数字） */
function mergeParamValues(decls, saved, overrides) {
  const out = {};
  for (const p of decls || []) {
    let v = p.value;
    if (saved && Object.prototype.hasOwnProperty.call(saved, p.name)) v = saved[p.name];
    if (overrides && Object.prototype.hasOwnProperty.call(overrides, p.name)) v = overrides[p.name];
    if (p.type === 'count') v = Number(v) || Number(p.value) || 0;
    out[p.name] = v;
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
      vals[p.name] = p.type === 'count' ? Number(src[p.name]) || 0 : String(src[p.name] ?? '');
    }
    if (Object.keys(vals).length) out[row.id] = vals;
  }
  return out;
}

/**
 * 一个库在 Emby 协议里的 `CollectionType`：**行自己声明的** → 按该行当前的 `type` 参数推
 * （`movie`→`movies` / `tv`→`tvshows`）→ `mixed`。
 *
 * 声明优先：`regional_series` 这类行没有 `type` 参数，但它在 TMDB 那边就是剧 —— 只有插件作者说得准。
 * 按参数推的那档永远跟内容一致（用户把参数切到"剧集"，库就跟着变 `tvshows`）。
 */
function resolveCollectionType(row, saved) {
  if (row.collectionType) return row.collectionType;
  const v = String(mergeParamValues(row.params, saved).type || '').toLowerCase();
  if (v === 'movie') return 'movies';
  if (v === 'tv') return 'tvshows';
  return 'mixed';
}

/** 面板要的行形状（不含 handler / 参数声明 —— 那些是插件自己的事） */
function publicRow(row, saved) {
  const out = { id: row.id, title: row.title, collectionType: resolveCollectionType(row, saved) };
  if (row.feed) out.feed = row.feed;
  return out;
}

/* ------------------------------------------------------------- 执行 */

/** 跑一行：超时只是"放弃结果"，失败一律抛带 code 的 Error（面板如实转成失败码） */
async function executeRow(row, params, paging) {
  const fn = handlers[row.functionName];
  if (typeof fn !== 'function') {
    throw fail('BAD_MANIFEST', `行 ${row.id}: functionName「${row.functionName}」解析不到处理器`);
  }
  const timeoutMs = Number(row.timeoutMs) > 0 ? Number(row.timeoutMs) : 15000;
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
    const items = list.slice(0, MAX_ITEMS_SERIALIZE);
    return {
      items,
      /* 插件没说自己总共有多少 ⇒ 就按本页条数如实报 */
      total: Number.isFinite(declared) && declared > 0 ? declared : items.length,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 跑一行（带缓存与单飞）。`paging` 由调用方原样透传 */
async function runRow(rowId, overrides, paging) {
  const row = ROWS.find((r) => r.id === rowId);
  if (!row) throw fail('NOT_FOUND', `行不存在：${rowId}`);

  const page = {
    startIndex: Math.max(0, Number(paging && paging.startIndex) || 0),
    limit: Math.max(0, Number(paging && paging.limit) || 0),
  };
  const params = mergeParamValues(row.params, settings.read().rowParams[rowId], overrides);
  /* ⚠️ 分页必须进缓存键 —— 同一行的第 1 页与第 2 页是两个结果，混了就会串页 */
  const key = `${rowId}:${JSON.stringify(params)}:${page.startIndex}:${page.limit}`;

  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return Object.assign({}, hit.result, { cached: true });

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

  if (row.cacheDuration > 0) {
    cache.set(key, { result: out, expiresAt: Date.now() + row.cacheDuration * 1000 });
    if (cache.size > CACHE_SOFT_MAX) {
      for (const [k, v] of cache) {
        if (cache.size <= CACHE_SOFT_MAX / 2) break;
        if (v.expiresAt <= Date.now()) cache.delete(k);
      }
    }
  }
  return Object.assign({}, out, { cached: false });
}

/* ------------------------------------------------------------- 动作 */

const actions = {
  /** 申报行清单：面板据此做「媒体库」（`Views`），并把某个 `feed` 的查询路由到对应行 */
  rows() {
    const saved = settings.read().rowParams;
    return { ok: true, rows: ROWS.map((r) => publicRow(r, saved[r.id])) };
  },

  /** 跑一行：`{ rowId, params?, startIndex?, limit? }` → `{ items, total, cached? }` */
  async run(args = {}) {
    return runRow(String(args.rowId || ''), args.params, { startIndex: args.startIndex, limit: args.limit });
  },

  /**
   * webui 的后端（面板把 `/api/plugins/<类型>/<id>/api/**` 原样转过来，它不解析内容）。
   * 设置与行参数都在插件自己这边（契约第十一节）。
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

    if (p === '/state' && method === 'GET') {
      const rawCfg = settings.raw();
      const cfg = settings.read();
      return {
        body: {
          plugin: { id: pkg.id, name: pkg.name, version: pkg.version },
          settings: {
            apiBase: cfg.apiBase,
            imageBase: cfg.imageBase,
            language: cfg.language,
            /* 绝不回显 token 本身：只报"填了没有 / 多长" */
            tokenSet: !!cfg.token,
            tokenLength: cfg.token.length,
          },
          rows: ROWS.map((r) => ({
            id: r.id,
            title: r.title,
            collectionType: r.collectionType || '',
            feed: r.feed || '',
            cacheDuration: r.cacheDuration || 0,
            params: r.params || [],
          })),
          rowParams: rawCfg.rowParams || {},
        },
      };
    }

    if (p === '/settings' && method === 'POST') {
      const cur = settings.raw();
      const next = Object.assign({}, cur);
      /* token 空串 = 没改（免得只想改基地址却被空密码框清掉）；要清就给 `clearToken` */
      if (body.clearToken === true) next.token = '';
      else if (String(body.token || '')) next.token = String(body.token);
      for (const k of ['apiBase', 'imageBase']) {
        if (body[k] !== undefined) next[k] = String(body[k] || '').trim();
      }
      if (body.language !== undefined && String(body.language || '').trim()) next.language = String(body.language).trim();
      /* 行参数：整份替换（网页每次提交都带全），并且只留声明过的行 / 参数 */
      if (body.rowParams !== undefined) next.rowParams = sanitizeRowParams(body.rowParams);
      settings.write(next);
      return { body: { ok: true } };
    }

    if (p === '/test' && method === 'POST') {
      return { body: await tmdb.test(body) };
    }

    return { status: 404, body: { error: `没有这个路径：${method} ${p}` } };
  },
};

module.exports = { actions };