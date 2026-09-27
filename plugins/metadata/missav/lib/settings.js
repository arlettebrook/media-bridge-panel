'use strict';
/**
 * 插件自己的设置（契约第十一节：**声明归插件、存储也归插件**）。
 *
 *   data/settings.json   站点基地址 / 封面基地址 / 语言段 / 缓存的存活期与上限
 *
 * 面板不读也不写这个文件。这里要申报出去的只有一样：**图片基地址**随「注册」动作报给面板。
 *
 * 「空串」的语义与面板原有一致：**没填 = 用内置默认地址**（不是"错的值"），
 * 于是 `read()` 回的一律是可用的地址，调用方不必到处兜底。
 *
 * ⚠️ 数据目录：面板的宿主（`server/modules/plugin/runner.js`）把 `ctx.dataDir` 定为
 * `<插件目录>/data`，动作层会把它交给 `setDataDir()`，所以设置与缓存都落在那下面。
 * 没被交过时用 `<插件目录>/data` 兜底（手抄一份目录直接跑也能用）。
 */
const fs = require('fs');
const path = require('path');

/** 当前数据目录（面板交过来后覆盖；设置与缓存都相对它） */
let DATA_DIR = path.join(__dirname, '..', 'data');
let FILE = path.join(DATA_DIR, 'settings.json');

/** 宿主给的数据目录（`ctx.dataDir`）—— 动作层每次进来调一次；空值忽略 */
function setDataDir(dir) {
  const d = String(dir || '').trim();
  if (!d) return;
  DATA_DIR = d;
  FILE = path.join(d, 'settings.json');
}

const dataDir = () => DATA_DIR;
const file = () => FILE;

/** 站点默认地址（可换镜像）；封面站给的是整串 URL 拼接用的基地址 */
const DEFAULT_SITE_BASE = 'https://missav.fans';
const DEFAULT_IMAGE_BASE = 'https://fourhoi.mrstcdn.store';
/** 路径里的语言段：影片页 `<站点>/<语言段>/<slug>` */
const DEFAULT_LANGUAGE = 'cn';

/** 缓存的两个旋钮（原来按面板设置走，现在归插件自己） */
const DEFAULT_CACHE_TTL_DAYS = 7;
const DEFAULT_CACHE_MAX_MB = 100;

const stripSlash = (s) => String(s || '').replace(/\/+$/, '');
const pick = (v) => (v === undefined || v === null ? '' : String(v).trim());

function defaults() {
  return {
    siteBase: DEFAULT_SITE_BASE,
    imageBase: DEFAULT_IMAGE_BASE,
    language: DEFAULT_LANGUAGE,
    cacheTtlDays: DEFAULT_CACHE_TTL_DAYS,
    cacheMaxMB: DEFAULT_CACHE_MAX_MB,
  };
}

/** 盘上那份原样（不合并默认值）—— 判"某个键有没有被写过"只能看它 */
function raw() {
  try {
    const v = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** 归一化：基地址空 = 内置默认；语言空 = 默认；两个数字不小于 0（0 = 不缓存 / 不限） */
function normalize(rawCfg) {
  const r = rawCfg || {};
  const num = (v, dft) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : dft);
  return {
    siteBase: stripSlash(pick(r.siteBase)) || DEFAULT_SITE_BASE,
    imageBase: stripSlash(pick(r.imageBase)) || DEFAULT_IMAGE_BASE,
    language: pick(r.language) || DEFAULT_LANGUAGE,
    cacheTtlDays: num(r.cacheTtlDays, DEFAULT_CACHE_TTL_DAYS),
    cacheMaxMB: num(r.cacheMaxMB, DEFAULT_CACHE_MAX_MB),
  };
}

function read() {
  return normalize(raw());
}

function write(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(normalize(cfg), null, 2));
  fs.renameSync(tmp, FILE);
}

/**
 * 合并「已保存设置」与「界面上还没保存的当前值」（自检按钮用）。
 *   基地址 / 语言：body 里带了这个键就算数（空串 = 用内置默认）
 *   数字：body 里给了合法值就用，否则回落已保存值
 */
function effective(body, saved) {
  const b = body || {};
  const s = saved || {};
  const hasKey = (k) => Object.prototype.hasOwnProperty.call(b, k) && b[k] !== undefined && b[k] !== null;

  const base = (k, dft) => {
    if (hasKey(k)) return stripSlash(pick(b[k])) || dft;
    return stripSlash(pick(s[k])) || dft;
  };
  const text = (k, dft) => (hasKey(k) && pick(b[k]) ? pick(b[k]) : pick(s[k]) || dft);
  const count = (k, dft) => {
    if (hasKey(k) && Number.isFinite(Number(b[k])) && Number(b[k]) >= 0) return Number(b[k]);
    return Number.isFinite(Number(s[k])) && Number(s[k]) >= 0 ? Number(s[k]) : dft;
  };

  return {
    siteBase: base('siteBase', DEFAULT_SITE_BASE),
    imageBase: base('imageBase', DEFAULT_IMAGE_BASE),
    language: text('language', DEFAULT_LANGUAGE),
    cacheTtlDays: count('cacheTtlDays', DEFAULT_CACHE_TTL_DAYS),
    cacheMaxMB: count('cacheMaxMB', DEFAULT_CACHE_MAX_MB),
  };
}

/** 当前生效的设置（读写设置的唯一入口）。`over` 可传界面上还没保存的当前值 */
function current(over) {
  return effective(over || {}, raw());
}

module.exports = {
  setDataDir,
  dataDir,
  file,
  DEFAULT_SITE_BASE,
  DEFAULT_IMAGE_BASE,
  DEFAULT_LANGUAGE,
  DEFAULT_CACHE_TTL_DAYS,
  DEFAULT_CACHE_MAX_MB,
  defaults,
  raw,
  read,
  write,
  effective,
  current,
  stripSlash,
};