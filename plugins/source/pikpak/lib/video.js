'use strict';
/**
 * 「PikPak 里的这个资源，哪一个文件才是要播的那个」—— 挑文件的判据。
 *
 * 一个磁力下下来常常是一整个目录（种子里有正片、样本、预告、字幕、图片）；
 * 所以顺序是：**递归收视频文件 → 按标题关键词命中 → 都不中就取最大的那个**。
 * 判据照第三方脚本那份对齐（`pikpakExtractKeywords` / `pikpakScoreFileName` / `pikpakIsSampleFile`）。
 *
 * 这一步与面板的打分不是一回事：面板判的是「这条磁力是不是目标作品」，
 * 这里判的是「这个目录里哪个文件是正片」。
 */
const pikpak = require('./pikpak');

const VIDEO_EXT_RE = /\.(mp4|mkv|avi|mov|wmv|flv|ts|webm|m4v)$/i;
/** 样本 / 预告 / 花絮 —— 这些不是正片 */
const SAMPLE_RE = /\b(sample|preview|trailer|extras?)\b|[.\-_\[\(](sample|preview|trailer|extras?)[.\-_\])]/i;

/** 一个资源最多回几条播放项（整季包会有几十个视频文件，逐个取地址太慢） */
const MAX_ITEMS = 8;
/** 每层最多往下翻几个子目录 */
const MAX_FOLDERS = 20;
/** 递归深度上限（正常种子一层目录，留点余量就够） */
const MAX_DEPTH = 3;
/** 关键词短于这个长度就不拿来做包含匹配（两三个字母会乱命中） */
const MIN_KEYWORD_LEN = 4;

function isVideoFile(name) {
  const s = String(name || '');
  return VIDEO_EXT_RE.test(s) && !SAMPLE_RE.test(s);
}

/**
 * 名字比对用的归一：小写 + 路径分隔符换下划线 + 空白折叠。
 * 种子里的 `a/b.mp4` 落到网盘可能变成一层层目录、也可能被摊平，所以**只比最后那段文件名**；
 * 同一个名字出现在不同目录时不追究，命中一个就算（播放项本来就是按文件挑的）。
 */
function nameKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\\/:]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 从标题里抽关键词：番号形状的整段 + 按分隔符切出来的词，去重 */
function extractKeywords(title) {
  const t = String(title || '');
  const codes = t.match(/[A-Za-z0-9]+[-_][A-Za-z0-9]+(?:\s*[-_]\s*[A-Za-z0-9]+)?/g) || [];
  const words = t.split(/[\s\-_.[\]()（）【】]+/).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const one of codes.concat(words)) {
    const w = String(one).trim();
    if (!w || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

/** 文件名与关键词的像似分（完全相等最高，子串次之，逐字符命中给一点点） */
function scoreFileName(filename, keywords) {
  const list = keywords || [];
  if (!filename || !list.length) return 0;
  const lower = String(filename).toLowerCase();
  let score = 0;
  for (const raw of list) {
    const kw = String(raw).toLowerCase().trim();
    if (!kw) continue;
    if (lower === kw) score += 50;
    else if (lower.includes(kw)) score += kw.length * 3;
    else {
      let hit = 0;
      for (const ch of kw) if (lower.includes(ch)) hit += 1;
      score += hit;
    }
  }
  return score;
}

/** 文件名（去掉扩展名）里是否出现了某个够长的关键词 */
function nameHitsKeyword(name, keywords) {
  const base = String(name || '').replace(VIDEO_EXT_RE, '').toLowerCase();
  return (keywords || []).some((kw) => {
    const k = String(kw).toLowerCase();
    return k.length >= MIN_KEYWORD_LEN && base.includes(k);
  });
}

/** 递归收视频文件（子目录里的也算 —— 种子常把正片放在同名子目录里） */
async function collectVideos(files, keywords, opts, depth = 0) {
  const out = [];
  const folders = [];
  for (const f of files || []) {
    const name = String(f.name || '');
    if (!name) continue;
    if (f.kind === 'drive#folder') {
      folders.push(f);
      continue;
    }
    if (!isVideoFile(name)) continue;
    const id = f.id || f.id_ || '';
    if (!id) continue;
    out.push({ id, name, size: Number(f.size) || 0, score: scoreFileName(name, keywords) });
  }
  if (depth >= MAX_DEPTH) return out;
  for (const folder of folders.slice(0, MAX_FOLDERS)) {
    const id = folder.id || folder.id_ || '';
    if (!id) continue;
    let sub = [];
    try {
      // eslint-disable-next-line no-await-in-loop
      sub = await pikpak.listFiles(id, opts);
    } catch {
      /* 某个子目录读不动不该让整次取数失败 */
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const deeper = await collectVideos(sub, keywords, opts, depth + 1);
    for (const one of deeper) out.push(one);
  }
  return out;
}

/** 关键词命中优先，否则取最大的那个；命中多个时按像似分与体积排 */
function pickVideos(videos, keywords) {
  const all = (videos || []).filter((v) => v && v.id);
  if (!all.length) return [];
  const hit = all.filter((v) => nameHitsKeyword(v.name, keywords));
  if (hit.length) {
    return hit
      .sort((a, b) => b.score - a.score || b.size - a.size)
      .slice(0, MAX_ITEMS);
  }
  return all.sort((a, b) => b.size - a.size).slice(0, 1);
}

/**
 * 一个 PikPak 文件 id → 要播的文件清单。
 * 它是目录就往下收（正常情况），它是单个视频文件就直接算一个。
 */
async function videosOf(fileId, title, opts = {}) {
  const keywords = extractKeywords(title);
  let files = [];
  try {
    files = await pikpak.listFiles(fileId, opts);
  } catch {
    files = [];
  }
  if (files.length) return pickVideos(await collectVideos(files, keywords, opts), keywords);

  const one = await pikpak.getPlayUrl(fileId, opts);
  if (!one) return [];
  return [{ id: fileId, name: one.name || String(title || '') || 'PikPak 视频', size: one.size || 0, score: 0 }];
}

/**
 * 「要播的是**这一个**文件」—— 播放那一刻才用得上（那时才提交离线下载）。
 *
 * 播放项在详情阶段是从 `.torrent` 清单里挑出来的（那会儿还没有网盘文件 id），
 * 所以这里拿当初那个文件名回网盘里对：名字对得上就用它，对不上再退回「挑正片」那套判据。
 * `fileId` 若是单个视频文件（不是目录），列目录会回空，那就直接当它自己。
 */
async function findVideoOf(fileId, wantName, title, opts = {}) {
  const keywords = extractKeywords(title);
  let files = [];
  try {
    files = await pikpak.listFiles(fileId, opts);
  } catch {
    files = [];
  }
  if (!files.length) {
    const one = await pikpak.getPlayUrl(fileId, opts);
    if (!one) return null;
    return { id: fileId, name: one.name || String(wantName || '') || 'PikPak 视频', size: one.size || 0, score: 0 };
  }

  const all = await collectVideos(files, keywords, opts);
  const want = nameKey(wantName);
  if (want) {
    const hit = all.find((v) => nameKey(v.name) === want);
    if (hit) return hit;
  }
  return pickVideos(all, keywords)[0] || null;
}

module.exports = {
  MAX_ITEMS,
  isVideoFile,
  nameKey,
  extractKeywords,
  scoreFileName,
  collectVideos,
  pickVideos,
  videosOf,
  findVideoOf,
};