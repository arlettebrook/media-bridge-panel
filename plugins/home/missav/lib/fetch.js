'use strict';
/**
 * 插件自己的 HTTP 层（**不 require 面板任何代码** —— 插件是独立包）。
 *
 * 取的是站点列表页 / 影片页的 HTML。三条取向来自线上实测与项目规矩：
 *   · 用 Safari 17.1 的 UA 与语言头、带上站点 Referer —— 站点对默认 Node UA 会直接给风控页；
 *   · `redirect: 'manual'`：跳转本身就是要如实看见的异常（跳转后的内容不是这一页要的东西）；
 *   · **响应体短于阈值判为风控 / 失败并抛错** —— 风控页也是 HTTP 200，靠长度区分；
 *     绝不回编造的占位条目（契约第一节的铁律）。
 */
const settings = require('./settings');

/** 线上实测：正常列表页 22 万字节以上，风控 / 拒绝页只有几 KB */
const MIN_BODY = 10000;
const DEFAULT_TIMEOUT_MS = 15000;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15';
const ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8';
const ACCEPT_LANGUAGE = 'zh-CN,zh;q=0.9,en;q=0.8';

const fail = (code, message) => {
  const e = new Error(message);
  e.code = code;
  return e;
};

/**
 * 取一页 HTML。失败一律抛带 `code` 的 Error：
 * `TIMEOUT` / `NETWORK` / `UPSTREAM_HTTP` / `RISK_CONTROL`。
 *
 * `signal` 来自上层（行执行的超时控制器），这里再叠一层自己的超时；
 * 两层谁先到都算超时。
 */
async function getHtml(url, { siteBase, signal, timeoutMs } = {}) {
  const base = settings.stripSlash(siteBase) || settings.read().siteBase;
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const res = await fetch(url, {
      redirect: 'manual',
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA,
        Accept: ACCEPT,
        'Accept-Language': ACCEPT_LANGUAGE,
        Referer: base + '/',
      },
    });
    if (res.status >= 300 && res.status < 400) {
      throw fail('UPSTREAM_HTTP', '上游要求跳转（HTTP ' + res.status + '）：' + url);
    }
    if (!res.ok) throw fail('UPSTREAM_HTTP', '上游返回 HTTP ' + res.status + '：' + url);
    const text = await res.text();
    if (text.length < MIN_BODY) {
      throw fail('RISK_CONTROL', '上游响应过短（' + text.length + ' 字节，阈值 ' + MIN_BODY + '），判为风控或异常：' + url);
    }
    return text;
  } catch (e) {
    if (e && e.code) throw e;
    if (timedOut) throw fail('TIMEOUT', '请求上游超时：' + url);
    if (e && (e.name === 'AbortError' || /abort/i.test(e.message || ''))) throw fail('TIMEOUT', '请求上游被中止：' + url);
    const cause = (e && e.cause && (e.cause.code || e.cause.message)) || '';
    throw fail('NETWORK', '连不上上游' + (cause ? '：' + cause : '') + '（' + url + '）');
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

module.exports = { UA, ACCEPT, ACCEPT_LANGUAGE, MIN_BODY, DEFAULT_TIMEOUT_MS, getHtml };