'use strict';
/**
 * 插件自己的小仓库（**同步读写**，别 await）。
 *
 *   data/storage.json   一整份读、一整份写（数据量小，整份写更不易写坏）
 *
 * 这里存的是**行结果缓存**：键 = 行 id + 参数 + 分页窗口，值 = `{ expiresAt, result }`。
 * 之所以落盘而不只放内存：设置页要能报出缓存用量并一键清空（面板不碰这个文件，
 * 契约第十一节），落盘顺带让重启后热门行仍是热的。
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');
let dataDir = DEFAULT_DATA_DIR;
let snapshot = null;

function bind(dir) {
  const d = String(dir || '').trim();
  if (d && d !== dataDir) {
    dataDir = d;
    snapshot = null; // 换了目录：把内存里那份丢掉，下次从新目录读
  }
}

function file() {
  return path.join(dataDir, 'storage.json');
}

function load() {
  if (snapshot) return snapshot;
  try {
    const v = JSON.parse(fs.readFileSync(file(), 'utf8'));
    snapshot = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    snapshot = {};
  }
  return snapshot;
}

function save() {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const target = file();
    const tmp = target + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(snapshot));
    fs.renameSync(tmp, target);
  } catch (e) {
    /* 落盘失败不该让这一行取数失败 —— 内存里那份仍然可用 */
    console.log('[missav] storage 落盘失败：' + ((e && e.message) || e));
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

function del(key) {
  return set(key, undefined);
}

/** 现有的键，**按写入顺序**（JSON 对象保序）—— 淘汰最旧的那批靠它 */
function keys() {
  return Object.keys(load());
}

function clear() {
  snapshot = {};
  save();
}

/** 用量：键数与近似字节数（整份序列化后的长度） */
function stats() {
  const s = load();
  const ks = Object.keys(s);
  let bytes = 0;
  try {
    bytes = Buffer.byteLength(JSON.stringify(s), 'utf8');
  } catch {
    bytes = 0;
  }
  return { entries: ks.length, bytes };
}

module.exports = { bind, file, get, set, del, keys, clear, stats };