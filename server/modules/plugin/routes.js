'use strict';
/**
 * 插件模块的路由（面板侧的管理面）。
 *
 *   GET    /api/plugins                        列表：已装插件的状态（含动作清单）
 *   GET    /api/plugins/library                **插件库**：插件仓库的清单 + 已装状态标注
 *   POST   /api/plugins/library/install        **从插件库装**：body `{ type, id, version?, enable? }`
 *   POST   /api/plugins/install                手动安装：body `{ tarball: base64(tar.gz), md5?, enable? }`
 *   GET    /api/plugins/updates                批量查自更新：所有声明了 updateUrl 的已装插件一次查完
 *   GET    /api/plugins/:type/:id/update-check 插件自更新：查它声明的 updateUrl（Magisk 式）
 *   POST   /api/plugins/:type/:id/update        一键更新：下载清单里的新包并自动重启
 *   DELETE /api/plugins/:type/:id              卸载（`?keepData=1` 保留它的 data/）
 *   POST   /api/plugins/:type/:id/enable       启用（起进程）
 *   POST   /api/plugins/:type/:id/disable      停用（停进程；**插件自己起的东西由它自己清**）
 *   POST   /api/plugins/:type/:id/restart      重启（停干净再起）
 *   POST   /api/plugins/:type/:id/call         手发一条动作（排障用；面板不解释动作与参数）
 *   GET    /api/plugins/:type/:id/ui/*         插件的 webui 静态文件
 *   ANY    /api/plugins/:type/:id/api/*        **纯转发**给插件：转成动作 `http`
 *
 * ⚠️ `install` 与 `library/install` 是**两条不同的入口**：包从哪来不同（本地上传 / 插件仓库），
 * 但校验与安装走的是同一套（`bundle.extractToTemp` + `store.installDir`），只有 `origin` 不同
 * （`manual` / `library`，见 docs/adr/0035）。
 *
 * ⚠️ **门禁**：这些路径全在 `/api/` 前缀下，而 `core/auth.js` 的 `needsAuth` 对 `/api/` 一律要登录
 * —— 所以插件的 webui 与转发通道**天然受门禁**，不必再往名单里加东西（见 docs/adr/0029 与契约）。
 * 这也是"插件 webui 放在 /api/plugins/… 下而不是静态目录"的原因：静态目录是免登录的。
 *
 * ⚠️ **面板不解析转发的内容**（见 docs/adr/0033 的已定 21）：它只把方法 / 路径 / query / body
 * 原样交给插件，插件回什么就回什么。插件的设置声明与存储都在插件自己那边。
 */
const fs = require('fs');
const path = require('path');
const { sendJson, sendError, readBody, readRawBody, serveStatic } = require('../../core/http');
const contract = require('./contract');
const store = require('./store');
const host = require('./host');
const bundle = require('./bundle');
const library = require('./library');
const updater = require('./updater');

/** 一个插件能不能给"某类型栏目"挂导航入口 —— 有 webui 才行（见 docs/adr/0029 的已定 18） */
const webuiPath = (type, id) => `/api/plugins/${encodeURIComponent(type)}/${encodeURIComponent(id)}/ui/`;

