'use strict';
/**
 * 猫爪源协议层（**协议知识全在这里**，不含任何面板状态）
 *
 *   - 地址归一化：把填的地址规范成源服务基地址
 *   - `/config` 解析：按 video/read/comic/music/pan 摊平成站点数组
 *   - 探测：`GET /check` + `GET /config`
 *
 * 这一份是从面板的 `server/core/catpaw.js` 搬过来的（面板那边已删掉）：协议属于源插件，
 * 面板只做编排与打分，不再认识 `/config`、`/search` 这些路径。
 */
const { request } = require('./upstream');

const GROUPS = [
  ['video', '视频'],
  ['read', '阅读'],
  ['comic', '漫画'],
  ['music', '音乐'],
  ['pan', '网盘'],
];

/** 规范成源服务基地址（去掉 index.js / index.config.js / website / 结尾斜杠） */
function normSourceUrl(raw) {
  let u = String(raw || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  u = u.replace(/\/+$/, '');
  u = u.replace(/\/index\.js(\.md5)?$/i, '');
  u = u.replace(/\/index\.config\.js(\.md5)?$/i, '');
  u = u.replace(/\/website$/i, '');
  return u;
}

/** `/config` 摊平成站点数组（每个站点带上它属于哪一组） */
function normalizeSites(config) {
  const out = [];
  for (const [g, label] of GROUPS) {
    const arr = (config && config[g] && config[g].sites) || [];
    for (const s of arr) out.push(Object.assign({}, s, { group: g, groupLabel: label }));
  }
  return out;
}

async function fetchConfig(baseUrl, { timeout = 20000 } = {}) {
  const r = await request(baseUrl, '/config', { timeout });
  if (!r.ok || !r.json) throw new Error('源 /config 返回 HTTP ' + r.status);
  return r.json;
}

async function fetchSites(baseUrl, opts) {
  const config = await fetchConfig(baseUrl, opts);
  return { config, sites: normalizeSites(config) };
}

/** 探测一个源地址是否可用（`/check` + `/config`）—— 手动"能不能用"的那一发 */
async function probe(baseUrl, { timeout = 8000 } = {}) {
  const out = { url: baseUrl, ok: false, check: null, siteCount: 0, elapsed: 0, error: null };
  const t0 = Date.now();
  try {
    const c = await request(baseUrl, '/check', { timeout });
    if (!c.ok) throw new Error('GET /check -> HTTP ' + c.status);
    out.check = c.json;
    const cfg = await request(baseUrl, '/config', { timeout: Math.max(timeout, 15000) });
    if (!cfg.ok || !cfg.json) {
      throw new Error('GET /config -> HTTP ' + cfg.status + (cfg.text ? '：' + cfg.text.slice(0, 140) : ''));
    }
    out.sites = normalizeSites(cfg.json);
    out.siteCount = out.sites.length;
    out.config = cfg.json;
    out.ok = true;
  } catch (e) {
    out.error = e && e.name === 'AbortError' ? '请求超时' : String((e && e.message) || e);
  }
  out.elapsed = Date.now() - t0;
  return out;
}

module.exports = { GROUPS, normSourceUrl, normalizeSites, fetchConfig, fetchSites, probe };
