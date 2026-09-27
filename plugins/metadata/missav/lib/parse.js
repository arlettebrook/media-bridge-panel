'use strict';
/**
 * HTML 解析层：**影片页 → 标题 / 封面 / 简介 / 番号**，**列表页 → 候选条目**。
 *
 * 取数口径照搬第三方 Widget 脚本（`missav.js`），只把 jQuery 选择器换成正则扫描
 * —— 插件是独立包，不引入 DOM 库。站点列表页与影片页的结构简单，正则够用。
 *
 * 归一化字段名是**域中立的**（`entryId` / `type`），与契约第六节一致。
 * **不编数据**：取不到就留空串或空数组。
 */

/** 列表项链接的形状：`/cn/<slug>`，可选带无码后缀 */
const LIST_HREF_RE = /\/cn\/[a-zA-Z0-9\-]+(-uncensored-leak)?$/;

/**
 * **跨插件共享的条目编号**：取 URL 里 `/cn/` 之后最后一段（剥 query 与末尾 `/`），
 * 再去掉结尾的 `-uncensored-leak` 后缀。它同时是：元数据的 `entryId`、片源插件的 `vod_id`、
 * 首页插件条目 Id 的中段 —— 三处各算一份、结果必须一致。
 * 传进来的既可以是整条链接，也可以是裸 slug。
 */
function canonicalSlug(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  const marker = '/cn/';
  const at = s.indexOf(marker);
  if (at >= 0) s = s.slice(at + marker.length);
  s = s.split(/[?#]/)[0].replace(/\/+$/, '');
  s = s.split('/').filter(Boolean).pop() || '';
  /* 同一部片的无码版与普通版是同一个条目 —— 后缀去掉 */
  s = s.replace(/-uncensored-leak$/i, '');
  return s;
}

/** 番号 = 大写，去掉中文字幕 / 无码后缀（照 `missav.js`） */
function videoCode(slug) {
  return String(slug || '')
    .toUpperCase()
    .replace(/-CHINESE-SUBTITLE/g, '')
    .replace(/-UNCENSORED-LEAK/g, '');
}

/** 封面地址：`<封面基地址>/<slug>/cover-t.jpg`（本站没有"基地址 + 相对路径"这一层） */
function imageUrlOf(imageBase, slug) {
  const base = String(imageBase || '').replace(/\/+$/, '');
  return base && slug ? `${base}/${slug}/cover-t.jpg` : '';
}

/** 标题补上番号：标题里已带 `[A-Z]+-\d+` 就不重复，否则前缀上番号 */
function formatTitle(code, title) {
  const t = String(title || '').trim();
  if (!t) return String(code || '');
  if (/[A-Z]+-\d+/i.test(t)) return t;
  return `${code} ${t}`;
}

/* ------------------------------------------------------------ HTML 小工具 */

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s) {
  return String(s || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, ent) => {
    const key = ent.toLowerCase();
    if (key[0] === '#') {
      const n = key[1] === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : m;
  });
}

/** 取标签属性（双引号或单引号） */
function attr(tag, name) {
  const re = new RegExp(name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')', 'i');
  const m = String(tag || '').match(re);
  return m ? decodeEntities(m[2] !== undefined ? m[2] : m[3]) : '';
}

/** 剥标签取文本 */
function textOf(html) {
  return decodeEntities(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** `<meta property|name="..." content="...">` 的 content */
function metaContent(html, name) {
  const re = new RegExp('<meta\\b[^>]*(?:property|name)\\s*=\\s*["\']' + escapeRe(name) + '["\'][^>]*>', 'i');
  const m = String(html || '').match(re);
  return m ? textOf(attr(m[0], 'content')) : '';
}

/** 年份：只认机器可读的日期（JSON-LD 的 datePublished / `<time datetime>`），取不到就留空 */
function yearOf(html) {
  const s = String(html || '');
  const m =
    s.match(/"datePublished"\s*:\s*"(\d{4})/) ||
    s.match(/<time\b[^>]*datetime\s*=\s*["\'](\d{4})-/i) ||
    s.match(/itemprop\s*=\s*["\']datePublished["\'][^>]*content\s*=\s*["\'](\d{4})/i);
  return m ? m[1] : '';
}

/* ---------------------------------------------------------------- 列表页 */

/**
 * 列表页 → 候选条目（照 `missav.js` 的 `parseVideoList`）：
 *   ① 链接 href 匹配 `/cn/<slug>`（可选无码后缀）且链接内**含 `<img>`**；
 *   ② 图取 `data-src || src`，没有图就跳过；
 *   ③ 标题取 `a[title] || img[alt] || 链接内标题节点 || 链接文本`，再补上番号。
 * 同一 slug 只留第一条（一页里可能重复出现）。
 */
function parseList(html, imageBase) {
  const out = [];
  const seen = new Set();
  const anchors = String(html || '').match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) || [];
  for (const block of anchors) {
    const open = block.match(/^<a\b[^>]*>/i);
    if (!open) continue;
    const href = attr(open[0], 'href');
    if (!href || !LIST_HREF_RE.test(href)) continue;
    const img = block.match(/<img\b[^>]*>/i);
    if (!img) continue;
    const src = attr(img[0], 'data-src') || attr(img[0], 'src');
    if (!src) continue;

    const inner = block.replace(/^<a\b[^>]*>/i, '').replace(/<\/a>\s*$/i, '');
    const head = inner.match(/<(h1|h2|h3)\b[^>]*>([\s\S]*?)<\/\1>/i);
    const raw = attr(open[0], 'title') || attr(img[0], 'alt') || (head ? textOf(head[2]) : '') || textOf(inner);

    const slug = canonicalSlug(href);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push({
      entryId: slug,
      type: 'movie',
      title: formatTitle(videoCode(slug), raw),
      posterPath: imageUrlOf(imageBase, slug),
      year: '',
    });
  }
  return out;
}

/* ---------------------------------------------------------------- 影片页 */

/**
 * 影片页 → 条目（标题取 `og:title` → `h1` → `title`，去掉 ` - MissAV` 后缀）。
 * 简介取 `og:description` / `description`；年份只认机器可读日期。
 * 类型 / 演员本站影片页不提供，如实留空。
 */
function parseDetail(html, slug, imageBase) {
  const code = videoCode(slug);
  const h1 = (String(html || '').match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) || [])[1];
  const docTitle = (String(html || '').match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  let title = metaContent(html, 'og:title') || textOf(h1) || textOf(docTitle);
  title = title.replace(/\s*-\s*MissAV.*$/i, '').trim();

  return {
    entryId: slug,
    type: 'movie',
    title: title || code,
    searchTitle: formatTitle(code, title),
    originalTitle: '',
    year: yearOf(html),
    overview: metaContent(html, 'og:description') || metaContent(html, 'description'),
    posterPath: imageUrlOf(imageBase, slug),
    backdropPath: '',
    genres: [],
    cast: [],
  };
}

module.exports = {
  LIST_HREF_RE,
  canonicalSlug,
  videoCode,
  imageUrlOf,
  formatTitle,
  decodeEntities,
  attr,
  textOf,
  metaContent,
  yearOf,
  parseList,
  parseDetail,
};