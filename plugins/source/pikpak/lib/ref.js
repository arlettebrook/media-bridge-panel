'use strict';
/**
 * 两串「面板只当不透明文本」的编码：
 *
 *   候选 id（`pkm1:<base64url>`）—— 搜索给出的候选，面板原样存进 `vod_id`，
 *     取详情时原样交回。里面是 `{ m: 磁力链接, t: 标题, s: 字节数, d: 做种数 }`。
 *
 *   播放项 ref（`<插件 id>/<base64url>`）—— 契约第五节的形状约定（第一段决定路由）。
 *     两种内容都认：
 *       · `{ f: PikPak 文件 id, n: 文件名 }` —— 已经在网盘里的文件，直接换地址；
 *       · `{ m: 磁力链接, p: 种子内的路径, n: 文件名, s: 字节数 }` —— **还没落盘**的播放项：
 *         文件清单是从 `.torrent` 解析出来的，网盘那边什么都没有，播放时才提交离线下载。
 *     两种都**不存地址**：取回的播放地址是带签名的临时链接，几小时后失效，每次播放现取。
 */
const CANDIDATE_PREFIX = 'pkm1:';

const b64 = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
const unb64 = (s) => JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8'));

/** 认不出就回 null（上层如实报错，不猜） */
function encodeCandidate(body) {
  return CANDIDATE_PREFIX + b64(body);
}

/** 候选里至少要有一件能把下游接下去的东西：磁力链接 */
function decodeCandidate(id) {
  const s = String(id || '');
  if (!s.startsWith(CANDIDATE_PREFIX)) return null;
  try {
    const o = unb64(s.slice(CANDIDATE_PREFIX.length));
    if (!o || typeof o !== 'object') return null;
    if (!o.m) return null;
    return o;
  } catch {
    return null;
  }
}

function encodeRef(pluginId, body) {
  return String(pluginId || '') + '/' + b64(body);
}

/** `f`（网盘文件）或 `m`（磁力）至少有一个 —— 两者都没有的 ref 换不出地址 */
function decodeRef(pluginId, ref) {
  const s = String(ref || '');
  const want = String(pluginId || '') + '/';
  if (!want || !s.startsWith(want)) return null;
  try {
    const o = unb64(s.slice(want.length));
    if (!o || typeof o !== 'object') return null;
    if (!o.f && !o.m) return null;
    return o;
  } catch {
    return null;
  }
}

module.exports = { CANDIDATE_PREFIX, encodeCandidate, decodeCandidate, encodeRef, decodeRef };