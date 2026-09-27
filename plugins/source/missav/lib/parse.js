'use strict';
/**
 * MissAV 页面解析（照第三方脚本那份搬过来，只把 HTML 选择器换成正则 —— 插件里没有 DOM）。
 *
 * 三块：
 *   · slug / 番号归一 —— 跨三个插件一致的契约（见实施方案第二节），条目对齐全靠它
 *   · 列表页 → 候选 —— 搜索页与分类页共用同一套筛选（href 命中 `/cn/<slug>` 且带 img）
 *   · 影片页 → m3u8 —— 优先 surrit 主机的 playlist，退化到任意 m3u8，再退化到「找 UUID 拼地址」
 *
 * 正则与归一规则是"站点长什么样"的知识，改了就会静默取错，所以与第三方脚本逐条对齐。
 */
const { UA } = require('./fetch');

/** 列表项链接：`/cn/<slug>`，slug 可带 `-uncensored-leak` 后缀 */
const ITEM_HREF_RE = /\/cn\/[a-zA-Z0-9\-]+(-uncensored-leak)?$/;
/** 标题里已经带了番号就不要重复前缀 */
const HAS_CODE_RE = /[A-Z]+-\d+/;

/* ------------------------------------------------------------- slug / 番号 */

/**
 * 取 `/cn/` 之后最后一段（剥掉 query、hash 与末尾斜杠），再去掉 `-uncensored-leak` 后缀。
 * 无码版与普通版是同一个条目，所以后缀必须去掉 —— 否则三个插件各算出一个编号，对不上。
 */
function canonicalSlug(hrefOrSlug) {
  const raw = String(hrefOrSlug || '').trim().split('#')[0].split('?')[0];
  const m = /\/cn\/([^/]+?)\/?$/.exec(raw);
  let seg = m ? m[1] : raw.replace(/\/+$/, '').split('/').pop() || '';
  seg = seg.replace(/\/+$/, '');
  return seg.replace(/-uncensored-leak$/i, '');
}

/** 番号：slug 大写后去掉中文字幕 / 无码后缀（照第三方脚本） */
function videoCode(slug) {
  return String(slug || '').toUpperCase().replace('-CHINESE-SUBTITLE', '').replace('-UNCENSORED-LEAK', '');
}

/* ------------------------------------------------------------- 地址拼装 */

const stripSlash = (s) => String(s || '').replace(/\/+$/, '');

/** 影片页地址：`<站点基地址>/<语言段>/<slug>` */
function pageUrl(siteBase, lang, slug) {
  return `${stripSlash(siteBase)}/${String(lang || 'cn')}/${String(slug || '')}`;
}

/** 搜索页地址：`<站点基地址>/<语言段>/search/<关键词>?sort=&page=`（只有 page > 1 才带分页） */
function searchUrl(siteBase, lang, wd, page, sort) {
  const base = `${stripSlash(siteBase)}/${String(lang || 'cn')}/search/${encodeURIComponent(String(wd || ''))}`;
  const q = [];
  if (sort) q.push('sort=' + encodeURIComponent(String(sort)));
  if (Number(page) > 1) q.push('page=' + Number(page));
  return q.length ? base + '?' + q.join('&') : base;
}

/** 封面地址：`<封面基地址>/<slug>/cover-t.jpg` */
function coverUrl(coverBase, slug) {
  return `${stripSlash(coverBase)}/${String(slug || '')}/cover-t.jpg`;
}

/* ------------------------------------------------------------- HTML 小工具 */

/** 去标签并还原常见实体（标题、简介这类文本字段用） */
function stripTags(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 属性值 regex 按名字缓存（列表页要扫成百上千个 a，逐个 new RegExp 太费） */
const attrReCache = new Map();

/** 从一段标签属性文本里取某个属性的值；没有就回空串 */
function attrOf(attrs, name) {
  const key = String(name || '').toLowerCase();
  if (!key) return '';
  let re = attrReCache.get(key);
  if (!re) {
    re = new RegExp(
      '(?:^|[\\s"\\\'])' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))',
      'i'
    );
    attrReCache.set(key, re);
  }
  const m = re.exec(String(attrs || ''));
  if (!m) return '';
  return m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3] || '';
}

