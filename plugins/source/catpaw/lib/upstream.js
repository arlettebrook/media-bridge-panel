'use strict';
/**
 * 插件自己的 HTTP 客户端（**不 require 面板任何代码** —— 插件是独立包，面板升级不该牵着它）。
 *
 * 形状与面板那份（`server/core/upstream.js` 的 `request`）保持一致：
 *   · string / Buffer 原样透传，对象按 JSON 序列化
 *   · 回 `{ status, ok, text, json, buf, contentType }`，超时抛 `AbortError`
 *
 * **为什么连 UA 都照抄**：源站那边只看得到这个串。换个 UA 属于"换了个人来打"，
 * 有的站会因此给出不同的响应 —— 这一批的口径是"行为一字不变"，所以先照旧，
 * 要改就是一次显式的决定（改这一处即可）。
 */
const UA = 'Emby/4.8.0.0';

function hasUA(headers) {
  return Object.keys(headers || {}).some((k) => k.toLowerCase() === 'user-agent');
}

async function request(baseUrl, p, { method = 'GET', body = null, timeout = 30000, headers = {} } = {}) {
  if (!baseUrl) throw new Error('尚未设置上游地址');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const sendBody = body !== null && body !== undefined && method !== 'GET' && method !== 'HEAD';
    const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    /* 先铺自称，再盖调用方的头 —— 显式给了 `User-Agent` 就尊重它。
     * ⚠️ 必须用 `hasUA` 判断：写小写 `user-agent` 时直接 assign 会留下两个键，HTTP 头会重复发。 */
    const h = hasUA(headers) ? Object.assign({}, headers) : Object.assign({ 'User-Agent': UA }, headers);
    const res = await fetch(baseUrl + p, {
      method,
      headers: sendBody ? Object.assign({ 'Content-Type': 'application/json' }, h) : h,
      body: sendBody ? payload : undefined,
      signal: ctrl.signal,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString('utf8');
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* 非 JSON（图片 / 视频流 / HTML） */
    }
    return { status: res.status, ok: res.ok, text, json, buf, contentType: res.headers.get('content-type') || '' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { UA, request };
