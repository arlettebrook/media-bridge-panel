'use strict';
/**
 * 元数据插件转接处：**面板侧唯一一处**知道"某个域要去调哪个插件的哪个动作"。
 *
 * 两件事：
 *   ① **按插件申报重建域表**（`core/providers.js`）—— 装了哪些元数据插件、哪个开着，
 *      前缀就认到哪里；认不出如实空并点名（契约第七节），不回退到别的域；
 *   ② **按域转发动作**（取元数据 / 取一季分集 / 搜索 / 任意路径），并把失败如实翻成面板的错。
 *
 * 面板不解释插件回的字段 —— 那是归一化，归插件（docs/adr/0029 的已定 5）。
 * 这一层只管"去哪个插件、动作叫什么、失败了怎么如实说"。
 *
 * **域声明**（`注册` 动作）额外缓存一份：面板替客户端取图，拼图片地址要用**插件的图片基地址**
 * （契约第六节：图片的代取与签名在面板这边）。那个值只能同步取用（拼串散在各条端点的路径上），
 * 所以这里留一份带保鲜期的快照 —— 插件换设置后最多 `DECL_TTL_MS` 就跟着变。
 */
const providers = require('../../core/providers');
const store = require('../plugin/store');
const host = require('../plugin/host');

/** 域声明的保鲜期：图片基地址这类值要能跟着插件设置走，又不值得每调一次就问一次 */
const DECL_TTL_MS = 10000;
/** 默认每次动作的超时（取数动作自己也会带，这个只是兜底） */
const DEFAULT_TIMEOUT_MS = 20000;
/** 同一个域连续失败时的日志节流：插件停着的时候不该每次调用都刷一行 */
const WARN_MIN_MS = 60000;

const decls = new Map(); // 域 → { at, pid, name, series, imageBase, language, capabilities, error }
const warnedAt = new Map();
let lastSig = '';

function log(line) {
  console.log('  · 元数据 ' + line);
}

function warnOnce(domain, line) {
  const last = warnedAt.get(domain) || 0;
  if (Date.now() - last < WARN_MIN_MS) return;
  warnedAt.set(domain, Date.now());
  console.log('  ✘ 元数据 ' + line);
}

/**
 * 按插件清单重建域表：**已安装的 `metadata` 插件**都进表（装着的就算，不管开没开），
 * 因为"这个前缀是谁的"要在插件停掉时也说得出来（"元数据插件 TMDB 没启用"比"认不出前缀"有用）。
 * 开关状态一并带进去，转发那一刻再判。
 */
function syncProviders() {
  const entries = store
    .list()
    .filter((x) => x && x.type === 'metadata')
    .map((x) => ({
      id: String(x.domain || '').trim(),
      prefix: String(x.domain || '').trim(),
      series: x.series !== false,
      label: x.name || x.id,
      plugin: { type: 'metadata', id: x.id },
      enabled: !!x.enabled,
    }))
    .filter((x) => x.id);

  /* 指纹：插件清单变了才重建（这张表被 emby 层频繁查，别每次都 clear + 填） */
  const sig = JSON.stringify(entries);
  if (sig === lastSig) return { registered: providers.list().length, skipped: [] };
  lastSig = sig;

  const out = providers.sync(entries);
  for (const s of out.skipped) log(`域申报有问题，已跳过：${s.id || '(空)'} —— ${s.reason}`);
  /* 插件被卸掉/改名后，那份域声明跟着丢，免得留着旧图片基地址 */
  for (const domain of decls.keys()) {
    if (!entries.some((e) => e.id === domain)) decls.delete(domain);
  }
  return out;
}

/** 请求路径上的"顺手同步"：读一次插件清单（几毫秒），变了才重建 */
function ensureProviders() {
  try {
    return syncProviders();
  } catch (e) {
    return { registered: providers.list().length, skipped: [{ id: '', reason: String((e && e.message) || e) }] };
  }
}

/** 某个域现在的声明快照（**同步**，可能为空 —— 调用方自己兜默认值） */
function declSync(domain) {
  return decls.get(String(domain || '').trim()) || null;
}

/**
 * 拿一份**新鲜的**域声明（插件换设置、重启之后要跟着变）。
 * 失败不抛：把原因记在返回里，调用方照实处理（面板侧那半件事不该因为插件不在就崩）。
 */
async function declOf(domain, { force = false } = {}) {
  const d = String(domain || '').trim();
  ensureProviders();
  const provider = providers.byPrefixOf(d);
  if (!provider) return { error: { code: 'NO_PLUGIN', message: `没有域 ${d} 的元数据插件（先在「插件」页装上并启用它）` } };
  const cached = decls.get(d) || null;
  const want = { type: provider.plugin.type, id: provider.plugin.id };
  const st = host.stateOf(want.type, want.id);
  if (cached && !force && cached.pid === st.pid && Date.now() - cached.at < DECL_TTL_MS) return cached;

  if (st.status !== 'running') {
    const why = {
      code: 'PLUGIN_DOWN',
      message: `元数据插件 ${provider.label} 没在运行（当前 ${st.status}）—— 去「插件」页启动它`,
    };
    /* 保留上次那份（图片基地址还能用），但把"现在不通"标出来 */
    const next = Object.assign({ at: Date.now(), pid: st.pid, error: why }, cached || {});
    decls.set(d, next);
    return next;
  }

  const r = await host.call(want.type, want.id, 'register', {}, { timeoutMs: DEFAULT_TIMEOUT_MS });
  if (!r.ok) {
    const why = { code: (r.error && r.error.code) || 'PLUGIN_ERROR', message: (r.error && r.error.message) || '取域声明失败' };
    const next = Object.assign({ at: Date.now(), pid: st.pid, error: why }, cached || {});
    decls.set(d, next);
    warnOnce(d, `取 ${provider.label} 的域声明失败：${why.message}`);
    return next;
  }
  const v = r.value || {};
  const next = {
    at: Date.now(),
    pid: st.pid,
    name: String(v.name || provider.label),
    series: v.series !== false,
    imageBase: String(v.imageBase || ''),
    language: String(v.language || ''),
    capabilities: v.capabilities || null,
    error: null,
  };
  decls.set(d, next);
  return next;
}

