'use strict';
/**
 * 纯 JS 的 zip 打包与解包（零依赖，只用 Node 内置的 `zlib`）
 *
 * 为什么自己写而不调系统 `zip` / `unzip`：运行时镜像是 `node:22-alpine`，
 * 不保证装了这两个命令；备份是面板自带功能，不该依赖镜像里碰巧有的外部程序。
 * 打包与解包都只用到 deflate，`zlib` 就能覆盖，因此不需要引入第三方库。
 *
 * 做两件事：
 *   · `buildZip(entries)`  —— 把若干条目打成一份 zip 字节（每个文件单独 deflate）
 *   · `readZip(buffer)`    —— 把一份 zip 字节解成若干条目
 * `dirEntries(dir, { skip })` 是配套的目录采集：把目录读成 `buildZip` 能直接吃的条目数组。
 *
 * ⚠️ **不支持 Zip64**：条目数上限 65535、单个文件与整包上限 4GB。数据卷的体量远达不到，
 * 真有超过时如实抛错，而不是写出一个装不下的坏包。
 * ⚠️ 解包时**拒绝路径穿越**（绝对路径、`..`、盘符）—— 包可能来自别处，不能让它往外写文件。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------------------------------------------------------------- CRC32 */

/** 查表：按字节算出 CRC32（zip 每个条目头里都要带）—— 只在运行时没有内置实现时用 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * CRC32：优先用 Node 内置的 `zlib.crc32`（C 实现，实测 64MB 数据 2ms），
 * 老运行时没有它才退回上面那张表的逐字节循环（同样数据约 120ms）。
 * 两者结果一致（都是标准 CRC-32/IEEE），只是快慢差两个数量级。
 */
const CRC32 = typeof zlib.crc32 === 'function' ? (buf) => zlib.crc32(buf) >>> 0 : jsCrc32;

function jsCrc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function crc32(buf) {
  return CRC32(buf);
}

/* ------------------------------------------------------------- 时间与路径 */

