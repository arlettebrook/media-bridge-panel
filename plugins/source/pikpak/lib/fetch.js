'use strict';
/**
 * 插件自己的 HTTP 客户端（Node 自带 fetch，不 require 面板任何代码）。
 *
 * 两类调用共用这一个出口，差别只在头：
 *   · 磁力站（HTML）—— Safari 的 UA + 浏览器 Accept，`redirect: 'manual'`
 *     （站点换域名时如实报出来，不悄悄跟过去 —— 地址该由设置页显式改）
 *   · PikPak（JSON）—— Chrome 的 UA（站点按浏览器 UA 放行这套接口），头由调用方给全
 *
 * 非 2xx **不在这里抛**：上层要按状态码分辨「令牌过期」（401）与别的错，所以状态原样回。
 * 超时抛 `AbortError` —— 面板与插件约定的「这是超时」判据就是它。
 */
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15';
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const ACCEPT_HTML =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8';

/** 磁力站页面用的头 */
function pageHeaders(base) {
  return {
    'User-Agent': BROWSER_UA,
    Accept: ACCEPT_HTML,
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    Referer: String(base || '').replace(/\/+$/, '') + '/',
  };
}

/**
 * 发一次请求。返回 `{ status, ok, text, json, url, bytes }`。
 * `json` 只在响应体解得开时给（不是 JSON 就回 null）；
 * `bytes` 是响应体的原始字节 —— 二进制（`.torrent` 那种）只能用这个，`text` 已经按 utf8 解过、会失真；
 * `body` 若是对象会自动 JSON 序列化（并补 `Content-Type`）。
 */
async function request(url, { method = 'GET', headers, body, timeout = 15000, redirect = 'follow' } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1000, Number(timeout) || 15000));
  const h = Object.assign({}, headers || {});
  let payload;
  if (body !== undefined && body !== null) {
    payload = typeof body === 'string' ? body : JSON.stringify(body);
    if (!h['Content-Type'] && !h['content-type']) h['Content-Type'] = 'application/json';
  }
  let res;
  let text = '';
  let bytes = null;
  try {
    res = await fetch(url, { method, headers: h, body: payload, redirect, signal: ctrl.signal });
    bytes = Buffer.from(await res.arrayBuffer());
    text = bytes.toString('utf8');
  } finally {
    clearTimeout(timer);
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 不是 JSON（页面、空体、错误页）—— 如实留 null */
  }
  return { status: res.status, ok: res.ok, text, json, url: res.url || url, bytes };
}

/** 拉一个页面（磁力站用）；非 2xx 也原样回，由调用方判 */
async function getHtml(url, { base, timeout = 15000 } = {}) {
  return request(url, { headers: pageHeaders(base), timeout, redirect: 'manual' });
}

module.exports = { BROWSER_UA, CHROME_UA, pageHeaders, request, getHtml };