/** 域表的对外视图（面板页面用：有哪些域、谁提供、开没开） */
function domains() {
  return providers.list().map((x) => {
    const decl = decls.get(x.prefix) || null;
    const st = x.plugin ? host.stateOf(x.plugin.type, x.plugin.id) : null;
    return {
      domain: x.prefix,
      label: x.label,
      series: x.series,
      enabled: x.enabled,
      plugin: x.plugin,
      status: st ? st.status : 'stopped',
      imageBase: (decl && decl.imageBase) || '',
      capabilities: (decl && decl.capabilities) || null,
    };
  });
}

/**
 * 转一次动作。**不抛**：`{ ok: true, value }` 或 `{ ok: false, error: { code, status?, message } }`。
 * 插件报的上游错（`NO_TOKEN` / `INVALID_TOKEN` / `NOT_FOUND` / `UPSTREAM_HTTP` / `TIMEOUT`）
 * **原样带出去** —— 面板的 `httpStatusOf` 就是按这几个码归类的（客户端因此看到真实原因）。
 * 面板这边的问题（没装 / 没启用 / 没在跑 / 没这个动作）另给码，文案里点名是哪个插件。
 */
async function call(domain, action, args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const d = String(domain || '').trim();
  ensureProviders();
  const provider = providers.byPrefixOf(d);
  if (!provider) {
    return { ok: false, error: { code: 'NO_PLUGIN', message: `没有域 ${d || '(空)'} 的元数据插件（先在「插件」页装上并启用它）` } };
  }
  if (!provider.enabled) {
    return { ok: false, error: { code: 'PLUGIN_DISABLED', message: `元数据插件 ${provider.label} 没启用（「插件」页可以打开）` } };
  }
  const want = provider.plugin;
  const r = await host.call(want.type, want.id, action, args, { timeoutMs });
  if (r.ok) return { ok: true, value: r.value };

  const e = r.error || {};
  const code = e.code === 'NOT_RUNNING' || e.code === 'NOT_READY' || e.code === 'IPC_DOWN' ? 'PLUGIN_DOWN' : e.code || 'PLUGIN_ERROR';
  const message =
    code === 'PLUGIN_DOWN'
      ? `元数据插件 ${provider.label} 没在运行 —— 去「插件」页启动它（域 ${d} 的内容在它回来之前都是空的）`
      : `${provider.label} 的「${action}」失败：${e.message || '原因不明'}`;
  warnOnce(d, `${d} 的「${action}」失败（${code}）：${e.message || ''}`);
  return { ok: false, error: { code, status: 0, message } };
}

/* ---------------------------------------------------------------- 取数 */

/** 取元数据：插件回 `{ok, item}` / `{ok:false, error}`，这里原样带出去 */
async function lookup(domain, args) {
  const r = await call(domain, 'lookup', args);
  if (!r.ok) return { ok: false, error: r.error };
  const v = r.value || {};
  if (v.ok === false) return { ok: false, error: v.error || { code: 'UPSTREAM', message: '取元数据失败' } };
  return v;
}

/** 取一季分集（与 lookup 同一种回复形状） */
async function season(domain, args) {
  const r = await call(domain, 'season', args);
  if (!r.ok) return { ok: false, error: r.error };
  const v = r.value || {};
  if (v.ok === false) return { ok: false, error: v.error || { code: 'UPSTREAM', message: '取分集失败' } };
  return v;
}

/** 搜索：成功回候选数组，失败**抛**（与面板原来那份 `search()` 同一取向，调用方决定怎么降级） */
async function search(domain, type, wd) {
  const r = await call(domain, 'search', { type, wd });
  if (!r.ok) {
    const e = new Error(r.error.message);
    e.code = r.error.code;
    throw e;
  }
  const v = r.value || {};
  if (v.ok === false) {
    const e = new Error((v.error && v.error.message) || '搜索失败');
    e.code = (v.error && v.error.code) || 'UPSTREAM';
    e.status = (v.error && v.error.status) || 0;
    e.data = v.error && v.error.data;
    throw e;
  }
  return v.rows || [];
}

/** 开机把每个开着且注册了的域的声明拉一份（图片基地址这类值早一点就是对的） */
async function warm() {
  ensureProviders();
  for (const x of providers.list()) {
    if (!x.enabled) continue;
    // eslint-disable-next-line no-await-in-loop
    await declOf(x.prefix, { force: true }).catch(() => null);
  }
}

module.exports = {
  DECL_TTL_MS,
  syncProviders,
  ensureProviders,
  declSync,
  declOf,
  domains,
  call,
  lookup,
  season,
  search,
  warm,
};
