'use strict';
/**
 * 「插件库」：从**插件仓库**拉清单、按清单下载包（决策见 docs/adr/0035）。
 *
 * 插件不随面板发行 —— 面板全新安装时插件目录是空的，装什么由人决定：
 *   · 面板「插件库」页 → 拉 `<仓库>/index.json` → 挑一个 → 下载它的包 → 走安装链路
 *   · 面板「插件管理」页 → 手动上传 .tar.gz（与这里无关）
 *
 * 取数口径与「面板自身更新」同款（见 modules/panel/update.js）：
 *   · 常量给默认仓库，环境变量可覆盖（`PLUGIN_REPO` / `PLUGIN_INDEX_URL` / `PLUGIN_SOURCE_URL`）
 *   · 清单缓存 60 秒，失败**不缓存**；取不到时**不抛**，把原因交给调用方（页面内联显示）
 *   · 支持 `http(s)://` 与本地路径（内网镜像 / 离线核对时用得上）
 *
 * ⚠️ **不跨模块 require**（分层见 docs/adr/0001）：面板更新那边的小工具（`fetchBytes` /
 * `compareVersion`）在那边是模块私有的，这边各留一份小的，不把模块之间连起来。
 */
const fs = require('fs');
const contract = require('./contract');
const store = require('./store');
const bundle = require('./bundle');

/** 插件仓库（`OWNER/REPO`）—— 与「面板自己」的仓库是**两个**仓库：这里只放插件包，不放源码 */
const LIBRARY_REPO = String(process.env.PLUGIN_REPO || 'dlushu/media-bridge-plugins').trim();

/** 仓库里的清单文件名（约定，见 docs/plugin-contract.md 第七节） */
const INDEX_NAME = 'index.json';

/** 清单支持的结构版本：对不上就如实说"这份清单不是这个面板能读的" */
const SCHEMA = 1;

const CHECK_TTL_MS = 60 * 1000;

const raw = (p) => `https://raw.githubusercontent.com/${LIBRARY_REPO}/main/${p}`;

/** 清单地址（覆盖项给镜像/内网用） */
const indexUrl = () => String(process.env.PLUGIN_INDEX_URL || '').trim() || raw(INDEX_NAME);

/**
 * 包地址：默认走仓库内的相对路径（`raw.githubusercontent.com` 直取），
 * `PLUGIN_SOURCE_URL` 可覆盖，占位符 `{repo}` `{path}` `{type}` `{id}` `{version}`。
 */
function sourceUrlOf(entry) {
  const tpl = String(process.env.PLUGIN_SOURCE_URL || '').trim();
  if (!tpl) return raw(String(entry.path || ''));
  return tpl
    .replace(/\{repo\}/g, LIBRARY_REPO)
    .replace(/\{path\}/g, String(entry.path || ''))
    .replace(/\{type\}/g, String(entry.type || ''))
    .replace(/\{id\}/g, String(entry.id || ''))
    .replace(/\{version\}/g, String(entry.version || ''));
}

/** 取字节：`http(s)://` 走网络（跟随跳转），其余当本地路径读（与 update.js 的 fetchBytes 同款） */
async function fetchBytes(url, { what }) {
  if (!/^https?:\/\//i.test(url)) {
    const p = url.replace(/^file:\/\//, '');
    if (!fs.existsSync(p)) throw new Error(`${what} 不存在：${p}`);
    return fs.readFileSync(p);
  }
  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'media-bridge-panel' } });
  if (!res.ok) throw new Error(`${what} 下载失败：HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** 版本比大小（只比三段数字，够用；与 update.js 那份口径一致） */
function compareVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

let cache = { at: 0, value: null };

/**
 * 校核清单里的一条。**不合格的如实点名**（进 `bad[]`），不连累整份清单 ——
 * 一个手写的清单里混进一条坏的，不该让整页打不开。
 */
function checkEntry(x) {
  if (!x || typeof x !== 'object') return '不是一个对象';
  const type = String(x.type || '').trim();
  if (!contract.TYPES.includes(type)) return `type 不是 ${contract.TYPES.join(' / ')}：「${type || '(空)'}」`;
  const id = String(x.id || '').trim();
  if (!contract.ID_RE.test(id)) return `id 不合法：「${id || '(空)'}」`;
  if (!String(x.name || '').trim()) return '缺 name';
  if (!String(x.version || '').trim()) return '缺 version';
  if (!String(x.path || '').trim()) return '缺 path（包在仓库里的相对路径）';
  const md5 = String(x.md5 || '').trim();
  if (!/^[0-9a-f]{32}$/i.test(md5)) return 'md5 不是 32 位十六进制';
  /* path 是仓库内的相对路径：不许是绝对路径、不许往上跑 */
  const p = String(x.path).split('/');
  if (p.includes('..') || p[0] === '' || /^[a-z]:$/i.test(p[0])) return `path 不能越出仓库：「${x.path}」`;
  return null;
}

/** 拉清单（60 秒缓存；失败不缓存）。返回归一化后的 `{ generatedAt, plugins[] }` */
async function fetchIndex({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.value && now - cache.at < CHECK_TTL_MS) return cache.value;
  const buf = await fetchBytes(indexUrl(), { what: `插件清单 ${INDEX_NAME}` });
  let raw0;
  try {
    raw0 = JSON.parse(buf.toString('utf8'));
  } catch (e) {
    throw new Error(`清单不是合法 JSON：${(e && e.message) || e}`);
  }
  if (!raw0 || typeof raw0 !== 'object') throw new Error('清单必须是一个对象');
  if (Number(raw0.schema) !== SCHEMA) throw new Error(`清单结构版本是 ${raw0.schema}，这个面板只认 ${SCHEMA}`);
  if (!Array.isArray(raw0.plugins)) throw new Error('清单里没有 plugins 数组');

  const plugins = [];
  const bad = [];
  for (const x of raw0.plugins) {
    const why = checkEntry(x);
    if (why) bad.push({ id: (x && x.id) || '', type: (x && x.type) || '', reason: why });
    else plugins.push(x);
  }
  const value = { generatedAt: String(raw0.generatedAt || ''), plugins, bad };
  cache = { at: now, value };
  return value;
}

/** 清单取不到时的空壳：让页面能画出"哪儿出错了"，而不是一片空白 */
const emptyShape = (error, extra = {}) => ({
  repo: LIBRARY_REPO,
  repoUrl: `https://github.com/${LIBRARY_REPO}`,
  indexUrl: indexUrl(),
  generatedAt: '',
  fetchedAt: new Date().toISOString(),
  plugins: [],
  bad: [],
  error: error || null,
  ...extra,
});

