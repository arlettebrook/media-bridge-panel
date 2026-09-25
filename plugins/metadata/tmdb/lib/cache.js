'use strict';
/**
 * 插件自己的落盘缓存（契约第十节：**插件侧那份归插件**，面板不干预）。
 *
 * 布局：`data/cache/<表>/<md5(键)>.json`，一条一个文件，内容是 `{ key, at, ttl, value }`。
 *
 *   表 meta    元数据响应（按"路径 + 语言 + 取哪些子资源"作键 —— lean 与 rich 天然是两个键）
 *   表 names   名字 → 搜索结果（只存有结果的成功响应）
 *
 * 为什么不用面板那套 sqlite 缓存：插件是独立包，**不能 require 面板任何代码**；
 * 而这里的量级很小（一部片一个文件），每条一个文件足以，还省掉了库文件与句柄的事。
 *
 * —— 淘汰策略三条各管一件事 ——
 *   · TTL（按时间）管正确性 —— 元数据会变（评分、简介、海报更换）；**读的时候判**，过期就删
 *   · 字节上限管空间 —— 片库上不封顶，不设限会一直涨
 *   · 两者都不管"冷热" —— 所以超限时按 mtime 从旧到新删（用文件系统现成的 LRU 线索）
 *
 * 上限**必须按字节不能按条数**：实测 lean 响应 1.9KB、rich 119KB，差 60 倍，按条数根本算不准。
 * 只缓存**成功响应**：失败写进缓存会把一次网络抖动钉住，而失败本来就该重试。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const settings = require('./settings');

const ROOT = path.join(settings.DATA_DIR, 'cache');
const TABLES = ['meta', 'names'];

/** 「名字 → 搜索结果」的固定口径（不进设置：它不是要调的旋钮，且结果集越新越好） */
const NAME_TTL_MS = 6 * 60 * 60 * 1000;
const NAME_MAX_BYTES = 2 * 1024 * 1024;

/** 扫一遍的节流：写入是高频动作，每次都全目录 stat 会把缓存变成负担 */
const SWEEP_MIN_MS = 30 * 1000;
const lastSweep = new Map();

const md5 = (s) => crypto.createHash('md5').update(String(s)).digest('hex');
const dirOf = (table) => path.join(ROOT, String(table));

/** 各表的存活期与上限：meta 跟设置走，names 固定 */
function limits(table) {
  if (table === 'names') return { ttlMs: NAME_TTL_MS, maxBytes: NAME_MAX_BYTES };
  const c = settings.read();
  return { ttlMs: c.cacheTtlDays * 86400000, maxBytes: c.cacheMaxMB * 1024 * 1024 };
}

function fileOf(table, key) {
  return path.join(dirOf(table), md5(key) + '.json');
}

/** 读一条：过期就删掉并当没有（TTL 归这里管，调用方不必自己判） */
function get(table, key) {
  const file = fileOf(table, key);
  let ent;
  try {
    ent = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const ttl = Number(ent && ent.ttl);
  const at = Number(ent && ent.at);
  if (!Number.isFinite(ttl) || !Number.isFinite(at) || Date.now() > at + ttl) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* 删不掉就算了（下次还判过期） */
    }
    return null;
  }
  return typeof ent.value === 'string' ? ent.value : null;
}

/** 写一条（ttlMs 传 0 = 不缓存，直接不写） */
function put(table, key, value, ttlMs) {
  const ttl = Number(ttlMs);
  if (!Number.isFinite(ttl) || ttl <= 0) return;
  try {
    fs.mkdirSync(dirOf(table), { recursive: true });
    const tmp = fileOf(table, key) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ key: String(key), at: Date.now(), ttl, value: String(value) }));
    fs.renameSync(tmp, fileOf(table, key));
  } catch {
    /* 缓存写失败不该影响取数本身 */
  }
  sweep(table);
}

/** 一张表当前占了多少字节、几条 */
function tableStats(table) {
  let rows = 0;
  let bytes = 0;
  let dir;
  try {
    dir = fs.readdirSync(dirOf(table));
  } catch {
    return { rows: 0, bytes: 0 };
  }
  for (const name of dir) {
    if (!name.endsWith('.json')) continue;
    try {
      bytes += fs.statSync(path.join(dirOf(table), name)).size;
      rows += 1;
    } catch {
      /* 正好被删/换名，跳过 */
    }
  }
  return { rows, bytes };
}

/** 超上限就按 mtime 从旧到新删到 80%（节流：同一张表 30 秒最多扫一次） */
function sweep(table, { force = false } = {}) {
  const last = lastSweep.get(table) || 0;
  if (!force && Date.now() - last < SWEEP_MIN_MS) return;
  lastSweep.set(table, Date.now());

  const { maxBytes } = limits(table);
  if (!(maxBytes > 0)) return; // 0 = 不限
  const dir = dirOf(table);
  let files;
  try {
    files = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return;
  }
  const rows = files
    .map((n) => {
      const p = path.join(dir, n);
      try {
        const st = fs.statSync(p);
        return { p, bytes: st.size, mtime: st.mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  let total = rows.reduce((n, r) => n + r.bytes, 0);
  if (total <= maxBytes) return;
  rows.sort((a, b) => a.mtime - b.mtime);
  const target = maxBytes * 0.8;
  for (const r of rows) {
    if (total <= target) break;
    try {
      fs.unlinkSync(r.p);
      total -= r.bytes;
    } catch {
      /* 删不掉就留着，下一轮再说 */
    }
  }
}

/** 用量（设置页显示"已用 x / 上限 y"） */
function stats() {
  const tables = {};
  let rows = 0;
  let bytes = 0;
  for (const t of TABLES) {
    const one = tableStats(t);
    const lim = limits(t);
    tables[t] = { rows: one.rows, bytes: one.bytes, maxBytes: lim.maxBytes, ttlMs: lim.ttlMs };
    rows += one.rows;
    bytes += one.bytes;
  }
  return { dir: ROOT, rows, bytes, tables };
}

/** 清空（删一张表或全部）—— 这些都是可丢弃数据，删了就是重新抓一遍 */
function clear(table) {
  const list = table ? [String(table)] : TABLES;
  for (const t of list) {
    try {
      fs.rmSync(dirOf(t), { recursive: true, force: true });
    } catch {
      /* 删不掉不算失败：下次写入会重建 */
    }
  }
  return stats();
}

module.exports = { ROOT, TABLES, NAME_TTL_MS, NAME_MAX_BYTES, limits, get, put, sweep, stats, clear };
