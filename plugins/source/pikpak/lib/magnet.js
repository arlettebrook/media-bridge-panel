'use strict';
/**
 * 磁力站（Sukebei）的搜索与解析。
 *
 * 表格列位照第三方脚本对齐（改了就会静默取错）：
 *   td[1] 名字（最后那个 a 的文字）· td[2] 磁力图标 · td[3] 体积 · td[6] 做种 · td[7] 下载中
 *
 * 插件里没有 DOM，所以像 missav 元数据插件那样用正则按 `<tr>` / `<td>` 切。
 *
 * 两处刻意的口径：
 *   · 关键词里的 `-` 换成空格再搜 —— Sukebei 对连字符匹配不佳；
 *   · 拿到候选后按**分词全包含**过滤（每个词都要在标题里出现），把近似片挡在外面。
 *     这一层不是替面板打分 —— 打分归面板（`match.js`），这里只是「搜索词本身用对」。
 */
const ROW_RE = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
const TD_RE = /<td[^>]*>([\s\S]*?)<\/td>/gi;

const stripSlash = (s) => String(s || '').replace(/\/+$/, '');

/** 搜索页地址（Sukebei 的通用搜索：`f=0` 全部、`c=0_0` 全部类别） */
function searchUrl(base, keyword, page) {
  const b = stripSlash(base) || 'https://sukebei.nyaa.si';
  return `${b}/?f=0&c=0_0&q=${encodeURIComponent(String(keyword || ''))}&p=${Math.max(1, Number(page) || 1)}`;
}

/** 去标签 + 还原常见实体 */
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

const decodeEntities = (s) =>
  String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&#38;/g, '&')
    .replace(/&quot;/g, '"');