/**
 * 链接自己的文字都没给出标题时，看看紧随其后的标题节点（站点把 h3/.title 放在链接旁边）。
 * 只在链接之后的一小段里找，避免把下一条目的标题抓过来。
 */
function titleAfterAnchor(html, from) {
  const tail = String(html || '').slice(from, from + 600);
  const m = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>|<[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/[a-zA-Z0-9]+>/i.exec(tail);
  if (!m) return '';
  return stripTags(m[1] !== undefined ? m[1] : m[2]);
}

/* ------------------------------------------------------------- 列表页 → 候选 */

/**
 * 列表页 → 候选数组。筛选与取字段照第三方脚本：
 *   · href 命中 `/cn/<slug>`（可带 `-uncensored-leak`）**且**链接里有 `<img>` 才算一条
 *   · 图取 `data-src || src`；标题取 `a[title] || img[alt] || 后面的标题节点 || 链接文字`
 *   · 标题里没有 `[A-Z]+-\d+` 时前缀番号（面板要按名字打分，番号在最前面最容易命中）
 * 一条都没命中就回空数组 —— 搜不到就是搜不到，不编占位条目。
 */
function parseVideoList(html, { siteBase, coverBase } = {}) {
  const out = [];
  const seen = new Set();
  const s = String(html || '');
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(s))) {
    const attrs = m[1];
    const inner = m[2];
    const href = attrOf(attrs, 'href');
    if (!ITEM_HREF_RE.test(href)) continue;
    const img = /<img\b([^>]*)>/i.exec(inner);
    if (!img) continue;
    const imgAttrs = img[1];
    const imgSrc = attrOf(imgAttrs, 'data-src') || attrOf(imgAttrs, 'src');
    if (!imgSrc) continue;
    const slug = canonicalSlug(href);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);

    let title = attrOf(attrs, 'title') || attrOf(imgAttrs, 'alt');
    if (!title) title = titleAfterAnchor(s, re.lastIndex);
    if (!title) title = stripTags(inner);

    const code = videoCode(slug);
    if (title && !HAS_CODE_RE.test(title)) title = `${code} ${title}`;
    else if (!title) title = code;

    out.push({
      slug,
      code,
      name: title,
      pic: coverUrl(coverBase, slug),
      link: /^https?:\/\//i.test(href) ? href : stripSlash(siteBase) + href,
    });
  }
  return out;
}

/* ------------------------------------------------------------- 影片页 → m3u8 */

/**
 * 归一成**可播的那条** playlist：
 *   · 带 query 的 `/playlist.m3u8?x` 原样保留（query 是时效签名，删了就播不了）
 *   · `/(360p|480p|1080p)/video.m3u8` 归一成 `/playlist.m3u8`
 * 归一的方向固定是「变体 playlist（720p，音视频混流）」—— 主 playlist 在系统播放器里常静音。
 */
