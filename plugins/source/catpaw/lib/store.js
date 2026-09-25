'use strict';
/**
 * 实例仓库：插件自己的数据目录里那份 `settings.json` 的读写 + 每个实例的目录管理。
 *
 *   data/settings.json                 实例清单 + 自动更新的开关与间隔 + 缓存的两个旋钮
 *   data/instances/<id>/bundle/        本地部署时下载回来的源包（index.js 等）
 *   data/instances/<id>/runtime/       源包自己的数据目录（它写 db / 日志 / 弹幕配置的地方）
 *
 * 「声明归插件、存储也归插件」：面板不碰这些文件，"清空插件数据"就是删 `data/`。
 *
 * 实例有两种形态（`mode`）：
 *   local   本地部署 —— 下载源包、由插件起一个常驻子进程、给它一个端口
 *   remote  外部地址 —— 只填服务地址，不打进程（那台机器上的源由那边自己管）
 */
const fs = require('fs');
const path = require('path');

/** 插件自己的数据目录（面板安装时创建；这里再兜一次，手抄一份目录也能跑） */
const DATA_DIR = path.join(__dirname, '..', 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const INSTANCES_DIR = path.join(DATA_DIR, 'instances');

const MODES = ['local', 'remote'];
const DEFAULT_SETTINGS = {
  instances: [],
  autoUpdate: false,
  autoUpdateHours: 12,
  cacheTtlMinutes: 5,
  cacheMaxMB: 64,
};

/** 不小于 0 的数字（`0` 是有意义的值 —— 不缓存 / 不限，所以不能用 `|| 默认值` 把它吃了） */
const num = (v, dft) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : dft);

function ensureDirs() {
  fs.mkdirSync(INSTANCES_DIR, { recursive: true });
}

function normalize(raw) {
  return {
    instances: Array.isArray(raw && raw.instances) ? raw.instances : [],
    autoUpdate: !!(raw && raw.autoUpdate),
    autoUpdateHours: Math.min(168, Math.max(1, Number(raw && raw.autoUpdateHours) || 12)),
    cacheTtlMinutes: num(raw && raw.cacheTtlMinutes, DEFAULT_SETTINGS.cacheTtlMinutes),
    cacheMaxMB: num(raw && raw.cacheMaxMB, DEFAULT_SETTINGS.cacheMaxMB),
  };
}

function read() {
  ensureDirs();
  try {
    return normalize(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')));
  } catch {
    /* 第一次跑 / 文件被删 / 写坏了 —— 都按空清单起步（不猜、不"修复"，如实从零开始） */
    return normalize({});
  }
}

function write(cfg) {
  ensureDirs();
  const tmp = SETTINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(normalize(cfg), null, 2));
  fs.renameSync(tmp, SETTINGS_FILE);
}

function bundleDir(id) {
  return path.join(INSTANCES_DIR, id, 'bundle');
}

function runtimeDir(id) {
  return path.join(INSTANCES_DIR, id, 'runtime');
}

function newId(list) {
  /* id 要能一眼看出是第几个 —— 站点身份是「插件 + 实例 id + 站点 key」，人也要读得懂 */
  let n = list.length + 1;
  const used = new Set(list.map((x) => x.id));
  while (used.has('s' + n)) n += 1;
  return 's' + n;
}

function list() {
  return read().instances;
}

function get(id) {
  return read().instances.find((s) => s.id === id) || null;
}

