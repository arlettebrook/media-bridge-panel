'use strict';
/**
 * 种子（`.torrent`）的取回与解析 —— 「这个磁力里到底有哪些文件」的权威来源。
 *
 * 为什么不是「问了 PikPak 才知道」：PikPak 没有「只解析磁力、不落盘」的接口，
 * 落到它那边就得提交离线下载；而磁力站的 `/download/<id>.torrent` 就是同一个种子的
 * 元数据本体（文件名、路径、体积一比一），拿它解析**不碰网盘、不落任何文件**。
 * `/view/<id>` 页上也有一份文件清单（HTML），但长目录会被折叠、还得靠切标签猜层级，
 * 所以只当兜底，主路走种子。
 *
 * bencode 解码自己写：格式只有四种类型（整数 / 字节串 / 列表 / 字典），
 * 四十行就够，不值得为它引一个依赖（插件目录里没有 node_modules）。
 */

/** 字节串按 utf8 解 —— 种子里 `name` / `path` 都是 utf8；不是 Buffer 就按字符串用 */
const str = (v) => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v == null ? '' : v));

/** 整数 */
const INT = 0x69; // 'i'
/** 列表 */
const LIST = 0x6c; // 'l'
/** 字典 */
const DICT = 0x64; // 'd'
/** 结束标记（整数结尾也是它） */
const END = 0x65; // 'e'
/** 字节串的长度与内容之间的冒号 */
const COLON = 0x3a; // ':'

/**
 * bencode 解码。认不出来就抛 —— 上层如实报「这不是种子」，不猜半个结果。
 *
 * 只有 `info` 里的东西是可信的：`name`（资源根名）、`files[]`（多文件，每项 `path` + `length`）、
 * `length`（单文件种子）。其余字段（announce 等）一律不管。
 */
function bdecode(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || '');
  let i = 0;

  function parse() {
    if (i >= b.length) throw new Error('种子内容不完整');
    const c = b[i];
    if (c === INT) {
      const end = b.indexOf(END, i);
      if (end < 0) throw new Error('整数没有结束标记');
      const n = Number(b.subarray(i + 1, end).toString('latin1'));
      if (!Number.isFinite(n)) throw new Error('整数解不出来');
      i = end + 1;
      return n;
    }
    if (c === LIST) {
      i += 1;
      const out = [];
      while (b[i] !== END) out.push(parse());
      i += 1;
      return out;
    }
    if (c === DICT) {
      i += 1;
      const out = {};
      while (b[i] !== END) {
        const k = parse();
        out[str(k)] = parse();
      }
      i += 1;
      return out;
    }
    const colon = b.indexOf(COLON, i);
    if (colon < 0) throw new Error('字节串没有长度分隔符');
    const len = Number(b.subarray(i, colon).toString('latin1'));
    if (!Number.isFinite(len) || len < 0) throw new Error('字节串长度解不出来');
    const start = colon + 1;
    const end = start + len;
    if (end > b.length) throw new Error('字节串超出内容长度');
    i = end;
    return b.subarray(start, end);
  }

  const out = parse();
  return out;
}

/**
 * 种子 → 文件清单 `{ root, files: [{ name, path, size }] }`。
 *
 *   · 多文件种子：`info.files[]`，每项的 `path` 是**分段数组**（目录 + 文件名），
 *     拼接成 `a/b/c.mp4` 作为定位用的 `path`，最后一段当显示名；
 *   · 单文件种子：只有 `info.name` + `info.length`，两者相等；
 *   · `info` 缺了就回空清单（上层据此如实说「解析不出文件」）。
 */
function filesOf(torrent) {
  const info = torrent && torrent.info;
  if (!info || typeof info !== 'object') return { root: '', files: [] };
  const root = str(info.name);

  if (Array.isArray(info.files) && info.files.length) {
    const files = [];
    for (const f of info.files) {
      const parts = (Array.isArray(f && f.path) ? f.path : []).map(str).filter(Boolean);
      if (!parts.length) continue;
      files.push({ name: parts[parts.length - 1], path: parts.join('/'), size: Number(f.length) || 0 });
    }
    return { root, files };
  }

  if (info.length) {
    return { root, files: [{ name: root, path: root, size: Number(info.length) || 0 }] };
  }
  return { root, files: [] };
}

/** 种子地址（Sukebei 的下载路径；`id` 是 `/view/<id>` 里那个数字） */
function torrentUrl(base, id) {
  const b = String(base || '').replace(/\/+$/, '') || 'https://sukebei.nyaa.si';
  return `${b}/download/${encodeURIComponent(String(id || ''))}.torrent`;
}

module.exports = { bdecode, filesOf, torrentUrl, str };