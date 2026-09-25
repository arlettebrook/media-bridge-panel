'use strict';
/**
 * 源插件转接处：**面板侧唯一一处**知道"取数要去调哪个插件的哪个动作"。
 *
 * 存在的理由：聚合层（`service.js`）那套判据是按"上游 HTTP 响应"写的 ——
 * `status === 404` 就是"这个站没有这部片"、超时要与别的错分开报、每站都要记账……
 * 这些口径这一批**一个字都不该改**。所以这里把插件的回复**还原成上游那份形状**
 * （`{ status, ok, text, json }`；失败抛异常，超时抛 `AbortError`），
 * 上面那几处调用点于是只换了一行 —— 这是本批"行为不变"的实现手法。
 *
 * 身份：**`source` = `插件 id / 实例 id`**（契约第九节：站点身份按"插件 + 站点 key"记）。
 * 面板不关心实例背后的地址与端口 —— 那是插件自己的事；这里只做"拆开、转过去、还原回来"。
 *
 * ⚠️ 面板也是**从这里**才知道"有哪些源、有哪些站点"：源不再是面板的配置，
 * 而是插件申报上来的（`站点清单`）。
 */
const host = require('../plugin/host');

/** 默认每次调用插件的超时；取数动作都会带上自己的超时，这个只是兜底 */
const DEFAULT_TIMEOUT_MS = 60000;

/** `插件 id / 实例 id` —— 实例 id 里不允许出现 `/`，所以按第一个斜杠拆是安全的 */
function joinRef(pluginId, instanceId) {
  return String(pluginId || '') + '/' + String(instanceId || '');
}

function splitRef(ref) {
  const s = String(ref || '');
  const at = s.indexOf('/');
  if (at < 0) return { pluginId: '', instanceId: '' };
  return { pluginId: s.slice(0, at), instanceId: s.slice(at + 1) };
}

/**
 * 参与聚合的源插件 = **已安装且启用**的 `source` 类型插件。
 * 没在跑（崩了 / 还没起来）也照样算进来 —— 它会如实报"没在运行"，而不是从清单里消失。
 */
function sourcePlugins() {
  return host.states().filter((x) => x.type === 'source' && x.enabled);
}

/** 转一次动作；`NOT_RUNNING` / `NO_ACTION` 之类**如实抛**（调用方各自决定怎么呈现） */
async function callPlugin(pluginId, action, args, timeoutMs) {
  const r = await host.call('source', pluginId, action, args, {
    timeoutMs: Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS),
  });
  if (!r.ok) {
    const err = r.error || {};
    const e = new Error(err.message || '插件调用失败');
    e.code = err.code || 'PLUGIN_ERROR';
    e.plugin = pluginId;
    e.action = action;
    throw e;
  }
  return r.value;
}

/**
 * 插件回复 → 上游响应形状。
 *
 * 成功：`{ status, ok, text, json }` 原样（`ok` = 那个站回的 HTTP 是不是 2xx，判据在 service.js）
 * 失败：抛。**超时抛 `AbortError`** —— 面板那几处 catch 就是靠它把"超时"与别的错分开的
 *       （文案由调用方按自己的超时值拼，所以这里一个字都不用编）。
 */
function asUpstream(res) {
  if (res && res.error) {
    const err = res.error;
    const e = new Error(err.message || '取数失败');
    e.code = err.code || 'UPSTREAM';
    if (err.code === 'TIMEOUT') e.name = 'AbortError';
    throw e;
  }
  return {
    status: Number(res && res.status) || 0,
    ok: !!(res && res.ok),
    text: String((res && res.text) || ''),
    json: (res && res.json) || null,
    initCalled: !!(res && res.initCalled),
    /* 显示名（插件的实例名）—— 单站测速的回执要写"测的是哪个源"，面板自己不再知道这个名字 */
    name: String((res && res.name) || ''),
  };
}

/** 站点清单：**所有启用的源插件各报一份**，这里合并成面板那一份形状 */
async function loadSites() {
  const plugins = sourcePlugins();
  const rows = [];
  const sites = [];

  for (const p of plugins) {
    let out;
    try {
      // eslint-disable-next-line no-await-in-loop
      out = await callPlugin(p.id, 'sites', {}, 60000);
    } catch (e) {
      /* 整个插件问不动 —— 也占一行如实说，别让它静默消失（否则界面看起来像"这个插件根本没站点"） */
      rows.push({
        id: joinRef(p.id, ''),
        plugin: p.id,
        url: '',
        name: p.name || p.id,
        enabled: true,
        mode: 'plugin',
        deployed: false,
        port: null,
        status: p.status,
        running: false,
        ok: false,
        ms: 0,
        siteCount: 0,
        error: `源插件「${p.name || p.id}」问不动：${(e && e.message) || e}`,
      });
      continue;
    }
    for (const r of (out && out.sources) || []) {
      rows.push(
        Object.assign({}, r, {
          id: joinRef(p.id, r.id),
          plugin: p.id,
          /* `deployed` = "本地部署"（面板原来那个词）—— 前端与 emby 层照旧按它区分两类源 */
          deployed: r.mode === 'local',
        })
      );
    }
    for (const s of (out && out.sites) || []) {
      sites.push(Object.assign({}, s, { source: joinRef(p.id, s.source || '') }));
    }
  }

  return { sources: rows, sites };
}

/** 一个动作的通用调用：按 `插件 id / 实例 id` 转过去 */
async function callAction(ref, action, args) {
  const { pluginId, instanceId } = splitRef(ref);
  if (!pluginId) {
    const e = new Error(`认不出这个源：${ref || '(空)'}（形状是「插件 id / 实例 id」）`);
    e.code = 'BAD_SOURCE_REF';
    throw e;
  }
  const plugin = sourcePlugins().find((x) => x.id === pluginId);
  if (!plugin) {
    const e = new Error(`源插件 ${pluginId} 没安装或没启用`);
    e.code = 'NO_PLUGIN';
    throw e;
  }
  return callPlugin(pluginId, action, Object.assign({ source: instanceId }, args));
}

/** 搜索一个站（两层式站点的第一步） */
async function search(ref, args) {
  return asUpstream(await callAction(ref, 'search', args));
}

/** 取一个站的详情（线路与选集） */
async function detail(ref, args) {
  return asUpstream(await callAction(ref, 'detail', args));
}

/** 解析一次播放地址 */
async function play(ref, args) {
  return asUpstream(await callAction(ref, 'play', args));
}

/** 站点测速（体检口径的一发） */
async function probe(ref, args) {
  return asUpstream(await callAction(ref, 'probe', args));
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  joinRef,
  splitRef,
  sourcePlugins,
  callPlugin,
  callAction,
  loadSites,
  search,
  detail,
  play,
  probe,
};