/** 归一：只留字母与数字（中日文也算字母），标点与分隔符一律抹掉 */
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/** 体积文本 → 字节数（认不出来回 0，不猜） */
function parseSize(text) {
  const m = String(text || '').match(/([\d.]+)\s*(TiB|GiB|MiB|KiB|TB|GB|MB|KB)/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  const table = {
    TIB: 1024 ** 4,
    TB: 1024 ** 4,
    GIB: 1024 ** 3,
    GB: 1024 ** 3,
    MIB: 1024 ** 2,
    MB: 1024 ** 2,
    KIB: 1024,
    KB: 1024,
  };
  return Number.isFinite(n) ? Math.round(n * (table[unit] || 0)) : 0;
}

/** 字节数 → 短文本（界面与 vod_remarks 用） */
function sizeText(bytes) {
  const n = Number(bytes) || 0;
  if (!n) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i ? v.toFixed(2) : Math.round(v)} ${units[i]}`;
}

/**
 * 从**发布标题**里读源自己标的规格 —— 只认明确写法，读不出就是空（不猜、不推断）。
 *
 * 磁力站的发布标题常写成 `+++ [FHD] SNOS-399 …` / `[H265 1080p] SNOS-399 …`，而种子里的
 * **文件名**（`4k688.com@SNOS-399.mp4`）基本不写规格 —— 面板那套"从集名正则猜一份"的兜底
 * 在这条路上猜不到东西，所以由插件这边补上（契约：知道就给，见 docs/plugin-contract.md 第五节）。
 *
 * 读得出的字段与面板认的那套**同名同值域**：`container` / `width` / `height` / `videoCodec` /
 * `videoProfile` / `videoRange` / `bitDepth` / `frameRate` / `audioCodec` / `channelLayout` /
 * `channels` / `atmos`。`bitRate` 这边**给不出** —— 它要体积配时长，而时长归面板（片长来自元数据）。
 * **读不出的键不出现** —— 面板照旧拿文件名兜底；填 `0` / 空串反而会把兜底挡掉
 * （契约：`0` / `false` / 空串一律算"没给"）。
 *
 * 分辨率只认明确写法（`FHD` / `1080p` / `720p` / `480p` / `4K` / `UHD` / `2160p` / `8K` / `4320p`）：
 * 裸的 `HD` / `SD` 在不同发布组里含义不一，说了就是猜。
 *
 * `fileName` 给的是种子内**这个文件**的名字，容器只认它（发布标题里的扩展名可能是种子包的）。
 */
function specOf(release, fileName) {
  const s = String(release || '');
  const out = {};

  const ext = /\.(mkv|mp4|avi|ts|m2ts|flv|mov|webm|rmvb)\b/i.exec(String(fileName || ''));
  if (ext) out.container = ext[1].toLowerCase();

  const res = /\b(8K|4320p|4K|UHD|2160p|FHD|1080p|720p|480p)\b/i.exec(s);
  const wh = {
    '8k': [7680, 4320],
    '4320p': [7680, 4320],
    '4k': [3840, 2160],
    uhd: [3840, 2160],
    '2160p': [3840, 2160],
    fhd: [1920, 1080],
    '1080p': [1920, 1080],
    '720p': [1280, 720],
    '480p': [854, 480],
  };
  if (res && wh[res[1].toLowerCase()]) {
    out.width = wh[res[1].toLowerCase()][0];
    out.height = wh[res[1].toLowerCase()][1];
  }

  if (/\b(h\.?\s?265|hevc|x265)\b/i.test(s)) out.videoCodec = 'hevc';
  else if (/\b(h\.?\s?264|avc|x264)\b/i.test(s)) out.videoCodec = 'h264';
  else if (/\bav1\b/i.test(s)) out.videoCodec = 'av1';

  /* 编码档位只认 `Main10` / `High 10` 这两个明确写法（裸的 `main` 太泛，认了就是猜） */
  if (/\bmain\s?10\b/i.test(s)) out.videoProfile = 'Main 10';
  else if (/\bhigh\s?10\b/i.test(s)) out.videoProfile = 'High 10';

  /* 动态范围：Dolby Vision > HDR10+ > HDR10 > HDR > HLG —— 与面板 parseEpisodeMeta 同一口径 */
  if (/\b(dv|dovi|dolby\s*vision)\b/i.test(s)) out.videoRange = 'DOVI';
  else if (/\bhdr10\s*\+|\bhdr10plus\b/i.test(s)) out.videoRange = 'HDR10+';
  else if (/\bhdr10\b/i.test(s)) out.videoRange = 'HDR10';
  else if (/\bhdr\b/i.test(s)) out.videoRange = 'HDR';
  else if (/\bhlg\b/i.test(s)) out.videoRange = 'HLG';

  const bits = /\b(\d{1,2})\s*-?\s?bit\b/i.exec(s);
  if (bits) out.bitDepth = Number(bits[1]);

  /* 帧率只认带单位的写法；裸的数字太容易误伤 */
  const fps = /\b(\d{2,3}(?:\.\d+)?)\s*fps\b/i.exec(s);
  if (fps) out.frameRate = Number(fps[1]);

  /* `DDP5.1` 这种写法里 `ddp` 后面紧跟数字，`\b` 匹配不到 → 必须用前瞻 */
  if (/\b(eac3|e-ac-3|dd\+|ddp)(?=[.\d\s]|$)/i.test(s)) out.audioCodec = 'eac3';
  else if (/\b(truehd|dts-?hd)\b/i.test(s)) out.audioCodec = 'truehd';
  else if (/\bdts\b/i.test(s)) out.audioCodec = 'dts';
  else if (/\bac3\b/i.test(s)) out.audioCodec = 'ac3';
  else if (/\baac\b/i.test(s)) out.audioCodec = 'aac';
  else if (/\bflac\b/i.test(s)) out.audioCodec = 'flac';

  const ch = /([1-8]\.[0-9])(?=[.\s\])\-]|$)/.exec(s);
  if (ch) {
    out.channelLayout = ch[1];
    const parts = ch[1].split('.');
    out.channels = Number(parts[0]) + (parts[1] === '1' ? 1 : 0);
  }
  if (/\batmos\b/i.test(s)) out.atmos = true;

  return out;
}

/** 从搜索词里揪番号（`ABC-123` / `ABC_123` 这类）；揪不到回空串 */
function extractCode(wd) {
  const m = String(wd || '').match(/[A-Za-z]{2,12}[-_]\d{2,7}/);
  return m ? m[0].toUpperCase().replace(/_/g, '-') : '';
}

/**
 * 磁力里的 info hash（`xt=urn:btih:` 后面那段）—— **一条磁力的唯一身份**。
 *
 * 存在的理由：同一个番号下挂着好几条不同清晰度的种子（1080p / 720p / …），
 * 它们**种子内的根目录名往往一模一样**（都叫 `DLDSS-559`）。
 * 离线下载的保存目录又是按"根目录名"建的同名文件夹 —— 拿根目录名去认"这是不是同一份资源"，
 * 几条不同清晰度就会互相串到同一个文件夹里（实测：点 720p 播出来的其实是 1080p 那个文件）。
 * 所以凡是"这是不是同一条磁力"的判据，一律用这里的 info hash，不用根目录名。
 *
 * btih 有两种写法：40 位 hex，或 32 位 base32；认不出回空串（调用方按"没有身份"处理）。
 */
function btihOf(link) {
  const m = /[?&]xt=urn:btih:([0-9a-fA-F]{40}|[2-7A-Za-z]{32})/i.exec(String(link || ''));
  return m ? m[1].toLowerCase() : '';
}

/** 分词：按空白切（搜索前已经把 `-` 换成了空格） */
function tokensOf(keyword) {
  return String(keyword || '')
    .split(/\s+/)
    .map((x) => norm(x))
    .filter(Boolean);
}

/** 一个 `<tr>` 里的所有 `<td>` 内容 */
function cellsOf(rowHtml) {
  const out = [];
  TD_RE.lastIndex = 0;
  let m;
  while ((m = TD_RE.exec(rowHtml))) out.push(m[1]);
  return out;
}

/**
 * 搜索页 → 磁力条目数组。
 * 一条要同时有标题与磁力链接才算数（少了磁力就没有下游，如实丢掉）。
 */
function parseRows(html) {
  const out = [];
  const seen = new Set();
  ROW_RE.lastIndex = 0;
  let m;
  while ((m = ROW_RE.exec(String(html || '')))) {
    const tds = cellsOf(m[1]);
    if (tds.length < 7) continue;

    const nameCell = tds[1] || '';
    const linkCell = tds[2] || '';
    /* 标题链接里那个 `/view/<id>` 是种子的编号 —— 拿它就能取到 `.torrent`（文件清单的来源），
     * 所以连 href 一起留下，别只取文字。 */
    const titleLink = /<a[^>]+href="([^"]*\/view\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(nameCell);
    const viewId = titleLink ? (/\/view\/(\d+)/.exec(titleLink[1]) || [])[1] || '' : '';
    const title = stripTags(titleLink ? titleLink[2] : nameCell);
    if (!title) continue;

    const magnetHit =
      /href="(magnet:[^"]*)"/i.exec(nameCell) || /href="(magnet:[^"]*)"/i.exec(linkCell);
    if (!magnetHit) continue;
    const magnet = decodeEntities(magnetHit[1]);
    if (seen.has(magnet)) continue;
    seen.add(magnet);

    const sizeRaw = stripTags(tds[3]);
    const seeders = parseInt(stripTags(tds[6]), 10) || 0;
    const leechers = parseInt(stripTags(tds[7]), 10) || 0;
    out.push({
      title,
      magnet,
      torrentId: viewId,
      size: parseSize(sizeRaw),
      sizeText: sizeRaw,
      seeders,
      leechers,
    });
  }
  return out;
}

/** 分词全包含过滤（搜索词里的每个词都要在标题里出现） */
function filterByTokens(items, keyword) {
  const tokens = tokensOf(keyword);
  if (!tokens.length) return items;
  return items.filter((x) => {
    const t = norm(x.title);
    return tokens.every((k) => t.includes(k));
  });
}

/**
 * 排序：先看标题与搜索词像不像，再看做种数、体积、清晰度标注。
 * 面板自己有跨来源的打分，这里只负责把「这一站里最像的那条」排前面。
 */
function rank(items, keyword) {
  const want = norm(keyword);
  const scoreOf = (x) => {
    const t = norm(x.title);
    let s = 0;
    if (want && t === want) s += 100;
    else if (want && t.includes(want)) s += 40;
    s += Math.min(Number(x.seeders) || 0, 50);
    s += Math.min((Number(x.size) || 0) / 1024 ** 3, 30);
    if (/2160p|4k|uhd/i.test(x.title)) s += 50;
    else if (/1080p|fhd/i.test(x.title)) s += 30;
    return s;
  };
  return items.slice().sort((a, b) => scoreOf(b) - scoreOf(a));
}

module.exports = {
  searchUrl,
  parseRows,
  filterByTokens,
  rank,
  extractCode,
  btihOf,
  specOf,
  tokensOf,
  norm,
  parseSize,
  sizeText,
  stripTags,
};