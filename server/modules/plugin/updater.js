'use strict';
/**
 * 插件**自更新**（Magisk 式 `updateUrl`）：
 *
 *   插件在 `plugin.json` 里声明 `updateUrl`（一个 http(s) 地址）→
 *   面板 GET 它，拿到一份小 JSON：
 *
 *     { "version": "1.0.2",
 *       "url": "https://example.com/xxx-1.0.2.tar.gz",
 *       "md5": "（可选）包 md5，给了就当第一道校验",
 *       "changelog": "（可选）一句话更新说明，管理页原样显示" }
 *
 *   版本比当前新 ⇒ 管理页一键更新：下载 tar.gz → 走与手动安装**同一套**两道校验
 *   （bundle.extractToTemp + store.installDir）→ 停旧进程 → 换新包 → 自动起新进程。
 *
 * 与「插件库」（library.js）是**两条互不依赖的来路**：
 *   · 插件库：面板拉仓库 index.json，适合仓库里收录的包；
 *   · 自更新：**插件包自己声明去哪查新版**，包没被任何仓库收录也能更新。
 * 安全口径：清单地址与包地址都只收 http(s)；更新包的 `(type,id)` 必须与已装插件一致
 * （不允许"更新"成另一个身份的包）；清单声明的版本必须与包内 plugin.json 一致。
 */
const fs = require('fs');
const contract = require('./contract');
const store = require('./store');
const host = require('./host');
const bundle = require('./bundle');

/** 清单缓存：60 秒内不重复打远端（连点两下"检查更新"只发一次请求） */
const CHECK_TTL_MS = 60 * 1000;
/** 清单与包各自的下载超时 */
const FETCH_TIMEOUT_MS = 15000;

const checkCache = new Map();

