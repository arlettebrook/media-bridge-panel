'use strict';
/**
 * 播放项标识 `ref` 的编解码：`<插件 id>/<base64url(JSON)>`（与猫爪源那份同一套约定）。
 *
 * 面板不解释它 —— 只按第一段决定该找哪个插件，其余原样存进 `MediaSourceId`、播放时原样交回。
 *
 * 内容是 `{ u: 影片页地址, c: canonical slug }`：站点给的 m3u8 带时效，所以 `ref` 里只存
 * "去哪一页取"，地址每次现取，不缓存（缓存地址只会在几小时后变成死链）。
 */
function encodeRef(pluginId, body) {
  return String(pluginId || '') + '/' + Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
}

/** 解一个 ref。认不出就回 null（上层如实报错，不猜）：前缀对得上、解得出 JSON、影片页地址在 */
function decodeRef(pluginId, ref) {
  const s = String(ref || '');
  const want = String(pluginId || '') + '/';
  if (!want || !s.startsWith(want)) return null;
  try {
    const o = JSON.parse(Buffer.from(s.slice(want.length), 'base64url').toString('utf8'));
    if (!o || typeof o !== 'object') return null;
    if (!o.u) return null; // 影片页地址是必须的
    return o;
  } catch {
    return null;
  }
}

module.exports = { encodeRef, decodeRef };