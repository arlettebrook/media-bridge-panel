'use strict';
/**
 * 插件自己的设置（契约第十一节：**声明归插件、存储也归插件**）。
 *
 *   data/settings.json
 *     token / apiBase / imageBase / language   —— TMDB 取数要的那几项
 *     rowParams                                —— 每行的参数值（`{ 行id: { 参数名: 值 } }`）
 *
 * 面板不读也不写这个文件，它只认插件申报的行（`rows` 动作）。
 * 「空串」的语义与面板原来那份一致：**没填 = 用官方地址**（不是"错的值"），
 * 于是 `read()` 回的一律是可用的地址，调用方不必到处兜底。
 *
 * ⚠️ token 是**这个插件自己的**：首页插件与元数据插件各存各的（见
 * docs/plugin-migration-plan.md 批次 9 的口径），面板层不替任何一方保管。
 */
const fs = require('fs');
const path = require('path');

/** 插件自己的数据目录（面板安装时创建；这里再兜一次，手抄一份目录也能跑） */
const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULT_API_BASE = 'https://api.themoviedb.org/3';
const DEFAULT_IMAGE_BASE = 'https://image.tmdb.org/t/p';
const DEFAULT_LANGUAGE = 'zh-CN';

const stripSlash = (s) => String(s || '').replace(/\/+$/, '');
const pick = (v) => (v === undefined || v === null ? '' : String(v).trim());

/** 行参数：只收 `{ 行id: { 参数名: 字符串值 } }` 这种两层结构，其余一律丢掉 */
function normalizeRowParams(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out = {};
  for (const [rowId, vals] of Object.entries(v)) {
    if (!rowId || !vals || typeof vals !== 'object' || Array.isArray(vals)) continue;
    const one = {};
    for (const [k, val] of Object.entries(vals)) {
      if (!k) continue;
      one[k] = val === undefined || val === null ? '' : String(val);
    }
    if (Object.keys(one).length) out[rowId] = one;
  }
  return out;
}

function defaults() {
  return {
    token: '',
    apiBase: DEFAULT_API_BASE,
    imageBase: DEFAULT_IMAGE_BASE,
    language: DEFAULT_LANGUAGE,
    rowParams: {},
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

/** 归一化：基地址空 = 官方；语言空 = 默认 */
function normalize(rawCfg) {
  const r = rawCfg || {};
  return {
    token: pick(r.token),
    apiBase: stripSlash(pick(r.apiBase)) || DEFAULT_API_BASE,
    imageBase: stripSlash(pick(r.imageBase)) || DEFAULT_IMAGE_BASE,
    language: pick(r.language) || DEFAULT_LANGUAGE,
    rowParams: normalizeRowParams(r.rowParams),
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
  defaults,
  raw,
  read,
  write,
  effective,
  current,
  stripSlash,
  normalizeRowParams,
};