function normalizePlayableM3u8(url) {
  if (!url) return '';
  let clean = String(url).replace(/\\+/g, '').replace(/['"]/g, '');
  clean = clean.replace(/\/playlist\.m3u8(\?.*)?$/i, '/playlist.m3u8$1');
  clean = clean.replace(/\/(?:360p|480p|1080p)\/video\.m3u8/i, '/playlist.m3u8');
  return clean;
}

/**
 * 从整页 HTML（含内联脚本，正则一样扫得到）里提 m3u8，三级退化：
 *   ① surrit 主机的 `<uuid>/…playlist.m3u8` —— 站点现行的写法
 *   ② 任意含 surrit 的 `<uuid>/….m3u8`
 *   ③ 只找到 UUID → 拼 `https://surrit.mrstcdn.store/<uuid>/playlist.m3u8`
 * 都找不到回空串（上层如实报"没找到"，不编地址）。
 */
function extractM3u8(html) {
  const s = String(html || '');
  const main = s.match(
    /https?:\/\/(?:surrit(?:\.mrstcdn)?\.(?:com|store)|[^"'\s]*surrit[^"'\s]*)\/[a-f0-9\-]+\/[^"'\s]*playlist\.m3u8/gi
  );
  if (main && main.length) return normalizePlayableM3u8(main[0]);

  const any = s.match(/https?:\/\/[^"'\s]*surrit[^"'\s]*\/[a-f0-9\-]+\/[^"'\s]*\.m3u8/gi);
  if (any && any.length) return normalizePlayableM3u8(any[0]);

  const uuid = s.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g);
  if (uuid && uuid.length) return `https://surrit.mrstcdn.store/${uuid[0]}/playlist.m3u8`;
  return '';
}

/** 去掉标题尾部站点名（` - MissAV` / ` | MissAV` 这类）—— 面板拿它按名字打分，站点名是噪声 */
function cleanTitle(t) {
  return stripTags(t).replace(/\s*[-|]\s*MissAV.*$/i, '').trim();
}

/** 影片页标题：og:title → h1 → `<title>` */
function pageTitle(html) {
  const s = String(html || '');
  const metas = s.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of metas) {
    if (/property\s*=\s*["']og:title["']/i.test(tag)) {
      const c = cleanTitle(attrOf(tag, 'content'));
      if (c) return c;
    }
  }
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(s);
  if (h1) {
    const t = cleanTitle(h1[1]);
    if (t) return t;
  }
  const ti = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(s);
  if (ti) return cleanTitle(ti[1]);
  return '';
}

/**
 * 影片页 → `{ slug, code, name, pic, m3u8, pageLink }`。
 * 标题没有番号时前缀番号（与列表页同一口径，面板按名字打分才认得出来）。
 * 拿不到 m3u8 就如实回空串 —— 上层据此如实说明"没有可播地址"，不编地址。
 */
function parseDetail(html, { siteBase, coverBase, lang, slug } = {}) {
  const title = pageTitle(html);
  const code = videoCode(slug);
  let name = title;
  if (name && !HAS_CODE_RE.test(name)) name = `${code} ${name}`;
  if (!name) name = code;
  return {
    slug,
    code,
    name,
    pic: coverUrl(coverBase, slug),
    m3u8: extractM3u8(html),
    pageLink: pageUrl(siteBase, lang, slug),
  };
}

/** 播放请求头：Referer 指回影片页，Origin 是站点基地址（照第三方脚本） */
function buildStreamHeaders(siteBase, pageLink) {
  return {
    Referer: String(pageLink || '') || stripSlash(siteBase) + '/',
    Origin: stripSlash(siteBase),
    'User-Agent': UA,
    Accept: '*/*',
  };
}

/* ------------------------------------------------------------- 主 playlist → 规格 */

/**
 * 主 playlist（`playlist.m3u8`）→ 变体清单。
 * 站点给的是**主 playlist**：一个变体两行 —— `#EXT-X-STREAM-INF:BANDWIDTH=…,RESOLUTION=WxH,…`
 * 加下一行的媒体 playlist 地址。读不出的项留 0（整份读不出就是空数组，不编）。
 * `CODECS` / `AVERAGE-BANDWIDTH` / `FRAME-RATE` 只有部分片源才写，照实缺省。
 */
function parseMasterPlaylist(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const head = /^#EXT-X-STREAM-INF:(.*)$/i.exec(lines[i].trim());
    if (!head) continue;
    const next = String(lines[i + 1] || '').trim();
    if (!next || next.startsWith('#')) continue;
    const a = head[1];
    const band = /\bBANDWIDTH=(\d+)/i.exec(a);
    const avg = /\bAVERAGE-BANDWIDTH=(\d+)/i.exec(a);
    const res = /\bRESOLUTION=(\d+)x(\d+)/i.exec(a);
    const codecs = /\bCODECS="([^"]*)"/i.exec(a);
    const fps = /\bFRAME-RATE=([\d.]+)/i.exec(a);
    out.push({
      url: next,
      bandwidth: band ? Number(band[1]) : 0,
      averageBandwidth: avg ? Number(avg[1]) : 0,
      width: res ? Number(res[1]) : 0,
      height: res ? Number(res[2]) : 0,
      frameRate: fps ? Number(fps[1]) : 0,
      codecs: codecs ? codecs[1] : '',
    });
  }
  return out;
}

/** 变体档位：分辨率优先，其次码率（用来挑「最高档」） */
const variantRank = (v) => (v.height || 0) * 1e12 + (v.width || 0) * 1e6 + (v.averageBandwidth || v.bandwidth || 0);