/** 当前时间 → zip 用的 DOS 时间/日期（两字节各一；1980 年之前的按 1980 兜底） */
function dosStamp(when) {
  const d = when instanceof Date && !isNaN(when.getTime()) ? when : new Date();
  const year = Math.max(1980, d.getFullYear());
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1f);
  const date = (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

/** 条目名是否可安全落盘：非空、非绝对路径、无 `..` / `.` / 空段、无 NUL */
function isSafeName(name) {
  const s = String(name || '');
  if (!s || s.includes('\0')) return false;
  if (s.startsWith('/') || s.startsWith('\\')) return false;
  if (/^[A-Za-z]:[\\/]/.test(s)) return false;
  return s.split(/[\\/]/).every((seg) => seg && seg !== '.' && seg !== '..');
}

/* ---------------------------------------------------------------- 打包 */

const U32_MAX = 0xffffffff;

/**
 * `entries = [{ name, data, mtime?, mode? }]` → zip 字节（`Buffer`）。
 * `name` 用正斜杠的相对路径；`data` 是 `Buffer` 或字符串；`mode` 是 unix 权限（默认 0644）。
 */
function buildZip(entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length > 0xffff) throw new Error(`文件太多（${list.length} 个），超出 zip 的 65535 上限`);
  const parts = [];
  const central = [];
  let offset = 0;

  for (const e of list) {
    const name = String((e && e.name) || '');
    if (!isSafeName(name)) throw new Error('zip 条目名不合法：' + name);
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.isBuffer(e && e.data) ? e.data : Buffer.from(String((e && e.data) || ''), 'utf8');
    const comp = zlib.deflateRawSync(raw);
    if (raw.length > U32_MAX || comp.length > U32_MAX) throw new Error('单个文件超出 zip 的 4GB 上限：' + name);
    const crc = crc32(raw);
    const { time, date } = dosStamp(e && e.mtime);
    const mode = ((e && e.mode) || 0o644) & 0xffff;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    local.writeUInt16LE(20, 4); // 需要的解压版本
    local.writeUInt16LE(0x0800, 6); // 通用标志：文件名为 UTF-8
    local.writeUInt16LE(8, 8); // 压缩方式：deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // 扩展字段长度
    parts.push(local, nameBuf, comp);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // 中央目录项签名
    cd.writeUInt16LE(0x031e, 4); // 生成方：unix，版本 3.0
    cd.writeUInt16LE(20, 6); // 需要的解压版本
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // 扩展字段长度
    cd.writeUInt16LE(0, 32); // 注释长度
    cd.writeUInt16LE(0, 34); // 起始磁盘号
    cd.writeUInt16LE(0, 36); // 内部属性
    cd.writeUInt32LE((mode << 16) >>> 0, 38); // 外部属性：低位放 unix 权限
    cd.writeUInt32LE(offset, 42); // 本地文件头偏移
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + comp.length;
    if (offset > U32_MAX) throw new Error('整包超出 zip 的 4GB 上限');
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // 中央目录结束记录签名
  eocd.writeUInt16LE(0, 4); // 当前磁盘号
  eocd.writeUInt16LE(0, 6); // 中央目录起始磁盘号
  eocd.writeUInt16LE(list.length, 8); // 本磁盘条目数
  eocd.writeUInt16LE(list.length, 10); // 总条目数
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // 注释长度
  return Buffer.concat([...parts, centralBuf, eocd]);
}

/**
 * 采集目录 → `buildZip` 能直接吃的条目数组。
 * `skip(relPath, isDir)` 返回真值则跳过该项（含目录时整棵子树都不进）—— 排除策略由调用方给。
 * 只收普通文件，**不跟随符号链接**（链接按普通项直接跳过）。
 */
function dirEntries(rootDir, { skip } = {}) {
  const out = [];
  const walk = (abs, rel) => {
    let items;
    try {
      items = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return; // 读不动就当这一层没有（best-effort，让备份能继续）
    }
    for (const ent of items) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      const childAbs = path.join(abs, ent.name);
      if (typeof skip === 'function' && skip(childRel, ent.isDirectory())) continue;
      if (ent.isDirectory()) {
        walk(childAbs, childRel);
      } else if (ent.isFile()) {
        const st = fs.statSync(childAbs);
        out.push({ name: childRel, data: fs.readFileSync(childAbs), mtime: st.mtime, mode: st.mode & 0o777 });
      }
    }
  };
  walk(rootDir, '');
  return out;
}

/* ---------------------------------------------------------------- 解包 */

/**
 * zip 字节 → `[{ name, data, mode }]`（目录项直接略过；`mode` 取外部属性里的 unix 权限）。
 * 不接受 Zip64 的扩展记录：找不到普通结束记录时如实报错，不做猜测。
 */
function readZip(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const minPos = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= minPos; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是 zip 文件（找不到中央目录结束记录）');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 中央目录损坏');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const extAttr = buf.readUInt32LE(p + 38);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (compSize === 0 && rawSize === 0 && name.endsWith('/')) continue; // 目录项
    if (!isSafeName(name)) throw new Error('zip 里有非法路径：' + name);
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) {
      throw new Error('zip 条目头损坏：' + name);
    }
    const dataStart = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
    const comp = buf.subarray(dataStart, dataStart + compSize);
    if (dataStart + compSize > buf.length) throw new Error('zip 内容截断：' + name);

    let data;
    if (method === 0) data = Buffer.from(comp);
    else if (method === 8) data = zlib.inflateRawSync(comp);
    else throw new Error(`zip 里用了不支持的压缩方式（${method}）：` + name);
    const mode = (extAttr >>> 16) & 0o777;
    out.push({ name, data, mode: mode || 0o644 });
  }
  return out;
}

module.exports = { buildZip, readZip, dirEntries, crc32, isSafeName };