function e(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** 版本比大小（三段数字；与 library.js 那份同口径，模块间不互相 require） */
function compareVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

async function fetchBytes(url, { what, timeoutMs = FETCH_TIMEOUT_MS }) {
  if (!/^https?:\/\//i.test(url)) throw e('BAD_URL', `${what} 地址必须是 http(s)：${url}`);
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'media-bridge-panel' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw e('FETCH_FAILED', `${what} 下载失败：HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * 检查一个插件的自更新清单。成功回 info；失败抛带 code 的错（路由如实转状态码）。
 * `force` 绕过 60 秒缓存。
 */
async function check(type, id, { force = false } = {}) {
  const entry = store.get(type, id);
  if (!entry) throw e('NOT_FOUND', `没有这个插件：${type}/${id}`);
  /* 更新清单是**包级**的（一个 id 一份），缓存按 id 即可 */
  const cacheKey = entry.id;
  const cached = checkCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.at < CHECK_TTL_MS) return cached.info;

  const updateUrl = String(entry.updateUrl || '').trim();
  if (!updateUrl) throw e('NO_UPDATE_URL', '这个插件没有声明 updateUrl');

  const buf = await fetchBytes(updateUrl, { what: '自更新清单' });
  let doc;
  try {
    doc = JSON.parse(buf.toString('utf8'));
  } catch (err) {
    throw e('BAD_MANIFEST', '自更新清单不是合法 JSON：' + ((err && err.message) || err));
  }
  if (!doc || typeof doc !== 'object') throw e('BAD_MANIFEST', '自更新清单必须是一个对象');
  const latest = String(doc.version || '').trim();
  const rawUrl = String(doc.url || '').trim();
  if (!latest) throw e('BAD_MANIFEST', '自更新清单缺 version');
  if (!rawUrl) throw e('BAD_MANIFEST', '自更新清单缺 url（新包地址）');
  /* url 允许写**同目录文件名**（Magisk 式相对引用，打包工具默认就这么写）：
   * 按 updateUrl 所在目录解析；绝对地址也收。解析完必须仍是 http(s)，
   * 把 file:// / 其他协议挡在外面。 */
  let url;
  try {
    url = new URL(rawUrl, updateUrl).href;
  } catch (err) {
    throw e('BAD_URL', `自更新清单里的 url 无法解析：${rawUrl}`);
  }
  if (!/^https?:\/\//i.test(url)) throw e('BAD_URL', `自更新清单里的 url 必须是 http(s)：${rawUrl}`);
  const md5 = String(doc.md5 || '').trim().toLowerCase();
  if (md5 && !/^[0-9a-f]{32}$/.test(md5)) throw e('BAD_MANIFEST', '自更新清单里的 md5 不是 32 位十六进制');

  const info = {
    type: (entry.types || [])[0] || type,
    types: (entry.types || []).slice(),
    id: entry.id,
    updateUrl,
    current: String(entry.version || ''),
    latest,
    url,
    md5,
    changelog: String(doc.changelog || '').trim(),
    hasUpdate: compareVersion(latest, entry.version || '0.0.0') > 0,
    checkedAt: new Date().toISOString(),
  };
  checkCache.set(cacheKey, { at: Date.now(), info });
  return info;
}

/**
 * 批量检查：把所有**声明了 `updateUrl` 的**已装插件一次查完（管理页开页、定时、
 * 「全部更新」前都走这里）。单个插件失败**不牵连别的** —— 它自己的结果里带 `error`，
 * 页面照常显示其余可更新的。`force` 绕 60 秒缓存。
 */
async function checkAll({ force = false } = {}) {
  const entries = store.list().filter((x) => String(x.updateUrl || '').trim());
  const updates = await Promise.all(
    entries.map(async (x) => {
      const role = (x.types || [])[0] || '';
      try {
        return Object.assign({ ok: true }, await check(role, x.id, { force }));
      } catch (err) {
        return {
          ok: false,
          type: role,
          types: (x.types || []).slice(),
          id: x.id,
          current: String(x.version || ''),
          error: (err && err.message) || '检查更新失败',
          code: (err && err.code) || 'CHECK_FAILED',
        };
      }
    })
  );
  return { updates, checkedAt: new Date().toISOString() };
}

/**
 * 用一个**已解包**的新包覆盖安装，并在装完后**自动重启**（原来启用着就再起回来）：
 *
 *   旧插件在跑 ⇒ 先等它真的退出（不 await 会撞"新 start 看到旧进程还活着"的竞态）
 *   → store.installDir（data/ 保留、启用状态按入参/原状）→ 该启用就立刻起新进程。
 *
 * 手动上传与插件库安装也走这里：**任何来路的覆盖安装都同一套重启口径**。
 * `enable` 不给（undefined）⇒ 全新装默认不启用、覆盖装沿用原启用状态（与 store 同口径）。
 */
async function replaceInstalled(root, { origin = 'manual', md5 = '', enable } = {}) {
  const m = contract.readManifest(root); // 第二道校验之前先确认清单本身可读
  const role = (m.types || [])[0];
  const prev = store.byId(m.id);
  const wasEnabled = !!(prev && prev.enabled);
  const wantEnabled = enable === undefined ? wasEnabled : !!enable;

  if (prev) await host.stop(role, m.id);
  const installed = store.installDir(root, { origin, md5, enabled: wantEnabled });
  /* 版本变了，之前查到的"有没有新版"就不作数了 —— 立刻丢掉缓存。 */
  checkCache.delete(m.id);
  let state = null;
  if (wantEnabled) state = host.start(role, m.id).state || null;
  return { entry: installed, state, previous: prev ? { version: prev.version, enabled: wasEnabled } : null };
}

/**
 * 一键更新：检查 → 下载 → **身份/版本核对** → 覆盖安装 + 自动重启。
 * 不抛业务异常：成功回 `{ok:true,...}`，失败回 `{ok:false,error:{code,status,message}}`，
 * 由路由直接转给页面（与 agg 层同一套口径）。
 */
async function update(type, id) {
  const fail = (code, status, message) => ({ ok: false, error: { code, status, message } });
  let info;
  try {
    info = await check(type, id, { force: true });
  } catch (err) {
    return fail(err.code || 'CHECK_FAILED', err.code === 'NOT_FOUND' ? 404 : 502, (err && err.message) || '检查更新失败');
  }
  if (!info.hasUpdate) {
    return fail('NO_UPDATE', 409, `已经是最新版本（当前 v${info.current}，清单最新 v${info.latest}）`);
  }

  let tmp = null;
  try {
    const buf = await fetchBytes(info.url, { what: `插件包 ${id}-${info.latest}` });
    tmp = bundle.extractToTemp(buf, info.md5);

    /* 身份核对：更新包必须是**同一个包的新版本** —— id 相同且 **types 集合完全相同**
     * （多类型之后，借更新把包的类型集合换掉等于换身份，拒绝）；
     * 版本也要与清单声明一致 —— 清单说 v1.0.2、包里却是别的，按篡改拒绝。 */
    const m = contract.readManifest(tmp.root);
    const current0 = store.get(type, id);
    if (m.id !== id || !current0 || !store.sameTypes(current0.types, m.types)) {
      return fail(
        'IDENTITY_MISMATCH',
        400,
        `更新包身份对不上：清单属于 ${type}/${id}（${(current0 && current0.types || []).join('/')}），` +
          `包里是 ${(m.types || []).join('/')}/${m.id}`
      );
    }
    if (m.version !== info.latest) {
      return fail('VERSION_MISMATCH', 400, `更新包版本与清单不一致：清单 v${info.latest}，包内 v${m.version}`);
    }

    const entry0 = store.get(type, id);
    const out = await replaceInstalled(tmp.root, {
      origin: (entry0 && entry0.origin) || 'manual',
      md5: info.md5,
    });
    return {
      ok: true,
      from: info.current,
      to: info.latest,
      plugin: out.entry,
      state: out.state || host.stateOf(type, id),
    };
  } catch (err) {
    return fail(err.code || 'UPDATE_FAILED', 400, (err && err.message) || '更新失败');
  } finally {
    if (tmp) fs.rmSync(tmp.dir, { recursive: true, force: true });
  }
}

module.exports = { check, checkAll, update, replaceInstalled, compareVersion };
