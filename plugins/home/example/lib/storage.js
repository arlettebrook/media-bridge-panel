'use strict';
/**
 * 插件自己的小仓库（原来沙箱注入的 `Catpaw.storage`）—— **同步**读写，别 await。
 *
 *   data/storage.json   一整份读、一整份写（数据量小，整份写更不易写坏）
 *
 * 示例里只用来缓存 genre 名单（几乎不变、所有行共用，见 rows.js 里那段说明）。
 * 面板不碰这个文件（契约第十一节）。
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'storage.json');

let snapshot = null;

function load() {
  if (snapshot) return snapshot;
  try {
    const v = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    snapshot = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    snapshot = {};
  }
  return snapshot;
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    /* 落盘失败不该让这一行取数失败 —— 内存里那份仍然可用 */
    console.log('  ✘ 首页示例：storage 落盘失败 —— ' + ((e && e.message) || e));
  }
}

function get(key) {
  const k = String(key || '');
  if (!k) return undefined;
  return load()[k];
}

function set(key, value) {
  const k = String(key || '');
  if (!k) return undefined;
  const s = load();
  if (value === undefined) delete s[k];
  else s[k] = value;
  save();
  return value;
}

module.exports = { FILE, get, set };