'use strict';
/**
 * TMDB 协议客户端（插件内部那一半）—— 原来住在面板的 `server/core/tmdb.js`。
 *
 * 只做四件事：**配置合并**、**发请求（网络失败重试一次）**、**落盘缓存**、**拼图片地址**。
 * "要哪些字段、怎么归一"归 `lib/meta.js`；"面板要什么"归 `index.js` 的动作层。
 *
 * 配置与缓存都在插件自己的 `data/` 下（见 `lib/settings.js` 与 `lib/cache.js`）——
 * 面板不碰这两个文件（契约第十一节）。图片的**基地址**例外：它随「注册」动作报出去，
 * 因为替客户端取图的是面板（契约第六节）。
 */
const upstream = require('./upstream');
const settings = require('./settings');
const cache = require('./cache');

const TIMEOUT_MS = 10000;

/** 自检的默认探测对象：日志里 Emby 客户端真实要过的 `AnyProviderIdEquals=tmdb.95350` */
const DEFAULT_PROBE = { tmdbId: 95350, type: 'tv' };

/** 拼图片地址（`poster_path` 以 / 开头） */
function imageUrl(imageBase, size, filePath) {
  return filePath ? `${imageBase}/${size}${filePath}` : '';
}

/** 拿当前设置拼一张图片地址 */
function imageUrlOf(size, filePath) {
  return imageUrl(settings.read().imageBase, size, filePath);
}

/** 网络层异常 → 可读的错误对象 */
function classify(e) {
  if (e && (e.name === 'AbortError' || /abort/i.test(e.message || ''))) {
    return { code: 'TIMEOUT', message: `请求超时（${TIMEOUT_MS}ms）` };
  }
  const cause = (e && e.cause && (e.cause.code || e.cause.message)) || '';
  return {
    code: 'NETWORK',
    message: '连不上 TMDB' + (cause ? `：${cause}` : ''),
    detail: (e && e.message) || '',
  };
}

/** 拼 query（跳过空值；没给 language 就补当前设置的） */
function buildTarget(p, params, language) {
  const path0 = String(p || '').replace(/^\/+/, '');
  if (!path0) return '';
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    qs.set(k, String(v));
  }
  if (!qs.has('language') && language) qs.set('language', language);
  const s = qs.toString();
  return `/${path0}${path0.includes('?') ? '&' : '?'}${s}`;
}

/* ------------------------------------------------------------ 响应缓存 */

/**
 * **只缓存"元数据类"路径** —— 判据是**请求的性质**，不是"谁问的"：
 *   会缓存：`/movie/{数字}`、`/tv/{数字}`、`/tv/{数字}/season/{数字}`、`/{movie|tv}/{数字}/alternative_titles`
 *   不缓存：榜单/搜索/发现（`/trending/*`、`/movie/top_rated`、`/discover`、`/search`…）
 *   不缓存：`/configuration`（连通性自检 —— 它存在的意义就是测**当下**通不通，缓存即失去意义）
 * 所以首页插件问同一部片的元数据也享受缓存，而榜单仍由它自己管。
 * 「数字」这个约束很关键：`/movie/top_rated` 也长得像 `/movie/xxx`，只有限定纯数字才不会把它卷进来。
 * `alternative_titles`（别名表）**必须一起缓存**：它是"主标题没中文时回退别名"要问的接口。
 */
const META_PATH_RE = /^\/(?:movie|tv)\/\d+(?:\/(?:season\/\d+|alternative_titles))?$/;

function isMetaPath(target) {
  return META_PATH_RE.test(String(target || '').split('?')[0]);
}

/**
 * 缓存键 = 路径 + **排序后**的 query。
 * 排序是为了让"同一请求、参数顺序不同"也命中同一条 —— `lookup()` 手拼 qs，
 * 而 `get()` 走 `URLSearchParams`，顺序本来就不一致，不归一化会白存两份。
 * **不含 apiBase**：换镜像取的还是同一份 TMDB 数据，缓存应当继续有效。
 * 语言与 `append_to_response` 都在 query 里，所以 lean / rich 天然是两个键。
 */
function cacheKey(target) {
  const s = String(target || '');
  const i = s.indexOf('?');
  if (i < 0) return s;
  const p = new URLSearchParams(s.slice(i + 1));
  const pairs = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return s.slice(0, i) + '?' + new URLSearchParams(pairs).toString();
}