/**
 * 清单 + **已装状态标注**（页面直接照这个画）。
 * 取不到清单时不抛：回 200 的空壳 + `error`（与 `/api/panel/update` 同口径）。
 */
async function index({ force = false } = {}) {
  let doc;
  try {
    doc = await fetchIndex({ force });
  } catch (e) {
    return emptyShape((e && e.message) || String(e));
  }
  const installed = new Map(store.list().map((x) => [store.sid(x.type, x.id), x]));
  const plugins = doc.plugins.map((x) => {
    const cur = installed.get(store.sid(x.type, x.id)) || null;
    return Object.assign({}, x, {
      installed: !!cur,
      installedVersion: cur ? String(cur.version || '') : '',
      installedOrigin: cur ? String(cur.origin || '') : '',
      hasUpdate: !!cur && compareVersion(x.version, cur.version) > 0,
      /* 装在哪一条路上装的 —— 页面据此提示"重装会覆盖" */
      sourceUrl: sourceUrlOf(x),
    });
  });
  return Object.assign(emptyShape(null, { generatedAt: doc.generatedAt }), { plugins, bad: doc.bad });
}

/** 在清单里找一条（支持点名版本；不点名 = 用清单里的那个版本）。找不到回 `null` */
async function find(type, id, version = '') {
  const doc = await fetchIndex({});
  return (
    doc.plugins.find(
      (x) => String(x.type) === String(type) && String(x.id) === String(id) && (!version || String(x.version) === String(version))
    ) || null
  );
}

/**
 * 取包字节（`http(s)://` 走网络、其余当本地路径）。
 * **校验不在这里做**：第一道（包 md5）由 `bundle.extractToTemp` 做 —— 与本模块的
 * 手动上传那条路是同一个关卡，不重复实现一遍。
 */
async function download(entry) {
  const url = sourceUrlOf(entry);
  const buf = await fetchBytes(url, { what: `插件包 ${entry.id}-${entry.version}` });
  return { buf, url, bytes: buf.length };
}

/**
 * 装一条库里的插件：下载 → 解包（第一道校验）→ 安装（第二道校验在 store 里）。
 * 与手动上传那条路走的是**同一套**（`bundle.extractToTemp` + `store.installDir`），
 * 只有 `origin` 不同（`library` / `manual`）。
 */
async function install({ type, id, version = '', enable = false }) {
  const entry = await find(type, id, version);
  if (!entry) throw new Error(`插件库里没有 ${type}/${id}${version ? '@' + version : ''}`);
  const { buf, url } = await download(entry);
  console.log(`  · 插件库：下载 ${entry.type}/${entry.id} v${entry.version} ← ${url}（${Math.round(buf.length / 1024)}KB）`);
  const tmp = bundle.extractToTemp(buf, entry.md5);
  try {
    const out = store.installDir(tmp.root, { origin: 'library', md5: entry.md5, enabled: enable === true });
    return { entry, installed: out };
  } finally {
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  }
}

module.exports = {
  LIBRARY_REPO,
  index,
  find,
  download,
  install,
  sourceUrlOf,
  /* 排障用 */
  indexUrl,
};