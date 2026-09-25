'use strict';
/**
 * 「取播放项」那一半：把一站的 `/detail` 响应解析成**面板能直接用**的结构 ——
 * 「线路 → 选集」+ 每条线路这一集（或每个压制版本）的**播放项**，每项带一个 `ref`。
 *
 * ## `ref` 是什么
 * 面板**不解释**它，只原样存进 `MediaSourceId`、播放时再原样交回来（契约第八节：
 * "`ref` 由插件自己编、插件自己管"）。形状约定只有一层：
 *
 *     <插件 id>/<插件自己定的东西>
 *
 * 面板只按**第一段**路由（该找哪个插件），其余一律不懂。本插件的内容是
 * base64url 的 JSON：`{s:实例, t:站点, f:线路, v:条目 id, i:第几项, e:集 id, se:季, ep:集}`
 *   · `e` 是**这一项现在的集 id** —— 它是源给的时效 token，所以先拿它直接要地址（快路径）；
 *   · `v` + `se`/`ep`（或 `i`）是**定位坐标** —— `e` 过期时用它重新取一次详情、重新定位，
 *     再要一次地址（与面板原来那份"播放快路径备忘 + 落回详情"是同一套口径，见 emby 那段的注释）。
 *
 * 为什么要把集 id 也编进去：面板原来在服务端记了一份"条目 + 线路 + 条目 id → 集 id"的备忘
 * （省掉播放前那次详情）。既然 `ref` 就是插件自己的东西，把它编进去最省事，面板也不必再记。
 */

const { parseLines, locateEpisode } = require('./lines');

/** ref 的形状：`<插件 id>/<base64url(JSON)>` */
function encodeRef(pluginId, body) {
  const json = JSON.stringify(body);
  return String(pluginId || '') + '/' + Buffer.from(json, 'utf8').toString('base64url');
}

/**
 * 解一个 ref。**认不出就回 null**（上层如实报错，不猜）。
 * 只认真实形状：前缀对得上、第一段等于本插件 id、后面解得出 JSON。
 */
function decodeRef(pluginId, ref) {
  const s = String(ref || '');
  const want = String(pluginId || '') + '/';
  if (!want || !s.startsWith(want)) return null;
  try {
    const o = JSON.parse(Buffer.from(s.slice(want.length), 'base64url').toString('utf8'));
    if (!o || typeof o !== 'object') return null;
    if (!o.t) return null; // 站点 key 必须在
    return o;
  } catch {
    return null;
  }
}

/**
 * 解析一份 `/detail` 响应。
 *
 * @param json     站源回的原样响应体
 * @param opts     `{pluginId, instanceId, siteKey, vodId, season, episode, pick}`
 *                 `pick = 'items'` = 电影取法（每条线路的**每个播放项**各算一个可播目标）；
 *                 缺省 = 剧集取法（按季集号定位**这一集**）。
 * @returns `{ detail, note }` —— `detail` 为 null 时 `note` 说明为什么（**如实**：`msearch:` 那种
 *          跳搜索的条目本来就取不到详情，那不是失败）。
 */
function buildDetail(json, opts) {
  const { pluginId, instanceId, siteKey, vodId, season, episode, pick } = opts;
  const it = ((json && json.list) || [])[0];
  if (!it) {
    return { detail: null, note: '站源 detail 返回空（`msearch:` 这类跳搜索的 id 本来就没有详情）' };
  }
  const lines = parseLines(it.vod_play_from, it.vod_play_url);
  const detail = {
    vodId: String(it.vod_id || vodId || ''),
    name: String(it.vod_name || ''),
    year: String(it.vod_year || ''),
    area: String(it.vod_area || ''),
    pic: String(it.vod_pic || ''),
    content: String(it.vod_content || ''),
    remarks: String(it.vod_remarks || ''),
    lines,
    lineCount: lines.length,
  };
  const refOf = (flag, extra) =>
    encodeRef(pluginId, Object.assign({ s: instanceId, t: siteKey, f: flag, v: detail.vodId }, extra));

  if (pick === 'items') {
    /* ---- 电影取法：**每条线路的每个播放项**都是一个可播目标 ----
     * 为什么不能借季集号定位：电影文件名里没有集号（只有 `[5.0GB]` / `2026` / `1080p` / `X265` 这类规格），
     * 而定位的三条路全是"按集名里的集号匹配" —— 实测 20 部电影里 19 部一条都定位不到，
     * 客户端版本列表恒为 0 条。电影在协议里本来就是「一条线路 + 若干播放项」，
     * 取每一项都是**确定的**（不是猜），所以这里全列出来，由客户端自己挑压制版本。
     * `line.target` 仍保留 = 第 1 项：诊断字段与既有消费方都不用改。 */
    let empty = 0;
    for (const line of lines) {
      const items = (line.episodes || []).map((ep, i) =>
        Object.assign({ flag: line.flag, name: ep.name, id: ep.id, index: ep.index, matchedBy: 'item' }, {
          ref: refOf(line.flag, { i, e: ep.id }),
        })
      );
      if (!items.length) {
        empty += 1;
        continue;
      }
      line.items = items;
      line.target = items[0];
    }
    detail.pick = 'items';
    detail.target = (lines.find((l) => l.target) || {}).target || null;
    if (empty) detail.targetNote = `${empty} 条线路里没有播放项（源里那几条是空壳）`;
    return { detail, note: '' };
  }

  /* ---- 剧集取法：按季集号在每条线路里各定位一次（不同线路的集名/顺序可能不同）---- */
  if (episode !== undefined && episode !== null && episode !== '') {
    const wantEp = Number(episode);
    const wantSe = season === undefined || season === null || season === '' ? null : Number(season);
    const targets = lines.map((line) => {
      const t = locateEpisode([line], wantSe, wantEp);
      if (!t) return null;
      const body = { e: t.id };
      if (wantSe !== null) body.se = wantSe;
      body.ep = wantEp;
      return Object.assign(t, { episode: wantEp }, wantSe === null ? {} : { season: wantSe }, {
        ref: refOf(line.flag, body),
      });
    });
    lines.forEach((line, i) => {
      if (targets[i]) line.target = targets[i];
    });
    const first = targets.findIndex(Boolean);
    detail.target = first >= 0 ? targets[first] : null;
    if (first < 0) {
      detail.targetNote =
        `线路里定位不到 ${wantSe !== null ? 'S' + wantSe : ''}E${wantEp}` +
        '（集名里找不到这个集号，或第 1 季的序号不对）';
    } else if (targets.some((t) => !t)) {
      detail.targetNote = `${targets.filter((t) => !t).length} 条线路里没定位到这一集（各自的 target 为空）`;
    }
  }
  return { detail, note: '' };
}

module.exports = { encodeRef, decodeRef, buildDetail };