/** 校验一份实例配置；不合法回一句人话（null = 通过） */
function validate(one) {
  if (!one || typeof one !== 'object') return '实例必须是一个对象';
  const mode = String(one.mode || 'local');
  if (!MODES.includes(mode)) return `mode 只能是 ${MODES.join(' / ')}，实际是「${mode}」`;
  const url = String(one.url || '').trim();
  if (!url) return mode === 'local' ? '缺少源包地址（该去哪里下载）' : '缺少服务地址';
  if (!/^https?:\/\//i.test(url)) return '地址要以 http:// 或 https:// 开头';
  const port = Number(one.port) || 0;
  if (!(port >= 0 && port <= 65535)) return 'port 取值 0~65535';
  if (one.name != null && typeof one.name !== 'string') return 'name 必须是字符串';
  return null;
}

function create(meta) {
  const bad = validate(meta);
  if (bad) throw new Error(bad);
  const cfg = read();
  const id = String((meta && meta.id) || '').trim() || newId(cfg.instances);
  if (cfg.instances.some((s) => s.id === id)) throw new Error(`实例 id 重复：${id}`);
  const one = {
    id,
    name: String((meta && meta.name) || '').trim(),
    mode: String((meta && meta.mode) || 'local'),
    /* 地址**原样存**（不在这里去尾斜杠）：本地部署的 `url` 是"源包地址"，
     * 拼 `index.js` 之前由下载器自己的 `normalizeBaseUrl` 归一 —— 那里的规则才是权威的。 */
    url: String((meta.url || '')).trim(),
    port: Number(meta.port) || 0,
    host: String(meta.host || '0.0.0.0'),
    /* 参与聚合（关掉的实例整条不出现，站点勾选不用逐个取消） */
    enabled: meta.enabled !== false,
    /* 开机自动拉起（只对本地部署有意义） */
    autostart: !!meta.autostart,
  };
  cfg.instances.push(one);
  write(cfg);
  fs.mkdirSync(bundleDir(id), { recursive: true });
  fs.mkdirSync(runtimeDir(id), { recursive: true });
  return one;
}

function update(id, patch) {
  const cfg = read();
  const i = cfg.instances.findIndex((s) => s.id === id);
  if (i < 0) return null;
  const merged = Object.assign({}, cfg.instances[i], patch);
  const bad = validate(merged);
  if (bad) throw new Error(bad);
  merged.url = String(merged.url).trim();
  cfg.instances[i] = merged;
  write(cfg);
  return merged;
}

/** 删一个实例：清单里去掉 + 目录整个删掉（**调用方先停进程** —— 这里不碰进程） */
function remove(id) {
  const cfg = read();
  const i = cfg.instances.findIndex((s) => s.id === id);
  if (i < 0) return false;
  cfg.instances.splice(i, 1);
  write(cfg);
  try {
    fs.rmSync(path.join(INSTANCES_DIR, id), { recursive: true, force: true });
  } catch {
    /* 目录本来就没有 / 删不动（权限）都算了，清单已经去掉 */
  }
  return true;
}

/** 自动更新那两项（开关 + 间隔小时） */
function autoUpdateCfg() {
  const s = read();
  return { enabled: s.autoUpdate === true, hours: Math.min(168, Math.max(1, Number(s.autoUpdateHours) || 12)) };
}

function setAutoUpdate(patch) {
  const cfg = read();
  if (patch && patch.autoUpdate !== undefined) cfg.autoUpdate = !!patch.autoUpdate;
  if (patch && patch.autoUpdateHours !== undefined) {
    const h = Number(patch.autoUpdateHours);
    if (!(h >= 1 && h <= 168)) throw new Error('自动更新间隔取值 1~168 小时');
    cfg.autoUpdateHours = h;
  }
  write(cfg);
  return autoUpdateCfg();
}

/** 插件自己那份缓存的两个旋钮（有效期分钟 + 上限 MB）—— 0 分别表示"不缓存"与"不限" */
function cacheCfg() {
  const s = read();
  return { ttlMinutes: s.cacheTtlMinutes, maxMB: s.cacheMaxMB };
}

function setCache(patch) {
  const cfg = read();
  if (patch && patch.cacheTtlMinutes !== undefined) {
    const n = Number(patch.cacheTtlMinutes);
    if (!Number.isFinite(n) || n < 0) throw new Error('缓存有效期取值不小于 0 分钟（0 = 不缓存）');
    cfg.cacheTtlMinutes = n;
  }
  if (patch && patch.cacheMaxMB !== undefined) {
    const n = Number(patch.cacheMaxMB);
    if (!Number.isFinite(n) || n < 0) throw new Error('缓存上限取值不小于 0 MB（0 = 不限）');
    cfg.cacheMaxMB = n;
  }
  write(cfg);
  return cacheCfg();
}

module.exports = {
  DATA_DIR,
  SETTINGS_FILE,
  INSTANCES_DIR,
  MODES,
  DEFAULT_SETTINGS,
  ensureDirs,
  read,
  write,
  list,
  get,
  create,
  update,
  remove,
  validate,
  bundleDir,
  runtimeDir,
  autoUpdateCfg,
  setAutoUpdate,
  cacheCfg,
  setCache,
};
