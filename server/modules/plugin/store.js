'use strict';
/**
 * 插件仓库：`data/plugins/` 的目录布局 + 清单读写 + 安装 / 卸载。
 *
 *   data/plugins/
 *     registry.json              清单：只放元数据（id / 类型 / 版本 / 启用 / 来源 / md5），**不放代码**
 *     <类型>/<插件 id>/           包本体（解包后的目录）
 *     <类型>/<插件 id>/data/      插件自己的数据（设置与缓存都在这儿）
 *
 * ⚠️ **一个插件一个目录、按类型分文件夹**（见 docs/adr/0028）：
 * 身份是 `(类型, id)`，所以不同类型下同名不冲突。
 *
 * ⚠️ **"清空插件数据"就是删 `<目录>/data`** —— 声明与存储在插件自己那边，面板不碰内容
 * （见 docs/adr/0033 与 0028）。
 *
 * 清单为什么不放进 `settings/`：启用/卸载是**单插件操作**，而 settings 的数组是整体替换 ——
 * 多个插件并发保存会互相覆盖（首页插件那边踩过，同样的取舍）。
 */
const fs = require('fs');
const path = require('path');
const { PLUGINS_DIR } = require('../../core/paths');
const contract = require('./contract');

const ROOT = PLUGINS_DIR;
const REGISTRY = path.join(ROOT, 'registry.json');

function ensureRoot() {
  fs.mkdirSync(ROOT, { recursive: true });
}

function readJson(file, dft) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? v : dft;
  } catch {
    return dft;
  }
}

/** 原子写（tmp + rename），与 core/settings、source/store 同款 */
function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
  return obj;
}

/** 清单（数组，按安装先后） */
function list() {
  const r = readJson(REGISTRY, []);
  return Array.isArray(r) ? r : [];
}

function saveAll(arr) {
  ensureRoot();
  return writeJsonAtomic(REGISTRY, arr);
}

/** 身份键：`(类型, id)` */
const sid = (type, id) => `${type}\u0001${id}`;
const splitSid = (s) => {
  const [type, ...rest] = String(s || '').split('\u0001');
  return { type, id: rest.join('\u0001') };
};

function get(type, id) {
  return list().find((x) => x && x.type === type && x.id === id) || null;
}

/** 按身份键找（host 用） */
function getBySid(s) {
  const { type, id } = splitSid(s);
  return get(type, id);
}

const dirOf = (type, id) => path.join(ROOT, String(type), String(id));
const dataDirOf = (type, id) => path.join(dirOf(type, id), 'data');

function upsert(entry) {
  const arr = list();
  const i = arr.findIndex((x) => x && x.type === entry.type && x.id === entry.id);
  if (i >= 0) arr[i] = Object.assign({}, arr[i], entry);
  else arr.push(entry);
  saveAll(arr);
  return get(entry.type, entry.id);
}

/** 改一个插件的几个字段（不动别的） */
function patch(type, id, fields) {
  const arr = list();
  const i = arr.findIndex((x) => x && x.type === type && x.id === id);
  if (i < 0) return null;
  arr[i] = Object.assign({}, arr[i], fields);
  saveAll(arr);
  return arr[i];
}

/**
 * 删除一个插件。（由调用方先把进程停掉。）
 * `keepData` = 保留它的 `data/` 目录（默认跟着删 —— "卸载"就该干净）。
 */
function remove(type, id, { keepData = false } = {}) {
  const dir = dirOf(type, id);
  let kept = '';
  if (keepData && fs.existsSync(dataDirOf(type, id))) {
    kept = path.join(ROOT, `.kept-${type}-${id}-${Date.now()}`);
    fs.renameSync(dataDirOf(type, id), kept);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  saveAll(list().filter((x) => !(x && x.type === type && x.id === id)));
  return { kept };
}

/** 递归复制（用于把内置插件从仓库同步进数据目录） */
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
    if (ent.name === 'data') continue; // 插件数据不属于"包"
    const a = path.join(from, ent.name);
    const b = path.join(to, ent.name);
    if (ent.isDirectory()) copyDir(a, b);
    else fs.copyFileSync(a, b);
  }
}

/**
 * 安装 / 覆盖一个插件：把 `srcDir`（已经解包好的目录）放到 `<类型>/<id>/` 下。
 *
 * `origin` = 'builtin'（随包发行）/ 'upload'（用户装的）—— 只影响显示与"能不能删"的提示。
 * 覆盖时**保留 `data/`**（插件的设置与缓存不该因为换版本被清掉）。
 */
