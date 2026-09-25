'use strict';
/**
 * 猫爪源插件 · 入口（动作层）
 *
 * 契约见 docs/plugin-contract.md 第五节。这个插件把猫爪源的**整套**接了过来：
 * 自己存实例清单、自己下载包与起实例进程、自己管自动更新，对外只给这几个动作 ——
 * 面板不认识 `/config`、`/search` 这类路径，只按动作名要结果。
 *
 *   sites   站点清单     —            所有启用实例的站点（摊平后每项带它属于哪个实例）
 *   search  候选         {source,key,wd,page}      一层/两层式站点都走它
 *   detail  取播放项     {source,key,id}           站点的详情 → 线路与选集
 *   play    解析地址     {source,key,flag,id}      一次播放 → 真实地址
 *   probe   站点测速     {source,key,wd}           体检口径的一发（不重试、不看内容）
 *   http    webui 转发   {method,path,query,body}  插件自己设置页的后端
 *
 * **`source` 是实例 id**（本插件内部的事，面板不知道那背后的地址与端口）。
 *
 * ⚠️ 三个取数动作的返回形状刻意与面板原来那份上游响应**逐字段对齐**
 * （`{ status, ok, text, json }` 或 `{ error: { code, message } }`），
 * 这样面板那套"404 = 没搜到""超时怎么报"的判据一个字都不用改 —— 见 `agg/source-bridge.js`。
 *
 * `init` 属于**插件内部**（见契约第十二节）：有的站不先 `POST /init` 就搜不出来，
 * 所以"候选"与"站点测速"自己会先兜一次，并按「实例地址 + 站点」记住（实例重启换端口后自然重来）。
 * 真打了的这一次会在返回里带 `initCalled: true` —— 面板照实写日志，不参与打分。
 */
const protocol = require('./lib/protocol');
const store = require('./lib/store');
const runner = require('./lib/runner');
const fetcher = require('./lib/fetcher');
const autoUpdate = require('./lib/auto-update');
const { request } = require('./lib/upstream');

/** 取站点清单的超时（与面板原来那份一致） */
const SITES_TIMEOUT_MS = 20000;
/** 站点清单的缓存时长 —— 取数要先知道每个站的 `api` 前缀，不能每发搜索都问一次 `/config` */
const SITES_TTL_MS = 60000;
/** `init` 单次最多等多久（面板原来那套取的是 min(业务超时, 8s)） */
const INIT_MAX_MS = 8000;

/** 实例 id → `{ at, sites: Map<key, site> }` */
const sitesCache = new Map();
/** 「实例地址 + 站点 key」→ 已 init 过 */
const initialized = new Set();

/* ============================================================
 * 实例：解析地址 / 起停
 * ============================================================ */

/** 一个实例现在该打哪个地址（本地部署没在跑就回空 —— 调用方如实报错，不猜） */
function baseUrlOf(one) {
  if (!one) return '';
  if (one.mode === 'remote') return protocol.normSourceUrl(one.url);
  const st = runner.publicState(one.id);
  return st.status === 'running' && st.port ? `http://127.0.0.1:${st.port}` : '';
}

/** 一个实例的对外状态（设置页与管理页都用它） */
function stateOf(one) {
  const st = one.mode === 'local' ? runner.publicState(one.id) : null;
  const url = baseUrlOf(one);
  return {
    id: one.id,
    name: one.name || '',
    mode: one.mode,
    /* 本地部署的 `url` 是**源包地址**（下载用）；这里给的是**它现在服务的地址** */
    sourceUrl: one.url,
    url,
    port: st ? st.port : Number((/^https?:\/\/[^/]+:(\d+)/.exec(url) || [])[1]) || 0,
    enabled: one.enabled !== false,
    autostart: !!one.autostart,
    status: one.mode === 'local' ? st.status : url ? 'running' : 'stopped',
    pid: st ? st.pid : null,
    startedAt: st ? st.startedAt : null,
    error: st ? st.error : '',
    tail: st ? st.tail : [],
    where: one.mode === 'local' ? '本地部署' : '外部地址',
  };
}

