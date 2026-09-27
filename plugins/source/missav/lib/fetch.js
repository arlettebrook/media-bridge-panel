'use strict';
/**
 * 站点取数用的 HTTP 客户端（Node 自带 fetch，不 require 面板任何代码）。
 *
 * 三件事照第三方脚本那份的口径固定下来：
 *   · 请求头是 Safari 17.1 的 UA + 浏览器的 Accept / Accept-Language + `Referer: <站点>/` ——
 *     源站按这套头把它当普通浏览器；
 *   · `redirect: 'manual'` —— 站点换域名时靠 302 把人带走，这里不吃那一跳（地址该由设置页
 *     显式改，悄悄跟过去会让人以为"站点没变"）；
 *   · 响应体不过万字节判为风控页 / 空壳页 —— **如实抛**，不编占位条目
 *     （第三方脚本在这里回的是"已被风控"的假卡片，本插件不那样做）。
 *
 * 不收 `Accept-Encoding`：交给 Node 的 fetch 自己协商与解压，手写那串反而可能让压缩体解不开。
 */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15';
const ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';
/** 小于这个字节数一律当"没拿到真页面"（风控页 / 空壳页都很短） */
const MIN_BYTES = 10000;

/** 页面类请求的头（列表页与影片页共用） */
function pageHeaders(siteBase) {
  return {
    'User-Agent': UA,
    Accept: ACCEPT,
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'Upgrade-Insecure-Requests': '1',
    Referer: String(siteBase || '').replace(/\/+$/, '') + '/',
  };
}

/** 拉一个 HTML 页面。非 2xx / 体太小 → 抛带 code 的错，调用方如实往上报 */
async function getHtml(url, { siteBase, timeout = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1000, Number(timeout) || 15000));
  let res;
  let text = '';
  try {
    res = await fetch(url, { headers: pageHeaders(siteBase), redirect: 'manual', signal: ctrl.signal });
    text = Buffer.from(await res.arrayBuffer()).toString('utf8');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const redirect = res.status >= 300 && res.status < 400;
    const e = new Error(
      `站点回 HTTP ${res.status}` + (redirect ? '（重定向；站点可能换了域名，到设置页改站点基地址）' : '')
    );
    e.code = 'UPSTREAM_HTTP';
    e.status = res.status;
    throw e;
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes < MIN_BYTES) {
    const e = new Error(`响应体只有 ${bytes} 字节（小于 ${MIN_BYTES}），判为风控页或空壳页`);
    e.code = 'UPSTREAM_SMALL';
    e.status = res.status;
    throw e;
  }
  return { status: res.status, ok: true, text, bytes, url: res.url || url };
}

module.exports = { UA, ACCEPT, MIN_BYTES, pageHeaders, getHtml };