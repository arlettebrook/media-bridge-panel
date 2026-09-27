'use strict';
/**
 * HTML 解析层：**影片页 → 一整套规范字段**，**列表页 → 候选条目**。
 *
 * 取数口径照搬第三方 Widget 脚本（`missav.js`），只把 jQuery 选择器换成正则扫描
 * —— 插件是独立包，不引入 DOM 库。站点列表页与影片页的结构简单，正则够用。
 *
 * 影片页取**页面上有的每一个字段**（契约第六节那份清单里本站点提供的那些）：
 *   · `<meta>`：og:title / og:description / og:image（大图封面）/ og:video:release_date /
 *     og:video:duration / og:video:actor / og:video:director / keywords
 *   · 信息栏（`<span>标签:</span> 值` 一行一项）：发行日期 / 番号 / 标题（原始日文题）/
 *     女优 / 男优 / 类型 / 发行商 / 导演 / 标籤
 * 归一化字段名是**域中立的**（`entryId` / `type` / `cast` / `crew`…），与契约第六节一致。
 * **不编数据**：取不到就留空串或空数组；本站点没有的字段（评分 / 分级 / 季数…）不申报。
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

/** 同上，但取**全部**同名 `<meta>`（`og:video:actor` / `og:video:director` 会重复出现） */
function metaContents(html, name) {
  const re = new RegExp('<meta\\b[^>]*(?:property|name)\\s*=\\s*["\']' + escapeRe(name) + '["\'][^>]*>', 'gi');
  const s = String(html || '');
  const out = [];
  let m;
  while ((m = re.exec(s))) {
    const v = textOf(attr(m[0], 'content'));
    if (v) out.push(v);
  }
  return out;
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

/* ------------------------------------------------------------ 影片页信息栏 */

/** Emby 的 `PremiereDate` 要完整时间；本站点的 `<time datetime>` 带时区，这里统一成 UTC 零点（照 tmdb） */
const ISO_SUFFIX = 'T00:00:00.0000000Z';

/** `YYYY-MM-DD…` → `YYYY-MM-DDT00:00:00.0000000Z`；取不到日期就回空串 */
function isoDate(d) {
  const m = String(d || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}${ISO_SUFFIX}` : '';
}

/**
 * 影片页的信息栏是「一行一项」：`<div class="…text-secondary"><span>标签:</span> 值</div>`。
 * 按这个类名切开，每段取头一个 `<span>标签:</span>`，值截到本行结束的 `</div>`。
 * 页面上别处也用了同一个类名（面包屑 / 侧栏），但它们的第一段没有「…:」形状的 span，自然不会进来。
 */
function infoRows(html) {
  const out = {};
  for (const chunk of String(html || '').split('missav_fans-text-secondary')) {
    const m = /<span[^>]*>([^<:：]+)[:：]\s*<\/span>([\s\S]*?)(?:<\/div>|$)/.exec(chunk);
    if (!m) continue;
    const label = textOf(m[1]);
    if (!label || Object.prototype.hasOwnProperty.call(out, label)) continue;
    out[label] = m[2];
  }
  return out;
}

/**
 * 一行的链接清单 → `[{ name, id }]`。
 * `id` 取 href 里 `/dm<数字>/` 那段 —— 那是站点自己的分类编号（无码/普通、女优/男优各一套），
 * 拿不到就空串（面板侧对空 id 会当 0，不编一个不存在的编号）。
 */
function linksOf(valueHtml) {
  const out = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  const s = String(valueHtml || '');
  let m;
  while ((m = re.exec(s))) {
    const name = textOf(m[2]);
    if (!name) continue;
    const dm = String(attr(m[1], 'href')).match(/\/dm(\d+)\//i);
    out.push({ name, id: dm ? dm[1] : '' });
  }
  return out;
}

/** 信息栏里那一行的纯文本（标题这类没有链接的字段用） */
const rowText = (valueHtml) => textOf(valueHtml);

/** 信息栏里的日期行 → `<time datetime>`（没有就退回行内文本） */
function infoDate(valueHtml) {
  const s = String(valueHtml || '');
  const m = s.match(/<time\b[^>]*datetime\s*=\s*["']([^"']+)["']/i);
  return m ? textOf(m[1]) : textOf(s);
}

/** `<meta name="keywords" content="a, b, c">` → `['a','b','c']`（逗号分隔，去空） */
function keywordsOf(html) {
  const raw = metaContent(html, 'keywords');
  if (!raw) return [];
  return raw.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
}

/* ---------------------------------------------------------------- 影片页 */

/**
 * 影片页 → 条目。
 * 标题取 `og:title` → `h1` → `title`（去掉 ` - MissAV` 后缀）；原始标题取信息栏的「标题」行
 * （站点给的是日文原题）。发行日期取信息栏 `<time datetime>`，退回 `og:video:release_date`。
 * 封面取 `og:image`（`cover-n.jpg`，比列表页的 `cover-t.jpg` 大），退回按封面基地址拼。
 * 时长取 `og:video:duration`（秒 → 分钟，向下取整）。类型 / 演职 / 发行商 / 标籤从信息栏取。
 * 本站点没有的字段（评分 / 分级 / 季数 / 外部 id / 预告）如实留空，不编。
 */
function parseDetail(html, slug, imageBase) {
  const s = String(html || '');
  const code = videoCode(slug);
  const h1 = (s.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) || [])[1];
  const docTitle = (s.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  let title = metaContent(s, 'og:title') || textOf(h1) || textOf(docTitle);
  title = title.replace(/\s*-\s*MissAV.*$/i, '').trim();

  const rows = infoRows(s);

  /* 演职：优先信息栏（带站点编号），没有就退回 og:video:actor / og:video:director 那份纯名字 */
  const actors = linksOf(rows['女优']).concat(linksOf(rows['男优']));
  const cast = actors.length
    ? actors.map((p) => ({ personId: p.id, name: p.name, role: '' }))
    : metaContents(s, 'og:video:actor').map((name) => ({ name, role: '' }));
  const directorLinks = linksOf(rows['导演']);
  const crew = (directorLinks.length ? directorLinks : metaContents(s, 'og:video:director').map((name) => ({ name, id: '' })))
    .map((p) => ({ personId: p.id, name: p.name, job: 'Director' }));

  /* 类型：信息栏那一串链接的名字；带 id 的那份给客户端「点进类型」用（站点没有 id 的给空串） */
  const genreLinks = linksOf(rows['类型']);
  const genres = genreLinks.map((g) => g.name);
  const genreItems = genreLinks.map((g) => ({ id: g.id, name: g.name }));

  /* 公司：发行商 + 标籤（两者在站点上是不同的分类编号，面板按 id 去重时不会互相吞掉） */
  const productionCompanies = linksOf(rows['发行商'])
    .concat(linksOf(rows['标籤']))
    .map((c) => ({ id: Number(c.id) || 0, name: c.name }));

  const dateRaw = infoDate(rows['发行日期']) || metaContent(s, 'og:video:release_date');
  const premiereDate = isoDate(dateRaw);
  const cover = metaContent(s, 'og:image') || imageUrlOf(imageBase, slug);
  const durationSec = Number(metaContent(s, 'og:video:duration')) || 0;

  return {
    entryId: slug,
    type: 'movie',
    title: title || code,
    searchTitle: formatTitle(code, title),
    originalTitle: rowText(rows['标题']),
    year: premiereDate ? premiereDate.slice(0, 4) : yearOf(s),
    premiereDate,
    overview: metaContent(s, 'og:description') || metaContent(s, 'description'),
    posterPath: cover,
    backdropPath: cover,
    backdropPaths: cover ? [cover] : [],
    genres,
    genreItems,
    runtimeMinutes: durationSec > 0 ? Math.floor(durationSec / 60) : 0,
    cast,
    crew,
    productionCompanies,
    keywords: keywordsOf(s),
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
  metaContents,
  yearOf,
  isoDate,
  infoRows,
  linksOf,
  keywordsOf,
  parseList,
  parseDetail,
};