/**
 * RFC 6381 的 `CODECS` 串 → 面板认的那几个值。
 *   · `avc1.64001f` → 视频 `h264`；头两个十六进制位是 profile_idc（`64` High / `4d` Main / `42` Baseline）
 *   · `hvc1.*` / `hev1.*` → `hevc`（档位不读：那一段的写法不止一种，读错不如不读）
 *   · `av01.*` → `av1`；`mp4a.40.*` → `aac`
 * 认不出的编码**不给**（不填占位值）。
 */
function codecSpec(codecs) {
  const s = String(codecs || '');
  const out = {};
  const v = /\b(avc1|avc3|hvc1|hev1|av01)\.([0-9a-f]+)/i.exec(s);
  if (v) {
    const kind = v[1].toLowerCase();
    if (kind === 'avc1' || kind === 'avc3') {
      out.videoCodec = 'h264';
      const pp = v[2].slice(0, 2).toLowerCase();
      const flag = v[2].slice(2, 4).toLowerCase();
      if (pp === '64') out.videoProfile = 'High';
      else if (pp === '4d') out.videoProfile = 'Main';
      /* `42` 带 `E0` 是 Constrained Baseline（`42E01E`），不带才是 Baseline */
      else if (pp === '42') out.videoProfile = flag === 'e0' ? 'Constrained Baseline' : 'Baseline';
    } else if (kind === 'hvc1' || kind === 'hev1') out.videoCodec = 'hevc';
    else out.videoCodec = 'av1';
  }
  if (/\bmp4a\.40\b/i.test(s)) out.audioCodec = 'aac';
  else if (/\bec-3\b/i.test(s)) out.audioCodec = 'eac3';
  else if (/\bac-3\b/i.test(s)) out.audioCodec = 'ac3';
  return out;
}

/**
 * 主 playlist → 播放项的规格字段。
 *
 * 客户端播的是**主 playlist**、由它自己挑档位，所以按**最高档**报（Emby 对 HLS 也是这个口径）。
 * `container` 固定 `hls` —— 这就是 HLS 流，不是猜。体积与声道数主 playlist 里没有，
 * 因此给不出（**不给**，不填 0/空串，免得把面板那套兜底挡掉）。
 */
function playlistSpec(text) {
  const variants = parseMasterPlaylist(text);
  let best = null;
  for (const v of variants) {
    if (!best || variantRank(v) > variantRank(best)) best = v;
  }
  const out = { container: 'hls' };
  if (!best) return out;
  if (best.width && best.height) {
    out.width = best.width;
    out.height = best.height;
  }
  const bw = best.averageBandwidth || best.bandwidth;
  if (bw) out.bitRate = bw;
  if (best.frameRate) out.frameRate = best.frameRate;
  return Object.assign(out, codecSpec(best.codecs));
}

/* ------------------------------------------------------------- 番号判定 */

/** 查询词是不是番号形状（`SSIS-001` / `SSIS001`） */
const isVideoCode = (wd) => /^[A-Za-z]+-?\d+$/i.test(String(wd || '').trim());

/**
 * 从查询词里揪出番号。面板给的词是**元数据那条的名字**（`SSIS-001 女友不在的三天 …`），
 * 不是光秃秃的番号 —— 拿整串去打站点的搜索页一条也搜不到，站点只认番号那一小段。
 * 因此：整串本身就是番号就用它；否则取第一个 `字母-数字` 形状的词（`SSIS-001`）。
 * 都取不到才退回整串（中文片名那类走的就是这条）。
 */
function extractCode(wd) {
  const s = String(wd || '').trim();
  if (!s) return '';
  if (isVideoCode(s)) return s;
  const m = /[A-Za-z]{2,}-\d{2,}/.exec(s);
  return m ? m[0] : '';
}

/** 两边去掉 `-` 后大写比较（`SSIS-001` 与 `ssis001` 视为同一个番号） */
function sameCode(a, b) {
  return String(a || '').toUpperCase().replace(/-/g, '') === String(b || '').toUpperCase().replace(/-/g, '');
}

module.exports = {
  canonicalSlug,
  videoCode,
  pageUrl,
  searchUrl,
  coverUrl,
  stripTags,
  attrOf,
  parseVideoList,
  extractM3u8,
  normalizePlayableM3u8,
  pageTitle,
  parseDetail,
  parseMasterPlaylist,
  codecSpec,
  playlistSpec,
  buildStreamHeaders,
  isVideoCode,
  extractCode,
  sameCode,
};