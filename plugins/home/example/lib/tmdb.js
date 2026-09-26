'use strict';
/**
 * TMDB 客户端（首页示例插件内部这一半）—— 从元数据插件那份 `lib/tmdb.js` 里
 * **只取首页取数用得上的部分**：发请求（网络类失败重试一次）、拼图片地址、连通性自检。
 *
 * 不带元数据那份响应缓存：首页取的都是**榜单 / 发现 / 趋势**这类每天都在变的路径，
 * 缓存它们没有意义（元数据插件那份缓存也只认 `/movie/{数字}` 这种元数据路径）。
 * 唯一值得缓存的 genre 名单由 `rows.js` 自己用 `storage` 管（见那里）。
 *
 * 配置在插件自己的 `data/settings.json`（见 `lib/settings.js`）。
 */
const upstream = require('./upstream');
const settings = require('./settings');

const TIMEOUT_MS = 10000;

/** 自检的默认探测对象：日志里 Emby 客户端真实要过的 `AnyProviderIdEquals=tmdb.95350` */
const DEFAULT_PROBE = { tmdbId: 95350, type: 'tv' };

/** 拼图片地址（`poster_path` 以 / 开头） */
function imageUrl(imageBase, size, filePath) {
  return filePath ? `${imageBase}/${size}${filePath}` : '';
}

/** 拿当前设置拼一张图片地址（**同步返回字符串**，不用 await） */
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

/**
 * 发请求，**网络类失败立即重试一次**。
 * 经过代理的网络里 TMDB 链路可能不稳定（实测握手阶段即被中断）—— 一次首页取数要连打多个榜单，
 * 全撞上坏窗口的概率不低，表现就是"首页全空"。只重试网络/超时；401/404 这类**确定性失败**重试没有意义。
 */
async function requestWithRetry(apiBase, target, opts) {
  try {
    return await upstream.request(apiBase, target, opts);
  } catch (e) {
    console.log(`  ↻ 首页示例：TMDB ${classify(e).code}，立即重试一次：${target}`);
    return upstream.request(apiBase, target, opts);
  }
}

/**
 * 任意 TMDB GET —— **成功回响应体本体**（不是 `{data}` 包装），**失败抛错**
 * （`err.code` / `err.status` / `err.data`）。
 */
async function get(api, { params = {}, cfg, timeoutMs } = {}) {
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
  let r;
  try {
    r = await requestWithRetry(c.apiBase, target, {
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

/**
 * 测一份配置通不通（插件设置页的「测试」按钮）。
 * 永远返回对象（不抛），成败看 `ok` / `error.code`；**绝不回显 token 本身**。
 * 两步都**绕过任何缓存**：`/configuration` 与探测对象存在的意义就是测"当下"通不通。
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
    conf = await get('configuration', { cfg });
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
    j = await get(`${type}/${probeId}`, { cfg });
  } catch (e) {
    return done(friendly(e, `/${type}/${probeId}`));
  }
  out.item = {
    tmdbId: Number(j && j.id) || probeId,
    title: String((j && (j.name || j.title)) || ''),
    year: String((j && (j.first_air_date || j.release_date)) || '').slice(0, 4),
    poster: imageUrl(cfg.imageBase, 'w500', j && j.poster_path),
  };
  out.ok = true;
  return done(null);
}

module.exports = {
  TIMEOUT_MS,
  DEFAULT_PROBE,
  imageUrl,
  imageUrlOf,
  classify,
  buildTarget,
  requestWithRetry,
  get,
  test,
};