/** 找一个实例；认不出就带上"现在有哪些"如实报（不猜） */
function needInstance(id) {
  const want = String(id || '').trim();
  const one = want ? store.get(want) : null;
  if (!one) {
    const have = store.list().map((x) => x.id).join(' / ') || '（一个都没有）';
    const e = new Error(`没有这个实例：${want || '(空)'}（现在是：${have}）`);
    e.code = 'NO_SOURCE';
    throw e;
  }
  return one;
}

/** 取一个实例现在的站点表（带缓存；缓存里没有就现问 `/config`） */
async function sitesOf(one, { timeout = SITES_TIMEOUT_MS, fresh = false } = {}) {
  const cached = sitesCache.get(one.id);
  if (!fresh && cached && Date.now() - cached.at < SITES_TTL_MS) return cached.sites;
  const url = baseUrlOf(one);
  if (!url) {
    const e = new Error(one.mode === 'local' ? '这个实例没在运行' : '这个实例没有地址');
    e.code = 'NO_SOURCE';
    throw e;
  }
  const { sites } = await protocol.fetchSites(url, { timeout });
  const map = new Map(sites.map((x) => [String(x.key), x]));
  sitesCache.set(one.id, { at: Date.now(), url, sites: map });
  return map;
}

/** 站点表里按 key 找站点（认不出就如实报，不猜 —— 站点 key 只在各自实例内唯一） */
async function needSite(one, key) {
  const map = await sitesOf(one);
  const hit = map.get(String(key || '').trim());
  if (!hit) {
    const e = new Error(`实例 ${one.id} 里没有站点 ${key || '(空)'}`);
    e.code = 'NO_SITE';
    throw e;
  }
  return hit;
}

/** 起一个实例（只对本地部署有意义） */
async function startInstance(one, { awaitReady = false } = {}) {
  if (one.mode !== 'local') {
    const e = new Error('外部地址的实例不在这里起进程（那台机器上的源由那边自己管）');
    e.code = 'BAD_REQUEST';
    throw e;
  }
  const src = Object.assign({}, one, { dir: store.bundleDir(one.id), runtimeDir: store.runtimeDir(one.id) });
  await runner.start(src, Object.assign({}, one, { awaitReady }));
  /* 端口可能变了 → 站点缓存作废（缓存里那份 api 仍然有效，但地址变了要重问） */
  sitesCache.delete(one.id);
  return stateOf(one);
}

function stopInstance(one) {
  return runner.stop(one.id).then(() => {
    sitesCache.delete(one.id);
    return stateOf(one);
  });
}

/** 起不来（包还没下载 / 校验不过）时，把原因原样抛出去 —— 上层如实显示 */
async function ensureBundle(one) {
  if (one.mode !== 'local') return null;
  const dir = store.bundleDir(one.id);
  const info = fetcher.verifyBundle(dir);
  if (info.ok) return info;
  const dl = await fetcher.download(bundleUrl(one), dir);
  if (!dl.ok) throw new Error(dl.error || '源包下载/校验失败');
  const again = fetcher.verifyBundle(dir);
  if (!again.ok) throw new Error(again.error);
  return again;
}

/** 源包地址（本地部署才用）—— 交给下载器归一（去尾斜杠、剥掉 index.js 之类），不自己拼 */
function bundleUrl(one) {
  return fetcher.normalizeBaseUrl(one.url);
}

/* ============================================================
 * 取数：四个动作共用的一套（错误形状也在这儿统一）
 * ============================================================ */

/** 超时 → 让面板那边认出是超时（它与面板约定的判据是 `AbortError`） */
function failFrom(e) {
  if (e && e.name === 'AbortError') return { code: 'TIMEOUT', message: '请求超时' };
  return { code: (e && e.code) || 'UPSTREAM', message: (e && e.message) || String(e) };
}

/**
 * 打一发 POST 到某个站点的某个子路径。
 * 返回 `{ status, ok, text, json }`（与面板原来那份上游响应同形）；**不吞错**，抛给调用方。
 */