function register(r) {
  r.add('GET', '/api/plugins', (req, res) => {
    const installed = store.list();
    const states = new Map(host.states().map((s) => [store.sid(s.type, s.id), s]));
    const rows = installed.map((x) => {
      const st = states.get(store.sid(x.type, x.id)) || {};
      return Object.assign({}, x, st, {
        webuiPath: x.hasWebui ? webuiPath(x.type, x.id) : '',
        dir: store.dirOf(x.type, x.id),
      });
    });
    /* 只有**已装的**：插件不随面板发行（见 docs/adr/0035），"可装的"在 /api/plugins/library */
    return sendJson(res, 200, { plugins: rows, types: contract.TYPES });
  });

  /* 插件库：拉插件仓库的清单并标注"装没装"（清单取不到也回 200，原因在 error 里） */
  r.add('GET', '/api/plugins/library', async (req, res, { query }) => {
    const out = await library.index({ force: String(query.refresh || '') === '1' });
    return sendJson(res, 200, out);
  });

  /**
   * 从插件库装一个：下载 → 校验（两道）→ 安装。
   * `enable` 由调用方明确给（默认不启用 —— 与手动安装同口径：装完由人明确打开）。
   * 覆盖安装（更新 / 重装）时由 replaceInstalled 先停旧进程、装完按原状态自动起回来。
   */
  r.add('POST', '/api/plugins/library/install', async (req, res) => {
    const body = (await readBody(req)) || {};
    const type = String(body.type || '').trim();
    const id = String(body.id || '').trim();
    if (!type || !id) return sendError(res, 400, '要指定 type 与 id');
    let tmp = null;
    try {
      const { entry, buf } = await library.install({
        type,
        id,
        version: String(body.version || '').trim(),
      });
      tmp = bundle.extractToTemp(buf, entry.md5);
      const out = await updater.replaceInstalled(tmp.root, {
        origin: 'library',
        md5: entry.md5,
        enable: body.enable === undefined ? undefined : body.enable === true,
      });
      console.log(`  ✔ 插件库：已安装 ${out.entry.type}/${out.entry.id} v${out.entry.version}（${out.entry.files} 个文件，${Math.round(out.entry.bytes / 1024)}KB）`);
      return sendJson(res, 200, {
        plugin: Object.assign({}, out.entry, host.stateOf(out.entry.type, out.entry.id)),
        restarted: !!(out.previous && out.entry.enabled),
      });
    } catch (e) {
      return sendError(res, 400, (e && e.message) || '安装失败');
    } finally {
      if (tmp) fs.rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  r.add('POST', '/api/plugins/install', async (req, res) => {
    const body = (await readBody(req)) || {};
    let tmp = null;
    try {
      tmp = bundle.extractToTemp(Buffer.from(String(body.tarball || ''), 'base64'), body.md5);
      /* 装（含覆盖）与自动重启都在 replaceInstalled：旧的在跑就先停，
       * 装完按"入参 enable / 全新默认关 / 覆盖沿用原态"决定起不起。 */
      const out = await updater.replaceInstalled(tmp.root, {
        origin: 'manual',
        md5: String(body.md5 || ''),
        enable: body.enable === undefined ? undefined : body.enable === true,
      });
      console.log(`  ✔ 插件已安装 ${out.entry.type}/${out.entry.id} v${out.entry.version}（${out.entry.files} 个文件，${Math.round(out.entry.bytes / 1024)}KB）`);
      return sendJson(res, 200, {
        plugin: Object.assign({}, out.entry, host.stateOf(out.entry.type, out.entry.id)),
        restarted: !!(out.previous && out.entry.enabled),
      });
    } catch (e) {
      return sendError(res, 400, (e && e.message) || '安装失败');
    } finally {
      if (tmp) fs.rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  /* ---------------------- 插件自更新（Magisk 式 updateUrl；与插件库互不依赖）------ */

  /** 批量查：所有声明了 updateUrl 的已装插件一次查完（管理页开页 / 定时 / 「全部更新」前）。
   *  路由在 `/:type/:id/...` 之前，段数也不同（3 段 vs 5 段），不会被吃掉。 */
  r.add('GET', '/api/plugins/updates', async (req, res, { query }) => {
    const out = await updater.checkAll({ force: String(query.refresh || '') === '1' });
    return sendJson(res, 200, out);
  });

  /** 检查更新：回清单信息（hasUpdate 为 true 时前端才允许点更新）。?refresh=1 绕缓存 */
  r.add('GET', '/api/plugins/:type/:id/update-check', async (req, res, { params, query }) => {
    try {
      const info = await updater.check(params.type, params.id, { force: String(query.refresh || '') === '1' });
      return sendJson(res, 200, info);
    } catch (e) {
      const code = (e && e.code) || 'CHECK_FAILED';
      const status = code === 'NOT_FOUND' ? 404 : code === 'NO_UPDATE_URL' ? 400 : 502;
      return sendError(res, status, (e && e.message) || '检查更新失败');
    }
  });

  /** 一键更新：服务端自己重取清单（不信客户端给的 url）→ 下载 → 校验 → 停旧装新自动重启 */
  r.add('POST', '/api/plugins/:type/:id/update', async (req, res, { params }) => {
    const out = await updater.update(params.type, params.id);
    if (!out.ok) return sendJson(res, out.error.status || 502, out.error);
    return sendJson(res, 200, out);
  });

  r.add('DELETE', '/api/plugins/:type/:id', async (req, res, { params, query }) => {
    const { type, id } = params;
    if (!store.get(type, id)) return sendError(res, 404, '没有这个插件');
    /* **必须等进程真的退出**再删/再响应：stop() 是异步等 SIGTERM 生效的。
     * 不 await 就删，紧接着重装时新 start() 会看到旧进程还活着而直接返回
     * （"已经在跑的不重复起"），旧进程随后一死，新装的那个永远起不来。 */
    await host.stop(type, id);
    const keepData = String(query.keepData || '') === '1';
    const out = store.remove(type, id, { keepData });
    console.log(`  · 插件已卸载 ${type}/${id}${keepData ? '（数据保留在 ' + out.kept + '）' : ''}`);
    return sendJson(res, 200, { removed: { type, id }, kept: out.kept });
  });

  r.add('POST', '/api/plugins/:type/:id/enable', (req, res, { params }) => {
    const { type, id } = params;
    if (!store.get(type, id)) return sendError(res, 404, '没有这个插件');
    store.patch(type, id, { enabled: true });
    void host.restart(type, id); // 起（或重启）它 —— 启用就该立刻能被打
    return sendJson(res, 200, { state: host.stateOf(type, id) });
  });

  r.add('POST', '/api/plugins/:type/:id/disable', (req, res, { params }) => {
    const { type, id } = params;
    if (!store.get(type, id)) return sendError(res, 404, '没有这个插件');
    store.patch(type, id, { enabled: false });
    host.stop(type, id);
    return sendJson(res, 200, { state: host.stateOf(type, id) });
  });

  r.add('POST', '/api/plugins/:type/:id/restart', async (req, res, { params }) => {
    const { type, id } = params;
    if (!store.get(type, id)) return sendError(res, 404, '没有这个插件');
    await host.restart(type, id);
    return sendJson(res, 200, { state: host.stateOf(type, id) });
  });

  /** 调试台：手发一条动作。面板**不解释**动作与参数，原样转过去、原样回来 */
  r.add('POST', '/api/plugins/:type/:id/call', async (req, res, { params }) => {
    const body = (await readBody(req)) || {};
    const action = String(body.action || '').trim();
    if (!action) return sendError(res, 400, '要指定 action');
    const out = await host.call(params.type, params.id, action, body.args || {}, { timeoutMs: body.timeoutMs });
    return sendJson(res, out.ok ? 200 : 502, out);
  });

  /* ------------------------------- webui：静态文件（受门禁）+ 转发给插件 */

  r.add('GET', '/api/plugins/:type/:id/ui/*rest', (req, res, { params }) => {
    const entry = store.get(params.type, params.id);
    if (!entry || !entry.hasWebui) return sendError(res, 404, '这个插件没有 webui');
    /* `/ui/` 之后的部分**相对 webui 入口所在目录**解析（入口是 `ui/index.html` 时，
     * `/ui/x.js` 就是 `ui/x.js`）—— 这样页面里写 `./x.js` 与写 `/ui/x.js` 是一回事 */
    const rel = String(params.rest || '');
    const base = path.resolve(store.dirOf(params.type, params.id));
    const entryDir = path.dirname(entry.webui || 'index.html');
    const target = rel ? path.join(entryDir, rel) : entry.webui;
    const dest = path.resolve(base, target);
    if (dest !== base && !dest.startsWith(base + path.sep)) return sendError(res, 400, '路径不合法');
    const file = fs.existsSync(dest) && fs.statSync(dest).isDirectory() ? path.join(dest, 'index.html') : dest;
    /* 复用面板自己的静态服务（带根目录参数）：Content-Type 与缓存策略（no-cache + ETag）都与面板一致 ——
     * 插件换版本后页面立刻是新的，不用清浏览器缓存 */
    if (serveStatic(req, res, path.relative(base, file), base)) return;
    return sendError(res, 404, '插件里没有这个文件：' + rel);
  });

  r.add('ANY', '/api/plugins/:type/:id/api/*rest', async (req, res, { params, query }) => {
    const entry = store.get(params.type, params.id);
    if (!entry) return sendError(res, 404, '没有这个插件');
    let body = '';
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      try {
        /* 按 **UTF-8 字符串**转过去（不是 Buffer）：管道是 JSON 消息，插件侧 `JSON.parse(body)`
         * 就能用。（需要二进制就由插件自己在文本里约定编码 —— 面板不解释内容。） */
        body = (await readRawBody(req, 1024 * 1024)).toString('utf8');
      } catch (e) {
        return sendError(res, 413, '请求体太大：' + ((e && e.message) || e));
      }
    }
    /* **纯转发**：面板不解析内容 —— 方法 / 路径 / query / body 原样交给插件，
     * 插件回 `{ status?, body }`（body 可以是对象或字符串），面板原样回给浏览器。
     * `host` / `proto` 是**客户端够面板时用的主机名与协议**：output 插件要据此
     * 生成"外部程序回头访问面板"的默认地址（它自己不知道面板在哪）。 */
    /* query 必须在这里转成**普通对象**：路由器给的是 URLSearchParams，直接丢进
     * IPC 的 JSON 序列化会变成 `{}`（插件侧 args.query.pluginId 全是 undefined）。
     * 顺手剥掉 `token`：网关已验过票，凭证不该再下发给插件子进程。 */
    const queryOut = {};
    if (query && typeof query.forEach === 'function') {
      query.forEach((v, k) => {
        if (k !== 'token') queryOut[k] = v;
      });
    }
    const out = await host.call(
      params.type,
      params.id,
      'http',
      {
        method: req.method,
        path: '/' + String(params.rest || ''),
        query: queryOut,
        body,
        contentType: String(req.headers['content-type'] || ''),
        host: String(req.headers.host || ''),
        proto: String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http',
      },
      { timeoutMs: 30000 }
    );
    if (!out.ok) return sendJson(res, 502, { error: out.error });
    const v = out.value || {};
    const status = Number(v.status) || 200;
    if (v.body === undefined || v.body === null) return sendJson(res, status, { ok: true });
    if (typeof v.body === 'string') {
      res.writeHead(status, { 'Content-Type': v.contentType || 'text/plain; charset=utf-8' });
      return res.end(v.body);
    }
    return sendJson(res, status, v.body);
  });
}

module.exports = register;
