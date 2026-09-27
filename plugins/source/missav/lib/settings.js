'use strict';
/**
 * 插件自己的设置（声明归插件、存储也归插件，面板不读也不写这个文件）。
 *
 *   data/settings.json
 *     siteBase          站点基地址 —— 换镜像（域名变了、路径里的 dm<数字> 前缀变了）只改这一处
 *     coverBase         封面基地址（拼法 `<基地址>/<slug>/cover-t.jpg`）
 *     lang              路径里的语言段（片源页是 `/cn/<slug>`）
 *     cacheTtlMinutes   插件自己那份缓存的有效期（分钟；0 = 不缓存）
 *     cacheMaxMB        缓存字节上限（MB；0 = 不限）
 *
 * 数据目录由宿主通过 ctx.dataDir 给出（每个插件一份独立目录），所以这里不写死路径：
 * 入口先把目录登记进来，本模块与 cache.js 再按它定位。未登记时回落到插件包旁的 `data/`，
 * 手抄一份目录直接跑也能用。
 *
 * 「空串」的语义：**没填 = 用默认地址**（不是"填错了"），因此 read() 回的一律是可用的值，
 * 调用方不必到处兜底。
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_SITE_BASE = 'https://missav.fans';
const DEFAULT_COVER_BASE = 'https://fourhoi.mrstcdn.store';
const DEFAULT_LANG = 'cn';
const DEFAULT_CACHE_TTL_MINUTES = 5;
const DEFAULT_CACHE_MAX_MB = 64;

let dataDir = path.join(__dirname, '..', 'data');

/** 入口登记数据目录（只在动作入口调一次；空值不覆盖，免得把目录改没） */
function setDataDir(dir) {
  const s = String(dir || '').trim();
  if (s) dataDir = s;
}
function dataDirOf() {
  return dataDir;
}
function fileOf() {
  return path.join(dataDir, 'settings.json');
}

const stripSlash = (s) => String(s || '').replace(/\/+$/, '');
const pick = (v) => (v === undefined || v === null ? '' : String(v).trim());
/** 不小于 0 的数字（0 是有意义的值 —— 不缓存 / 不限，不能用 `|| 默认值` 把它吃掉） */
const num = (v, dft) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : dft);

function defaults() {
  return {
    siteBase: DEFAULT_SITE_BASE,
    coverBase: DEFAULT_COVER_BASE,
    lang: DEFAULT_LANG,
    cacheTtlMinutes: DEFAULT_CACHE_TTL_MINUTES,
    cacheMaxMB: DEFAULT_CACHE_MAX_MB,
  };
}

/** 盘上那份原样（不合并默认值）—— 判"某个键有没有被写过"只能看它 */
function raw() {
  try {
    const v = JSON.parse(fs.readFileSync(fileOf(), 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    /* 第一次跑 / 文件被删 / 写坏了 —— 都按默认值起步（不猜、不"修复"） */
    return {};
  }
}

function normalize(cfg) {
  const r = cfg || {};
  return {
    siteBase: stripSlash(pick(r.siteBase)) || DEFAULT_SITE_BASE,
    coverBase: stripSlash(pick(r.coverBase)) || DEFAULT_COVER_BASE,
    lang: pick(r.lang) || DEFAULT_LANG,
    cacheTtlMinutes: num(r.cacheTtlMinutes, DEFAULT_CACHE_TTL_MINUTES),
    cacheMaxMB: num(r.cacheMaxMB, DEFAULT_CACHE_MAX_MB),
  };
}

function read() {
  return normalize(raw());
}

function write(cfg) {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = fileOf() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(normalize(cfg), null, 2));
  fs.renameSync(tmp, fileOf());
}

/** 站点那三项（基地址 / 封面基地址 / 语言段）—— 整份替换，只留认识的键 */
function setSite(patch) {
  const cfg = read();
  const b = patch || {};
  for (const k of ['siteBase', 'coverBase']) {
    if (b[k] !== undefined) cfg[k] = stripSlash(pick(b[k])) || (k === 'siteBase' ? DEFAULT_SITE_BASE : DEFAULT_COVER_BASE);
  }
  if (b.lang !== undefined) cfg.lang = pick(b.lang) || DEFAULT_LANG;
  write(cfg);
  return read();
}

/** 缓存的两个旋钮（有效期分钟 + 上限 MB）—— 0 分别表示"不缓存"与"不限" */
function cacheCfg() {
  const s = read();
  return { ttlMinutes: s.cacheTtlMinutes, maxMB: s.cacheMaxMB };
}

function setCache(patch) {
  const cfg = read();
  if (patch && patch.cacheTtlMinutes !== undefined) {
    const n = Number(patch.cacheTtlMinutes);
    if (!Number.isFinite(n) || n < 0) throw new Error('缓存有效期取值不小于 0 分钟（0 = 不缓存）');
    cfg.cacheTtlMinutes = n;
  }
  if (patch && patch.cacheMaxMB !== undefined) {
    const n = Number(patch.cacheMaxMB);
    if (!Number.isFinite(n) || n < 0) throw new Error('缓存上限取值不小于 0 MB（0 = 不限）');
    cfg.cacheMaxMB = n;
  }
  write(cfg);
  return cacheCfg();
}

/**
 * 合并「已保存设置」与「界面上还没保存的当前值」（自检按钮用）：
 * body 里带了这个键就算数（空串 = 用默认地址），没带就回落已保存值。
 */
function effective(body, saved) {
  const b = body || {};
  const s = saved || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k) && b[k] !== undefined && b[k] !== null;
  return {
    siteBase: stripSlash(pick(has('siteBase') ? b.siteBase : s.siteBase)) || DEFAULT_SITE_BASE,
    coverBase: stripSlash(pick(has('coverBase') ? b.coverBase : s.coverBase)) || DEFAULT_COVER_BASE,
    lang: pick(has('lang') ? b.lang : s.lang) || DEFAULT_LANG,
  };
}

module.exports = {
  DEFAULT_SITE_BASE,
  DEFAULT_COVER_BASE,
  DEFAULT_LANG,
  setDataDir,
  dataDirOf,
  fileOf,
  defaults,
  raw,
  read,
  write,
  setSite,
  cacheCfg,
  setCache,
  effective,
  stripSlash,
};