async function postSite(one, sitePath, sub, body, timeoutMs) {
  const url = baseUrlOf(one);
  if (!url) {
    const e = new Error(one.mode === 'local' ? `实例 ${one.id} 没在运行（到插件设置页启动它）` : `实例 ${one.id} 没有地址`);
    e.code = 'NO_SOURCE';
    throw e;
  }
  const r = await request(url, sitePath + sub, { method: 'POST', body, timeout: timeoutMs });
  return { status: r.status, ok: r.ok, text: r.text, json: r.json };
}

/** `POST {api}/init`（每个「实例地址 + 站点」只打一次；失败不留标记，下次重来） */
async function ensureInit(one, site, timeoutMs) {
  const k = baseUrlOf(one) + '|' + site.key;
  if (initialized.has(k)) return false;
  initialized.add(k);
  try {
    await request(baseUrlOf(one), site.api + '/init', {
      method: 'POST',
      body: {},
      timeout: Math.min(timeoutMs, INIT_MAX_MS),
    });
    return true;
  } catch {
    initialized.delete(k);
    return false;
  }
}

/* ============================================================
 * 动作
 * ============================================================ */

const actions = {
  /**
   * 站点清单 —— 静态声明"这个插件现在有哪些站点"。
   * 返回 `{ sources, sites }`：`sources` 是实例一行一个（含运行态与端口，面板取 302 地址时要用），
   * `sites` 只收**启用**实例的站点，每项带上它属于哪个实例。
   */
  async sites(args, ctx) {
    const fresh = args && args.fresh === true;
    const list = store.list();
    const rows = await Promise.all(
      list.map(async (one) => {
        const t0 = Date.now();
        const st = stateOf(one);
        const row = {
          id: one.id,
          name: one.name || one.url || one.id,
          url: baseUrlOf(one),
          sourceUrl: one.url,
          mode: one.mode,
          port: st.port || null,
          status: st.status,
          running: st.status === 'running',
          enabled: one.enabled !== false,
          ok: false,
          ms: 0,
          siteCount: 0,
          error: null,
        };
        let sites = [];
        if (!row.enabled) {
          row.error = '这个实例没启用（在插件设置页里勾上，或不管它）';
        } else if (!row.url) {
          row.error = one.mode === 'local' ? '这个实例没在运行（到插件设置页启动它）' : '没有地址';
        } else {
          try {
            const map = await sitesOf(one, { fresh });
            sites = Array.from(map.values()).map((x) => Object.assign({}, x, { source: one.id }));
            row.ok = true;
            row.siteCount = sites.length;
          } catch (e) {
            row.error = e && e.name === 'AbortError' ? '请求超时' : String((e && e.message) || e);
          }
        }
        row.ms = Date.now() - t0;
        return { row, sites };
      })
    );
    const out = {
      sources: rows.map((x) => x.row),
      sites: rows.filter((x) => x.row.enabled).flatMap((x) => x.sites),
    };
    if (ctx) ctx.log(`站点清单：${out.sources.length} 个实例 → ${out.sites.length} 个站点`);
    return out;
  },

  /** 候选 —— 一个站的搜索（两层式站点的第一步） */
  async search(args, ctx) {
    const one = needInstance(args.source);
    const site = await needSite(one, args.key);
    const timeoutMs = Math.max(1000, Number(args.timeoutMs) || 5000);
    try {
      const initCalled = await ensureInit(one, site, timeoutMs);
      const r = await postSite(one, site.api, '/search', { wd: args.wd, page: args.page }, timeoutMs);
      if (initCalled && ctx) ctx.log(`首次搜索前打了 init：${one.id} / ${site.key}`);
      return Object.assign(r, { initCalled, site: site.key, source: one.id });
    } catch (e) {
      return { error: failFrom(e), source: one.id, site: site.key };
    }
  },

  /** 取播放项 —— 一个站的详情（线路 + 每条的选集），面板据此定位到某一集 */
  async detail(args, ctx) {
    const one = needInstance(args.source);
    const site = await needSite(one, args.key);
    const timeoutMs = Math.max(1000, Number(args.timeoutMs) || 10000);
    try {
      const r = await postSite(one, site.api, '/detail', { id: args.id }, timeoutMs);
      return Object.assign(r, { source: one.id, site: site.key });
    } catch (e) {
      if (ctx) ctx.log(`取播放项失败：${one.id} / ${site.key} — ${(e && e.message) || e}`);
      return { error: failFrom(e), source: one.id, site: site.key };
    }
  },

  /** 解析地址 —— 一次播放（地址会过期，所以每次播放都现取、这里不缓存） */
  async play(args, ctx) {
    const one = needInstance(args.source);
    const site = await needSite(one, args.key);
    const timeoutMs = Math.max(1000, Number(args.timeoutMs) || 5000);
    try {
      const r = await postSite(one, site.api, '/play', { flag: args.flag, id: args.id }, timeoutMs);
      return Object.assign(r, { source: one.id, site: site.key });
    } catch (e) {
      if (ctx) ctx.log(`解析地址失败：${one.id} / ${site.key} — ${(e && e.message) || e}`);
      return { error: failFrom(e), source: one.id, site: site.key };
    }
  },

  /**
   * 站点测速 —— **体检口径**的一发：只回答"通不通、多快"，不重试、不解释结果内容。
   * 与"候选"打的是同一个接口（`/search`），差别在口径：那边是业务取数、这边是量耗时。
   */
  async probe(args) {
    const one = needInstance(args.source);
    const site = await needSite(one, args.key);
    const timeoutMs = Math.max(1000, Number(args.timeoutMs) || 15000);
    try {
      const initCalled = await ensureInit(one, site, timeoutMs);
      const r = await postSite(one, site.api, '/search', { wd: args.wd, page: '1' }, timeoutMs);
      /* `name` = 实例的显示名（面板的测速回执要显示"测的是哪个源"） */
      return Object.assign(r, { initCalled, source: one.id, site: site.key, name: one.name || one.url || one.id });
    } catch (e) {
      return { error: failFrom(e), source: one.id, site: site.key };
    }
  },

  /** 插件设置页的后端（面板只转发、不解释，见契约第十一节） */
  async http(args, ctx) {
    const method = String(args.method || 'GET').toUpperCase();
    const p = String(args.path || '/');
    const body = (() => {
      if (!args.body) return {};
      if (typeof args.body === 'object') return args.body;
      try {
        return JSON.parse(String(args.body));
      } catch {
        return {};
      }
    })();
    const ok = (v) => ({ status: 200, body: Object.assign({ ok: true }, v) });
    const bad = (status, message) => ({ status, body: { ok: false, error: message } });

    try {
      if (p === '/state' && method === 'GET') {
        return ok({
          instances: store.list().map(stateOf),
          autoUpdate: autoUpdate.state(),
          dataDir: store.DATA_DIR,
        });
      }

      if (p === '/instances' && method === 'POST') {
        const one = store.create(body);
        if (one.mode === 'local') await ensureBundle(one).catch((e) => ctx.log(`下载源包失败（先记下，可稍后点更新）：${e.message}`));
        if (body.start) await startInstance(one).catch((e) => ctx.log(`启动失败：${e.message}`));
        return ok({ instance: stateOf(store.get(one.id) || one) });
      }

      const m = /^\/instances\/([^/]+)(?:\/([a-z]+))?$/.exec(p);
      if (m) {
        const id = decodeURIComponent(m[1]);
        const op = m[2] || '';
        const one = needInstance(id);
        if (method === 'DELETE' && !op) {
          await stopInstance(one).catch(() => {});
          store.remove(id);
          sitesCache.delete(id);
          return ok({ removed: id });
        }
        if (method === 'PATCH' && !op) {
          const patch = {};
          for (const k of ['name', 'enabled', 'autostart', 'port', 'host', 'url', 'mode']) {
            if (body[k] !== undefined) patch[k] = body[k];
          }
          const next = store.update(id, patch);
          sitesCache.delete(id);
          return ok({ instance: stateOf(next) });
        }
        if (method === 'POST' && op) {
          if (op === 'start') {
            await ensureBundle(one);
            return ok({ instance: await startInstance(one) });
          }
          if (op === 'stop') return ok({ instance: await stopInstance(one) });
          if (op === 'restart') {
            await ensureBundle(one);
            await stopInstance(one);
            await new Promise((r) => setTimeout(r, 400));
            return ok({ instance: await startInstance(one) });
          }
          if (op === 'update') {
            const dl = await fetcher.download(bundleUrl(one), store.bundleDir(one.id), { force: true });
            if (!dl.ok) return bad(400, dl.error || '下载/校验失败');
            const running = runner.publicState(one.id).status === 'running';
            if (running) await runner.restart(Object.assign({}, one, { dir: store.bundleDir(one.id), runtimeDir: store.runtimeDir(one.id) }), one);
            return ok({ changed: !!dl.changed, restarted: running });
          }
          return bad(400, `认不出这个操作：${op}（支持 start / stop / restart / update）`);
        }
      }

      if (p === '/autoupdate' && method === 'POST') {
        const next = store.setAutoUpdate(body);
        autoUpdate.apply();
        return ok({ autoUpdate: Object.assign({}, autoUpdate.state(), next) });
      }
      if (p === '/autoupdate/run' && method === 'POST') {
        const r = await autoUpdate.runNow({ reason: 'manual' });
        if (!r.ok) return bad(r.busy ? 409 : 400, r.error || '跑不起来');
        return ok({ results: r.results, autoUpdate: autoUpdate.state() });
      }

      return bad(404, `插件设置页没有这个接口：${method} ${p}`);
    } catch (e) {
      return bad((e && e.code === 'NO_SOURCE') ? 404 : 400, (e && e.message) || String(e));
    }
  },
};

