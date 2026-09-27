'use strict';
/**
 * 插件自己的设置（契约第十一节：声明归插件、存储也归插件）。
 *
 *   data/settings.json
 *     siteBase   —— 站点基地址（会变的镜像域名，默认 missav.fans）
 *     imageBase  —— 封面基地址（`<基地址>/<slug>/cover-t.jpg`）
 *     rowParams  —— 每行的参数值（`{ 行id: { 参数名: 值 } }`）
 *
 * 面板不读也不写这个文件，它只认插件申报的行（`rows` 动作）。
 * 「空串」的语义是「没配置 = 用内置默认」，于是 `read()` 回的一律是可用的地址，
 * 调用方不必到处兜底。
 */
const fs = require('fs');
const path = require('path');

/** 数据目录：宿主通过 ctx.dataDir 下发；没有就退回包内 data/（手抄一份目录也能跑） */
const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');
let dataDir = DEFAULT_DATA_DIR;

function bind(dir) {
  const d = String(dir || '').trim();
  if (d) dataDir = d;
}

function file() {
  return path.join(dataDir, 'settings.json');
}

const DEFAULT_SITE_BASE = 'https://missav.fans';
const DEFAULT_IMAGE_BASE = 'https://fourhoi.mrstcdn.store';

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
  return { siteBase: DEFAULT_SITE_BASE, imageBase: DEFAULT_IMAGE_BASE, rowParams: {} };
}

/** 盘上那份原样（不合并默认值）—— 判「某个键有没有被写过」只能看它 */
function raw() {
  try {
    const v = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function normalize(rawCfg) {
  const r = rawCfg || {};
  return {
    siteBase: stripSlash(pick(r.siteBase)) || DEFAULT_SITE_BASE,
    imageBase: stripSlash(pick(r.imageBase)) || DEFAULT_IMAGE_BASE,
    rowParams: normalizeRowParams(r.rowParams),
  };
}

function read() {
  return normalize(raw());
}

function write(cfg) {
  fs.mkdirSync(dataDir, { recursive: true });
  const target = file();
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(normalize(cfg), null, 2));
  fs.renameSync(tmp, target);
}

/**
 * 合并「已保存设置」与「界面上还没保存的当前值」（自检按钮用）。
 * 基地址类：body 里带了这个键就算数（空串 = 用内置默认）。
 */
function effective(body, saved) {
  const b = body || {};
  const s = saved || {};
  const hasKey = (k) => Object.prototype.hasOwnProperty.call(b, k) && b[k] !== undefined && b[k] !== null;
  const base = (k, dft) => {
    if (hasKey(k)) return stripSlash(pick(b[k])) || dft;
    return stripSlash(pick(s[k])) || dft;
  };
  return {
    siteBase: base('siteBase', DEFAULT_SITE_BASE),
    imageBase: base('imageBase', DEFAULT_IMAGE_BASE),
  };
}

/** 当前生效的设置（读写设置的唯一入口）。`over` 可传界面上还没保存的当前值 */
function current(over) {
  return effective(over || {}, raw());
}

module.exports = {
  DEFAULT_SITE_BASE,
  DEFAULT_IMAGE_BASE,
  bind,
  file,
  defaults,
  raw,
  read,
  write,
  effective,
  current,
  stripSlash,
  normalizeRowParams,
};