'use strict';
/**
 * 插件自己的设置（契约第十一节：**声明归插件、存储也归插件**）。
 *
 *   data/settings.json   token / API 基地址 / 图片基地址 / 语言 / 缓存的存活期与上限
 *
 * 面板不读也不写这个文件；它要知道的只有一件：**图片基地址**（面板替客户端取图，
 * 拼串要用 —— 见契约第六节"图片的代取与签名不属于插件"）。那个值随「注册」动作申报出去。
 *
 * 「空串」的语义与面板原来那份一致：**没填 = 用官方地址**（不是"错的值"）。
 * 于是 `read()` 回的一律是可用的地址，调用方不必到处兜底。
 */
const fs = require('fs');
const path = require('path');

/** 插件自己的数据目录（面板安装时创建；这里再兜一次，手抄一份目录也能跑） */
const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULT_API_BASE = 'https://api.themoviedb.org/3';
const DEFAULT_IMAGE_BASE = 'https://image.tmdb.org/t/p';
const DEFAULT_LANGUAGE = 'zh-CN';

/** 缓存的两个旋钮（原来按面板设置走，现在归插件自己） */
const DEFAULT_CACHE_TTL_DAYS = 30;
const DEFAULT_CACHE_MAX_MB = 200;

const stripSlash = (s) => String(s || '').replace(/\/+$/, '');
const pick = (v) => (v === undefined || v === null ? '' : String(v).trim());

function defaults() {
  return {
    token: '',
    apiBase: DEFAULT_API_BASE,
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

/** 归一化：基地址空 = 官方；语言空 = 默认；两个数字不小于 0（0 = 不缓存） */
function normalize(rawCfg) {
  const r = rawCfg || {};
  const num = (v, dft) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : dft);
  return {
    token: pick(r.token),
    apiBase: stripSlash(pick(r.apiBase)) || DEFAULT_API_BASE,
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
 *   基地址类：body 里带了这个键就算数（空串 = 用官方）
 *   token / language：空串视为没改，回落已保存值（免得只想测连通性却被空密码框搞失败）
 */
function effective(body, saved) {
  const b = body || {};
  const s = saved || {};
  const hasKey = (k) => Object.prototype.hasOwnProperty.call(b, k) && b[k] !== undefined && b[k] !== null;

  const base = (k, official) => {
    if (hasKey(k)) return stripSlash(pick(b[k])) || official;
    return stripSlash(pick(s[k])) || official;
  };
  const fallback = (k, dft) => (hasKey(k) && pick(b[k]) ? pick(b[k]) : pick(s[k]) || dft);

  return {
    token: fallback('token', ''),
    apiBase: base('apiBase', DEFAULT_API_BASE),
    imageBase: base('imageBase', DEFAULT_IMAGE_BASE),
    language: fallback('language', DEFAULT_LANGUAGE),
    cacheTtlDays: Number.isFinite(Number(b.cacheTtlDays)) && Number(b.cacheTtlDays) >= 0 ? Number(b.cacheTtlDays) : Number(s.cacheTtlDays) || DEFAULT_CACHE_TTL_DAYS,
    cacheMaxMB: Number.isFinite(Number(b.cacheMaxMB)) && Number(b.cacheMaxMB) >= 0 ? Number(b.cacheMaxMB) : Number(s.cacheMaxMB) || DEFAULT_CACHE_MAX_MB,
  };
}

/** 当前生效的设置（读写设置的唯一入口）。`over` 可传界面上还没保存的当前值 */
function current(over) {
  return effective(over || {}, raw());
}

module.exports = {
  DATA_DIR,
  FILE,
  DEFAULT_API_BASE,
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
