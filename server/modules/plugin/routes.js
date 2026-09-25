'use strict';
/**
 * 插件模块的路由（面板侧的管理面）。
 *
 *   GET    /api/plugins                        列表：已装插件的状态（含内存 / 重启次数 / 动作清单）
 *                                              + 仓库里随包发行的内置插件（还没装的也列出来）
 *   POST   /api/plugins/install                安装：body `{ tarball: base64(tar.gz), md5?, enable? }`
 *   DELETE /api/plugins/:type/:id              卸载（`?keepData=1` 保留它的 data/）
 *   POST   /api/plugins/:type/:id/enable       启用（起进程）
 *   POST   /api/plugins/:type/:id/disable      停用（停进程；**插件自己起的东西由它自己清**）
 *   POST   /api/plugins/:type/:id/restart      重启（手动重启会把自动重启的退避计数清零）
 *   POST   /api/plugins/:type/:id/call         手发一条动作（管理页的"调试台"）
 *   GET    /api/plugins/:type/:id/ui/*         插件的 webui 静态文件
 *   ANY    /api/plugins/:type/:id/api/*        **纯转发**给插件：转成动作 `http`
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
const os = require('os');
const { execFileSync } = require('child_process');
const { sendJson, sendError, readBody, readRawBody, serveStatic } = require('../../core/http');
const contract = require('./contract');
const store = require('./store');
const host = require('./host');

/**
 * 把 base64 的 tar.gz 解到临时目录，返回该目录（调用方负责删）。
 * `expectMd5` = 发布方给的包 md5 —— **第一道校验**：对不上当场拒绝，
 * 既不"先装上再说"，也不拿实际值去覆写清单假装成功（与源包的做法一致）。
 */
function extractToTemp(b64, expectMd5) {
  const buf = Buffer.from(String(b64 || ''), 'base64');
  if (!buf.length) throw new Error('没有拿到包内容');
  if (expectMd5) {
    const got = contract.md5(buf);
    if (got !== String(expectMd5).trim().toLowerCase()) {
      throw new Error(`包校验不过：清单写的 ${String(expectMd5).trim().slice(0, 12)}…，实际 ${got.slice(0, 12)}…`);
    }
  }
  if (buf.length > contract.MAX_BYTES) {
    throw new Error(`包太大（${Math.round(buf.length / 1024 / 1024)}MB > ${Math.round(contract.MAX_BYTES / 1024 / 1024)}MB）`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-'));
  const tar = path.join(dir, 'p.tar.gz');
  fs.writeFileSync(tar, buf);
  const dest = path.join(dir, 'x');
  fs.mkdirSync(dest);
  try {
    execFileSync('tar', ['-xzf', tar, '-C', dest], { stdio: 'pipe' });
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    const msg = String((e && e.stderr) || (e && e.message) || '');
    throw new Error('解包失败：' + msg.trim().split('\n').slice(-1)[0]);
  }
  fs.rmSync(tar, { force: true });

  /* 解包后的目录可能多一层（`tar czf x.tar.gz myplugin/` 很常见）—— 只要那一层里只有它自己，就进去 */
  let root = dest;
  const ent = fs.readdirSync(root, { withFileTypes: true });
  if (ent.length === 1 && ent[0].isDirectory()) root = path.join(root, ent[0].name);

  /* 路径穿越防护：解出来的东西必须都在这个目录里 */
  const real = fs.realpathSync(root);
  for (const rel of contract.walk(root)) {
    const p = fs.realpathSync(path.join(root, rel));
    if (p !== real && !p.startsWith(real + path.sep)) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new Error('包里有过界的路径：' + rel);
    }
  }
  return { dir, root, bytes: buf.length };
}

/** 一个插件能不能给"某类型栏目"挂导航入口 —— 有 webui 才行（见 docs/adr/0029 的已定 18） */
const webuiPath = (type, id) => `/api/plugins/${encodeURIComponent(type)}/${encodeURIComponent(id)}/ui/`;

function register(r) {
  r.add('GET', '/api/plugins', (req, res) => {
    const installed = store.list();
    const installedSid = new Set(installed.map((x) => store.sid(x.type, x.id)));
    const states = new Map(host.states().map((s) => [store.sid(s.type, s.id), s]));
    const rows = installed.map((x) => {
      const st = states.get(store.sid(x.type, x.id)) || {};
      return Object.assign({}, x, st, {
        webuiPath: x.hasWebui ? webuiPath(x.type, x.id) : '',
        dir: store.dirOf(x.type, x.id),
      });
    });
    /* 仓库里的内置插件：还没装的也列出来（让管理页显示"可安装"）—— 但**不自动装** */
    const builtins = store.listBuiltins().map((b) => {
      if (installedSid.has(store.sid(b.type, b.id))) return null;
      let m = null;
      try {
        m = contract.readManifest(b.dir);
      } catch {
        return null;
      }
      return { type: b.type, id: b.id, name: m.name, version: m.version, description: m.description, builtin: true };
    }).filter(Boolean);
    return sendJson(res, 200, { plugins: rows, builtins, types: contract.TYPES });
  });

  r.add('POST', '/api/plugins/install', async (req, res) => {
    const body = (await readBody(req)) || {};
    let tmp = null;
    try {
      tmp = extractToTemp(body.tarball, body.md5);
      const entry = store.installDir(tmp.root, { origin: 'upload', md5: String(body.md5 || ''), enabled: body.enable === true });
      console.log(`  ✔ 插件已安装 ${entry.type}/${entry.id} v${entry.version}（${entry.files} 个文件，${Math.round(entry.bytes / 1024)}KB）`);
      if (entry.enabled) host.start(entry.type, entry.id);
      return sendJson(res, 200, { plugin: Object.assign({}, entry, host.stateOf(entry.type, entry.id)) });
    } catch (e) {
      return sendError(res, 400, (e && e.message) || '安装失败');
    } finally {
      if (tmp) fs.rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  r.add('DELETE', '/api/plugins/:type/:id', (req, res, { params, query }) => {
    const { type, id } = params;
    if (!store.get(type, id)) return sendError(res, 404, '没有这个插件');
    host.stop(type, id);
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
     * 插件回 `{ status?, body }`（body 可以是对象或字符串），面板原样回给浏览器。 */
    const out = await host.call(
      params.type,
      params.id,
      'http',
      {
        method: req.method,
        path: '/' + String(params.rest || ''),
        query: query || {},
        body,
        contentType: String(req.headers['content-type'] || ''),
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