function installDir(srcDir, { origin = 'upload', md5 = '', enabled } = {}) {
  ensureRoot();
  const m = contract.readManifest(srcDir); // 第二道校验在这里（files 逐文件核对）
  const dir = dirOf(m.type, m.id);
  const existed = fs.existsSync(dir);

  /* 先把新版放到临时目录，验完再原子换过去 —— 不让"解到一半"的包留在插件目录里 */
  const stage = path.join(ROOT, `.staging-${m.type}-${m.id}-${Date.now()}`);
  fs.rmSync(stage, { recursive: true, force: true });
  copyDir(srcDir, stage);

  /* ⚠️ 换包时**必须把 `data/` 挪到一边再挪回来**：它是插件自己的数据（源实例清单、它自己的缓存），
   * 不属于"包"。`copyDir` 会跳过 `data/`，但下面那个 `rmSync(dir)` 是整个目录删掉的 ——
   * 一句话：跳过复制不等于保证不删。实测就是这么把刚加好的实例清单清空的。 */
  const dataDir = dataDirOf(m.type, m.id);
  const stash = path.join(path.dirname(dir), `.data-${m.id}-${Date.now()}`);
  const hadData = fs.existsSync(dataDir);
  if (hadData) fs.renameSync(dataDir, stash);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true }); // 类型那一层目录可能还不存在
    fs.renameSync(stage, dir);
  } catch (e) {
    fs.rmSync(stage, { recursive: true, force: true });
    if (hadData && fs.existsSync(stash)) {
      try {
        fs.renameSync(stash, dataDir);
      } catch {
        /* 换包失败时数据先留在 stash 里，别因为回挪失败把原错盖掉 */
      }
    }
    throw e;
  }
  if (hadData && fs.existsSync(stash)) fs.renameSync(stash, dataDir);
  fs.mkdirSync(dataDirOf(m.type, m.id), { recursive: true }); // 插件自己的数据目录

  const stat = contract.dirDigest(dir);
  const entry = {
    type: m.type,
    id: m.id,
    name: m.name,
    version: m.version,
    description: m.description,
    domain: m.domain,
    series: m.series,
    hasWebui: !!m.webui,
    webui: m.webui,
    depends: m.depends,
    origin,
    md5: md5 || stat.digest,
    digest: stat.digest,
    files: stat.files,
    bytes: stat.bytes,
    installedAt: Date.now(),
    /* 覆盖安装时保留原来的启用状态；新建默认**不启用**（装完由人明确打开） */
    enabled: enabled === undefined ? (existed ? !!(get(m.type, m.id) || {}).enabled : false) : !!enabled,
  };
  return upsert(entry);
}

/** 仓库里随包发行的内置插件目录（`<repo>/plugins/<类型>/<id>`） */
function builtinRoot() {
  return path.join(__dirname, '..', '..', '..', 'plugins');
}

/** 列出内置插件（按仓库目录扫，不依赖数据目录） */
function listBuiltins() {
  const root = builtinRoot();
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const type of fs.readdirSync(root, { withFileTypes: true })) {
    if (!type.isDirectory() || !contract.TYPES.includes(type.name)) continue;
    const typeDir = path.join(root, type.name);
    for (const one of fs.readdirSync(typeDir, { withFileTypes: true })) {
      if (!one.isDirectory()) continue;
      const dir = path.join(typeDir, one.name);
      if (!fs.existsSync(path.join(dir, 'plugin.json'))) continue;
      out.push({ type: type.name, id: one.name, dir });
    }
  }
  return out;
}

/**
 * 把内置插件同步进数据目录：**内容指纹变了才重装**（同"内置首页示例"的做法）。
 * 覆盖时保留启用状态与 `data/`；已经装过的、且内容一致的直接跳过。
 */
function syncBuiltins() {
  const notes = [];
  for (const b of listBuiltins()) {
    let digest = '';
    try {
      digest = contract.dirDigest(b.dir).digest;
    } catch (e) {
      notes.push({ id: b.id, type: b.type, action: 'skip', reason: (e && e.message) || String(e) });
      continue;
    }
    const cur = get(b.type, b.id);
    if (cur && cur.digest === digest) continue; // 一致 → 跳过
    try {
      const entry = installDir(b.dir, { origin: 'builtin', enabled: cur ? cur.enabled : false });
      notes.push({ id: entry.id, type: entry.type, action: cur ? 'updated' : 'installed', version: entry.version });
    } catch (e) {
      notes.push({ id: b.id, type: b.type, action: 'failed', reason: (e && e.message) || String(e) });
    }
  }
  return notes;
}

module.exports = {
  ROOT,
  REGISTRY,
  sid,
  splitSid,
  dirOf,
  dataDirOf,
  builtinRoot,
  listBuiltins,
  syncBuiltins,
  list,
  get,
  getBySid,
  upsert,
  patch,
  remove,
  installDir,
  copyDir,
  ensureRoot,
};