/**
 * 发请求，**网络类失败立即重试一次**。
 * 经过代理的网络里 TMDB 链路可能不稳定（实测握手阶段即被中断）—— 一次搜索要连打多个名字，
 * 全撞上坏窗口的概率不低，表现就是"搜什么都空"。失败**不缓存**，所以重试是唯一能压住抖动的动作。
 * 只重试网络/超时；401/404 这类**确定性失败**重试没有意义。
 */
async function requestWithRetry(apiBase, target, opts) {
  try {
    return await upstream.request(apiBase, target, opts);
  } catch (e) {
    console.log(`  ↻ tmdb ${classify(e).code}，立即重试一次：${target}`);
    return upstream.request(apiBase, target, opts);
  }
}

/**
 * `upstream.request` 的缓存包装 —— **TMDB 元数据的唯一出口**（lookup / season / get 共用）。
 * 返回形状与 `upstream.request` 一致，调用方无需知道自己吃的是缓存。
 * **只缓存成功响应**：401/404/5xx/超时一律不写。
 */
async function requestCached(apiBase, target, opts) {
  const useCache = isMetaPath(target);
  const key = useCache ? cacheKey(target) : '';

  if (useCache) {
    const hit = cache.get('meta', key);
    if (hit !== null) {
      let json = null;
      try {
        json = JSON.parse(hit);
      } catch {
        /* 理论上不会发生；真坏了就当没缓存，走网络 */
      }
      if (json) return { status: 200, ok: true, text: hit, json, cached: true };
    }
  }

  const r = await requestWithRetry(apiBase, target, opts);
  if (useCache && r.ok && r.json) cache.put('meta', key, r.text, cache.limits('meta').ttlMs);
  return r;
}

/**
 * 任意 TMDB GET —— **成功回响应体本体**（不是 `{data}` 包装），**失败抛错**
 * （`err.code` / `err.status` / `err.data`）。
 * `opts.noCache`：绕缓存直连上游（连通性自检用；别的调用方不用管缓存，那是这一层的事）。
 */
async function get(api, { params = {}, cfg, timeoutMs, noCache } = {}) {
  const c = cfg || settings.read();
  if (!c.token) {
    const e = new Error('插件还没配 TMDB Token（插件设置页填一个 v4 API Read Access Token）');
    e.code = 'NO_TOKEN';
    throw e;
  }
  const target = buildTarget(api, params, c.language);
  if (!target) {
    const e = new Error('TMDB 路径不能为空');
    e.code = 'BAD_ID';
    throw e;
  }

  const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : TIMEOUT_MS;
  const send = noCache ? requestWithRetry : requestCached;
  let r;
  try {
    r = await send(c.apiBase, target, {
      headers: { Authorization: 'Bearer ' + c.token, Accept: 'application/json' },
      timeout,
    });
  } catch (e) {
    const info = classify(e);
    const err = new Error(info.message);
    err.code = info.code;
    if (info.detail) err.detail = info.detail;
    throw err;
  }
  if (!r.ok) {
    const err = new Error(`TMDB 返回 HTTP ${r.status}（${target}）`);
    err.status = r.status;
    err.data = r.json;
    err.code = r.status === 401 || r.status === 403 ? 'INVALID_TOKEN' : r.status === 404 ? 'NOT_FOUND' : 'UPSTREAM_HTTP';
    throw err;
  }
  return r.json;
}

/* ---------------------------------------------------------------- 搜索 */

/**
 * 名字 → 搜索结果（表 `names`，存的是**整条搜索结果**）。
 * 只存**有结果的成功响应**：负结果（空数组）不存 —— 存了会让新上线的别名条目永远看不见。
 * TMDB 的搜索是**模糊**的：`斗破苍穹年番` 会回 `斗破苍穹`，但判据不能只看"有没有结果"
 * （调用方要自己核对 id 与类型）。
 */