/* ============================================================
 * 开机：自启实例 + 自动更新计时
 *
 * 放在**下一个事件循环**跑：宿主是先拿到 `ready`（动作清单）再发第一条调用的，
 * 开机这几件事可能很慢（下包、起进程），不该挡在 `ready` 前面。
 * ============================================================ */
setTimeout(async () => {
  const list = store.list();
  for (const one of list) {
    if (one.mode !== 'local' || !one.autostart) continue;
    try {
      await ensureBundle(one);
      await startInstance(one, { awaitReady: true });
      console.log(`✔ 自启实例：${one.id} ${one.name || one.url}`);
    } catch (e) {
      console.log(`✘ 自启失败 ${one.id}：${(e && e.message) || e}`);
    }
  }
  autoUpdate.start();
}, 0).unref?.();

/* ============================================================
 * 善后：**插件被停掉时，把实例进程一起带走**
 *
 * 这是"插件自己起的东西自己清"那条义务里最要紧的一半：插件是实例进程的父进程，
 * 父进程一没，它会变成孤儿 —— 端口还占着、面板下次又起一份，而且谁都看不见它。
 * （面板停插件走的是 SIGTERM，见 `modules/plugin/host.js` 的 `stop()`。）
 *
 * 不等实例"停干净"再退：`runner.stop()` 会先发 SIGTERM、2.5 秒后才 SIGKILL，
 * 而面板那边自己也有个 3 秒的退出上限 —— 这里只保证**信号已经发出去**，就退出。
 * ============================================================ */
let exiting = false;
function shutdown(sig) {
  if (exiting) return;
  exiting = true;
  const running = store.list().filter((x) => x.mode === 'local' && runner.publicState(x.id).status === 'running');
  if (running.length) console.log(`收到 ${sig}：正在停 ${running.length} 个实例（${running.map((x) => x.id).join(' / ')}）`);
  Promise.resolve()
    .then(() => runner.stopAll())
    .catch(() => {});
  setTimeout(() => process.exit(0), 1200).unref?.();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { actions };
