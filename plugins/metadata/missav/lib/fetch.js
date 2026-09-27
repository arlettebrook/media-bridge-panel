'use strict';
/**
 * 插件自己的 HTTP 客户端（**不 require 面板任何代码** —— 插件是独立包）。
 *
 * 只做一件事：按 MissAV 站的取数口径发一发 GET，返回响应体。
 * 口径照搬第三方 Widget 脚本：Safari 17.1 的 UA + 文档类 `Accept` + 中文 `Accept-Language`
 * + `Referer: <站点>/`；`redirect: 'manual'`（站点的风控会拿跳转当挡箭牌，跟着跳就分不清了）。
 *
 * **失败如实抛**（带 `code` / `status`），不写占位数据：
 *   · `TIMEOUT`        超时
 *   · `NETWORK`        连不上
 *   · `NOT_FOUND`      HTTP 404
 *   · `UPSTREAM_HTTP`  其余非 200、要求跳转、或响应过短（判为风控）
 *
 * 响应体字节数的门槛（`MIN_BYTES`）来自实测：正常影片页与列表页都远大于它，
 * 而风控页是一段很短的提示，用长度这一条就能把"拿到了但其实是拦页"区分开。
 */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15';
const ACCEPT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';
const ACCEPT_LANGUAGE = 'zh-CN,zh;q=0.9,en;q=0.8';
const TIMEOUT_MS = 12000;
/** 小于这个字节数的响应判为风控 / 异常（见文件头说明） */
const MIN_BYTES = 10000;

function fail(code, message, status) {
  const e = new Error(message);
  e.code = code;
  if (status) e.status = status;
  return e;
}

function headersFor(siteBase) {
  return {
    'User-Agent': UA,
    Accept: ACCEPT,
    'Accept-Language': ACCEPT_LANGUAGE,
    Referer: String(siteBase || '').replace(/\/+$/, '') + '/',
  };
}

/**
 * 发一发 GET，**原样回响应**：`{ status, ok, text, bytes, contentType, location }`。
 * 网络类失败抛带 `code` 的错；HTTP 层的成败由调用方按 `status` 判（`ok` 也一并给出）。
 */
async function get(url, { siteBase, timeoutMs } = {}) {
  const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { headers: headersFor(siteBase), redirect: 'manual', signal: ctrl.signal });
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      status: res.status,
      ok: res.ok,
      text: buf.toString('utf8'),
      bytes: buf.length,
      contentType: res.headers.get('content-type') || '',
      location: res.headers.get('location') || '',
    };
  } catch (e) {
    if (e && (e.name === 'AbortError' || /abort/i.test(e.message || ''))) {
      throw fail('TIMEOUT', `请求超时（${timeout}ms）`);
    }
    const cause = (e && e.cause && (e.cause.code || e.cause.message)) || '';
    throw fail('NETWORK', '连不上站点' + (cause ? `：${cause}` : ''));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 取一个 HTML 页面（影片页 / 列表页都走这里）。
 * 在 `get` 之上加两道判据：**HTTP 状态要是 200**，**字节数要够**（否则判风控）；不满足就抛错。
 */
async function htmlOf(url, opts = {}) {
  const r = await get(url, opts);
  if (r.status === 404) throw fail('NOT_FOUND', `页面不存在（HTTP 404）：${url}`, 404);
  if (r.status >= 300 && r.status < 400) {
    throw fail('UPSTREAM_HTTP', `站点要求跳转（HTTP ${r.status}${r.location ? ' → ' + r.location : ''}）`, r.status);
  }
  if (!r.ok) throw fail('UPSTREAM_HTTP', `站点返回 HTTP ${r.status}`, r.status);
  if (r.bytes < MIN_BYTES) {
    throw fail('UPSTREAM_HTTP', `响应只有 ${r.bytes} 字节（< ${MIN_BYTES}），判为风控或异常`, r.status);
  }
  return r;
}

module.exports = { UA, ACCEPT, ACCEPT_LANGUAGE, TIMEOUT_MS, MIN_BYTES, fail, get, htmlOf };