async function search(kind, name, { page, timeoutMs } = {}) {
  const k = kind === 'movie' ? 'movie' : 'tv';
  const q = String(name || '').trim();
  if (!q) return [];
  const p = Math.max(1, Number(page) || 1);
  const c = settings.read();
  const key = `${k}|${c.language}|${q}|p${p}`;
  const hit = cache.get('names', key);
  if (hit) {
    try {
      const rows = JSON.parse(hit);
      if (Array.isArray(rows)) return rows;
    } catch {
      /* 坏条目当没缓存 */
    }
  }

  const body = await get(`search/${k}`, { params: { query: q, include_adult: 'false', page: p }, cfg: c, timeoutMs });
  const rows = (body && body.results) || [];
  if (rows.length) cache.put('names', key, JSON.stringify(rows), cache.NAME_TTL_MS);
  return rows;
}

/* ------------------------------------------------------------ 连通性自检 */

/**
 * 测一份配置通不通（插件设置页的「测试」按钮）。
 * 永远返回对象（不抛），成败看 `ok` / `error.code`；**绝不回显 token 本身**。
 * 两步都**绕过缓存**：`/configuration` 与探测对象存在的意义就是测"当下"通不通。
 */
async function test(body) {
  const t0 = Date.now();
  const saved = settings.raw();
  const cfg = settings.effective(body || {}, saved);
  const type = (body && body.type) === 'movie' ? 'movie' : 'tv';
  const probeId = Number.parseInt((body && body.tmdbId) || DEFAULT_PROBE.tmdbId, 10) || DEFAULT_PROBE.tmdbId;

  const out = {
    ok: false,
    apiBase: cfg.apiBase,
    imageBase: cfg.imageBase,
    language: cfg.language,
    tokenSet: !!cfg.token,
    tokenLength: cfg.token.length,
    probe: { tmdbId: probeId, type },
    elapsedMs: 0,
  };
  const done = (err) => {
    if (err) out.error = err;
    out.elapsedMs = Date.now() - t0;
    return out;
  };

  if (!cfg.token) return done({ code: 'NO_TOKEN', message: '还没填 v4 API Read Access Token' });

  /** `get()` 抛出来的码 → 给用户看的那句（自检就靠它说清"哪一步不对"） */
  const friendly = (e, step) => {
    const code = e.code || 'NETWORK';
    if (code === 'INVALID_TOKEN') return { code, status: e.status, message: `Token 无效或无权限（HTTP ${e.status}）` };
    if (code === 'UPSTREAM_HTTP') return { code, status: e.status, message: `TMDB 返回 HTTP ${e.status}` };
    if (code === 'NOT_FOUND') return { code, status: e.status, message: `${step} 不存在（HTTP 404）` };
    return { code, status: e.status, message: e.message || '连不上 TMDB' };
  };

  /* ① 验 token：/configuration 只需鉴权、不依赖具体条目 */
  let conf;
  try {
    conf = await get('configuration', { cfg, noCache: true });
  } catch (e) {
    out.auth = { status: e.status || 0, ok: false };
    return done(friendly(e, '/configuration'));
  }
  out.auth = { status: 200, ok: true };
  const imgs = (conf && conf.images) || {};
  out.images = { secureBaseUrl: imgs.secure_base_url || '', baseUrl: imgs.base_url || '' };

  /* ② 真反查一个 id：证明"按 id 拿元数据"这条路通 */
  let j;
  try {
    j = await get(`${type}/${probeId}`, { cfg, noCache: true });
  } catch (e) {
    return done(friendly(e, `/${type}/${probeId}`));
  }
  out.item = {
    tmdbId: Number(j && j.id) || probeId,
    title: String((j && (j.name || j.title)) || ''),
    originalTitle: String((j && (j.original_name || j.original_title)) || ''),
    year: String((j && (j.first_air_date || j.release_date)) || '').slice(0, 4),
    overview: String((j && j.overview) || ''),
    poster: imageUrl(cfg.imageBase, 'w500', j && j.poster_path),
    backdrop: imageUrl(cfg.imageBase, 'w780', j && j.backdrop_path),
  };
  out.ok = true;
  return done(null);
}

module.exports = {
  TIMEOUT_MS,
  DEFAULT_PROBE,
  /** 当前生效的设置（读写设置的唯一入口就在 settings.js，这里只是给同包里的调用方一个稳定的口子） */
  current: settings.current,
  imageUrl,
  imageUrlOf,
  classify,
  isMetaPath,
  cacheKey,
  requestWithRetry,
  requestCached,
  get,
  search,
  test,
};
