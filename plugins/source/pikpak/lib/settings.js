'use strict';
/**
 * 插件自己的设置与账号（契约第二节：声明归插件、存储也归插件，面板不读也不写）。
 *
 * 两个文件，都在插件自己的数据目录下：
 *
 *   data/settings.json
 *     sukebeiBase       磁力站基地址（Sukebei）—— 换镜像只改这一处
 *     saveDir           PikPak 里的保存目录名（离线下载落在这里，没有就建）
 *     waitSeconds       离线下载最多等多少秒（面板一次调用总预算是 60 秒）
 *     cacheTtlMinutes   磁力搜索结果的缓存有效期（分钟；0 = 不缓存）
 *     cacheMaxMB        缓存字节上限（MB；0 = 不限）
 *
 *   data/auth.json
 *     username / password / refreshToken / deviceId   界面上填进来的凭据
 *     token / captchaToken / userId / saveDirId       登录之后拿到的那些
 *
 * 凭据与设置分两个文件：保存设置不会碰到登录态，反过来也一样。
 * 密码只落盘 —— 不进日志、不回给设置页（回界面的那份走 publicAuth()）。
 *
 * 数据目录由宿主通过 ctx.dataDir 给出（每个插件一份独立目录），所以这里不写死路径：
 * 入口先把目录登记进来，本模块与 cache.js 再按它定位。未登记时回落到插件包旁的 `data/`。
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_SUKEBEI_BASE = 'https://sukebei.nyaa.si';
const DEFAULT_SAVE_DIR = 'PikPak磁力';
const DEFAULT_WAIT_SECONDS = 40;
const DEFAULT_CACHE_TTL_MINUTES = 10;
const DEFAULT_CACHE_MAX_MB = 64;

let dataDir = path.join(__dirname, '..', 'data');

/** 入口登记数据目录（只在动作入口调一次；空值不覆盖，免得把目录改没） */
function setDataDir(dir) {
  const s = String(dir || '').trim();
  if (s) dataDir = s;
}
function dataDirOf() {
  return dataDir;
}
function settingsFile() {
  return path.join(dataDir, 'settings.json');
}
function authFile() {
  return path.join(dataDir, 'auth.json');
}

const stripSlash = (s) => String(s || '').replace(/\/+$/, '');
const pick = (v) => (v === undefined || v === null ? '' : String(v).trim());
/** 不小于 0 的数字（0 是有意义的值 —— 不缓存 / 不限，不能用 `|| 默认值` 把它吃掉） */
const num = (v, dft) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : dft);

/** 盘上那份原样（不合并默认值）—— 判「某个键有没有被写过」只能看它 */
function readJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    /* 第一次跑 / 文件被删 / 写坏了 —— 都按默认值起步（不猜、不「修复」） */
    return {};
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

/* ------------------------------------------------------------------ 设置 */

function defaults() {
  return {
    sukebeiBase: DEFAULT_SUKEBEI_BASE,
    saveDir: DEFAULT_SAVE_DIR,
    waitSeconds: DEFAULT_WAIT_SECONDS,
    cacheTtlMinutes: DEFAULT_CACHE_TTL_MINUTES,
    cacheMaxMB: DEFAULT_CACHE_MAX_MB,
  };
}

function normalize(cfg) {
  const r = cfg || {};
  return {
    sukebeiBase: stripSlash(pick(r.sukebeiBase)) || DEFAULT_SUKEBEI_BASE,
    saveDir: pick(r.saveDir) || DEFAULT_SAVE_DIR,
    waitSeconds: num(r.waitSeconds, DEFAULT_WAIT_SECONDS),
    cacheTtlMinutes: num(r.cacheTtlMinutes, DEFAULT_CACHE_TTL_MINUTES),
    cacheMaxMB: num(r.cacheMaxMB, DEFAULT_CACHE_MAX_MB),
  };
}

function read() {
  return normalize(readJson(settingsFile()));
}

function write(cfg) {
  writeJson(settingsFile(), normalize(cfg));
}

/** 站点与行为三项（基地址 / 保存目录 / 等待秒数）—— 整份替换，只留认识的键 */
function setSite(patch) {
  const cfg = read();
  const b = patch || {};
  if (b.sukebeiBase !== undefined) cfg.sukebeiBase = stripSlash(pick(b.sukebeiBase)) || DEFAULT_SUKEBEI_BASE;
  if (b.saveDir !== undefined) cfg.saveDir = pick(b.saveDir) || DEFAULT_SAVE_DIR;
  if (b.waitSeconds !== undefined) {
    const n = Number(b.waitSeconds);
    if (!Number.isFinite(n) || n < 0) throw new Error('等待秒数取值不小于 0 秒');
    cfg.waitSeconds = n;
  }
  write(cfg);
  return read();
}

/** 缓存的两个旋钮（有效期分钟 + 上限 MB）—— 0 分别表示「不缓存」与「不限」 */
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

/**
 * 合并「已保存设置」与「界面上还没保存的当前值」（自检按钮用）：
 * body 里带了这个键就算数（空串 = 用默认值），没带就回落已保存值。
 */
function effective(body, saved) {
  const b = body || {};
  const s = saved || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k) && b[k] !== undefined && b[k] !== null;
  return {
    sukebeiBase: stripSlash(pick(has('sukebeiBase') ? b.sukebeiBase : s.sukebeiBase)) || DEFAULT_SUKEBEI_BASE,
    saveDir: pick(has('saveDir') ? b.saveDir : s.saveDir) || DEFAULT_SAVE_DIR,
    waitSeconds: num(has('waitSeconds') ? b.waitSeconds : s.waitSeconds, DEFAULT_WAIT_SECONDS),
  };
}

/* ---------------------------------------------------------------- 账号 */

function readAuth() {
  const a = readJson(authFile());
  const s = (k) => pick(a[k]);
  return {
    username: s('username'),
    password: s('password'),
    refreshToken: s('refreshToken'),
    deviceId: s('deviceId'),
    token: s('token'),
    captchaToken: s('captchaToken'),
    userId: s('userId'),
    saveDirId: s('saveDirId'),
  };
}

/** 改几个键（其余原样保留）—— 空串是有意义的取值（清掉这个键） */
function patchAuth(patch) {
  const next = Object.assign(readAuth(), patch || {});
  writeJson(authFile(), next);
  return next;
}

/** 回给设置页的那一份：只报「有没有」，不回密码与令牌本身 */
function publicAuth() {
  const a = readAuth();
  return {
    username: a.username,
    hasPassword: !!a.password,
    hasRefreshToken: !!a.refreshToken,
    deviceId: a.deviceId,
    loggedIn: !!a.token,
    hasCaptchaToken: !!a.captchaToken,
    userId: a.userId,
    saveDirId: a.saveDirId,
  };
}

/** 退出登录：只丢本地令牌（不去调服务端接口 —— 反复登入登出会触发风控） */
function clearSession() {
  const a = readAuth();
  writeJson(authFile(), Object.assign(a, { token: '', captchaToken: '', saveDirId: '', userId: '' }));
  return publicAuth();
}

module.exports = {
  DEFAULT_SUKEBEI_BASE,
  DEFAULT_SAVE_DIR,
  DEFAULT_WAIT_SECONDS,
  setDataDir,
  dataDirOf,
  settingsFile,
  authFile,
  defaults,
  read,
  write,
  setSite,
  cacheCfg,
  setCache,
  effective,
  stripSlash,
  readAuth,
  patchAuth,
  publicAuth,
  clearSession,
};