'use strict';
/**
 * 列表页 → HomeItem（首页插件的解析层）。
 *
 * 这一份是跨插件契约里「列表解析」的重复实现之一（首页 / 元数据 / 片源各持一份），
 * 换来的是插件之间零耦合：任何一份都不 require 另一份、也读不到面板的代码。
 * 筛选与字段取法照搬第三方 Widget 脚本，只把它的 jQuery 层换成本地的正则扫描。
 *
 * 线上实测列表项的形状：
 *   <a href="https://<站点>/cn/<slug>" alt="<番号>">
 *     <video data-src="…/<slug>/preview.mp4"></video>
 *     <img data-src="…/<slug>/cover-t.jpg" src="data:image/png;base64,…" alt="<长标题>">
 *   </a>
 * 一部片在页面里有三条指向同一 href 的链接（缩略图 / 时长 / 标题），**只有缩略图那条含 <img>** ——
 * 因此"含 <img> 的 /cn/<slug> 链接"正好一部片一条，另外两条自然被滤掉。
 */

/** 列表项：`/cn/` 之后最后一段，允许结尾的 `-uncensored-leak` */
const ITEM_HREF_RE = /\/cn\/[a-zA-Z0-9-]+(-uncensored-leak)?$/;
const ANCHOR_RE = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
const IMG_RE = /<img\b([^>]*)>/i;

/** 取标签属性（先双引号后单引号，属性名大小写不敏感） */
function attrOf(attrs, name) {
  const s = attrs || '';
  let m = new RegExp('\\b' + name + '\\s*=\\s*"([^"]*)"', 'i').exec(s);
  if (m) return m[1];
  m = new RegExp("\\b" + name + "\\s*=\\s*'([^']*)'", 'i').exec(s);
  return m ? m[1] : '';
}

/** 常见实体解码（标题里 `&amp;` 之类不还原会带进客户端） */
function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, '&');
}

/** 去标签取文本（回退用的链接文本 / 标题节点都走它） */
function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * 跨插件契约：`canonicalSlug(href 或 slug)` = URL 里 `/cn/` 之后最后一段
 * （剥 query 与末尾 `/`），去掉结尾 `-uncensored-leak` 后缀。
 * 首页条目的 Id 中段、元数据插件的 entryId、片源插件的 vod_id 三处都靠它对齐。
 */
function canonicalSlug(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  s = s.split('#')[0].split('?')[0].replace(/\/+$/, '');
  const m = /\/cn\/([^/]+)$/.exec(s);
  const seg = m ? m[1] : s.split('/').pop();
  return String(seg || '').replace(/-uncensored-leak$/i, '');
}

/**
 * 番号：照 missav.js —— canonical slug 转大写后剥掉中文字幕 / 无码流出的后缀。
 * canonicalSlug 已去掉 `-uncensored-leak`，这里再剥一次是为了对第三方脚本逐字对齐。
 */
function videoCodeOf(slug) {
  return String(slug || '')
    .toUpperCase()
    .replace(/-CHINESE-SUBTITLE/g, '')
    .replace(/-UNCENSORED-LEAK/g, '');
}

/**
 * 标题的兜底：链接所在容器里的 `h1/h2/h3` 或 class 含 `title` 的节点。
 *
 * 第三方脚本走的是 `$link.closest('div')` 再 `find(...)`；没有 DOM 就退回"从链接位置
 * 往回扫一小段 HTML"，取其中最后一个标题节点 —— 命中的是同一张卡片里排在链接前的标题。
 * missav 的缩略图链接自带 `<img alt>`，这一步是给别的版面留的兜底，取不到就回空串。
 */
function titleFromAncestors(html, anchorStart) {
  const WINDOW = 1500;
  const seg = html.slice(Math.max(0, anchorStart - WINDOW), anchorStart);
  const re = /<(h1|h2|h3)\b[^>]*>([\s\S]*?)<\/\1>|<[a-z]+\b[^>]*class\s*=\s*"[^"]*\btitle\b[^"]*"[^>]*>([\s\S]*?)<\/[a-z]+>/gi;
  let out = '';
  let m;
  while ((m = re.exec(seg))) {
    const t = stripTags(m[2] || m[3] || '');
    if (t) out = t;
  }
  return out;
}

/** 末页页码：分页条里 `aria-label="Go to page N"` 的最大值；没有就 0 */
function parseTotalPages(html) {
  const re = /aria-label="Go to page (\d+)"/g;
  let max = 0;
  let m;
  while ((m = re.exec(html))) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

/**
 * 列表页 → HomeItem[]（行内按 id 去重，只留第一条）。缺 id / 标题的条目直接跳过。
 *
 * `poster` 按跨插件约定重建为 `<封面基地址>/<slug>/cover-t.jpg`（与元数据插件算出的地址一致），
 * 不是直接抄 `<img data-src>`；`<img>` 只用来确认这是一条真实影片卡片。
 */
function parseVideoList(html, opts) {
  const imageBase = String((opts && opts.imageBase) || '').replace(/\/+$/, '');
  const items = [];
  const seen = new Set();

  ANCHOR_RE.lastIndex = 0;
  let m;
  while ((m = ANCHOR_RE.exec(html))) {
    const attrs = m[1] || '';
    const inner = m[2] || '';
    const href = attrOf(attrs, 'href');
    if (!href || !ITEM_HREF_RE.test(href)) continue;

    const img = IMG_RE.exec(inner);
    if (!img) continue;
    const imgAttrs = img[1] || '';
    const imgSrc = attrOf(imgAttrs, 'data-src') || attrOf(imgAttrs, 'src');
    if (!imgSrc) continue;

    const slug = canonicalSlug(href);
    if (!slug) continue;
    const id = 'missav_' + slug + '_movie';
    if (seen.has(id)) continue;

    const code = videoCodeOf(slug);
    let title = attrOf(attrs, 'title') || attrOf(imgAttrs, 'alt') || titleFromAncestors(html, m.index) || stripTags(inner);
    title = decodeEntities(title).trim();
    /* 标题里没带番号时前缀上番号 —— 客户端列表里光看图认不出是哪部 */
    if (title && !/[A-Z]+-\d+/.test(title)) title = code + ' ' + title;
    if (!title) title = code;
    if (!title) continue;

    seen.add(id);
    const poster = imageBase ? imageBase + '/' + slug + '/cover-t.jpg' : '';
    items.push({
      id,
      type: 'movie',
      title,
      poster,
      backdrop: poster,
      providerIds: { Missav: slug },
    });
  }

  return items;
}

module.exports = {
  ITEM_HREF_RE,
  canonicalSlug,
  videoCodeOf,
  decodeEntities,
  stripTags,
  parseVideoList,
  parseTotalPages,
};