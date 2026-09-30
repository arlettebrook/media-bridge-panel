'use strict';
/**
 * 插件契约：**类型、id 规则、声明文件（`plugin.json`）的形状与校验**。
 *
 * 唯一来源是 docs/plugin-contract.md；这里只做"能不能装"的机械校验。
 *
 * 包（目录形式，安装时是一个 tar.gz）：
 *   plugin.json     声明（本文件校验的对象）
 *   index.js        main（默认 index.js）
 *   ui/             可选：插件自己的 webui 静态文件
 *   data/           插件自己的数据 —— **由面板在安装时创建，包里不该有**
 *
 * `plugin.json`：
 *   id       必填，反向域名风格，**同一类型内唯一**（身份 = `(类型, id)`）
 *   name     必填，显示名
 *   author   可选，作者署名（插件库与管理页里显示；不写就不显示这一行）
 *   version  必填
 *   type     必填，metadata / source / home / output
 *   main     可选，入口文件名（默认 index.js）
 *   domain   元数据插件必填：**它注册的域 id**（就是条目 Id 的前缀，见 docs/adr/0031）
 *   series   元数据插件可选：剧集式（默认 true）还是电影式
 *   webui    可选：webui 入口（相对包目录，例如 ui/index.html）
 *   ingress  output 插件可选：**面板单端口入口（ingress）的访问声明**，形状：
 *              { "public": ["api/widget.js"], "token": ["api/**"] }
 *            · public：匿名可取（例如给外部播放器下载的 widget.js —— 程序本身不含秘密）；
 *            · token ：要带面板的**外部访问令牌**（query token / Bearer），面板 cookie 也算过。
 *            路径相对 `/api/plugins/<类型>/<id>/` 下的 `ui/`、`api/` 两段，支持结尾 `/**`。
 *            没声明的路径一律仍走面板登录门禁（与老插件行为一致）。
 *   files    可选：{ 相对路径: md5 } —— 给了就**逐文件核对**（第二道校验）
 *   depends  可选：依赖的域 id 或 `类型:id`，缺依赖**如实失败并点名**（不半启动）
 *   updateUrl 可选：插件**自更新清单**的地址（Magisk 式，见插件契约「自更新」节）。
 *            给了它，管理页就能一键检查 / 更新到这个地址声明的新版本；不给就只能走
 *            面板「插件库」或手动装。地址必须是 http(s)，清单 JSON 形状由 updater 校验。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TYPES = ['metadata', 'source', 'home', 'output'];
const ID_RE = /^[a-z][a-z0-9._-]{1,63}$/i;
const MAX_FILES = 512;
const MAX_BYTES = 16 * 1024 * 1024;

const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');

function fail(message) {
  const e = new Error(message);
  e.code = 'BAD_MANIFEST';
  return e;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/* -------------------------------------------------------------- ingress */

/** 一条 ingress 路径允许的字形：`ui/` 或 `api/` 开头，后跟常规路径字符与 `*` 通配 */
const INGRESS_PATTERN_RE = /^(?:ui|api)\/[A-Za-z0-9._\-/*]+$/;

/**
 * 归一化并校验 plugin.json 里的 `ingress`：
 *   { public?: string[], token?: string[] } → { public: string[], token: string[] }
 * 不给 ⇒ 两个空数组（该插件所有路径仍走面板登录门禁）。
 */
function normalizeIngress(raw) {
  const out = { public: [], token: [] };
  if (raw === undefined || raw === null) return out;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail('ingress 必须是对象：{ "public": [...], "token": [...] }');
  for (const bucket of ['public', 'token']) {
    const list = raw[bucket];
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list)) throw fail(`ingress.${bucket} 必须是字符串数组`);
    for (const one of list) {
      const p = String(one || '').trim();
      if (!INGRESS_PATTERN_RE.test(p) || p.includes('..')) {
        throw fail(`ingress.${bucket} 路径不合法：「${p}」（只允许 ui/ 或 api/ 下的相对路径，可结尾 /**）`);
      }
      out[bucket].push(p);
    }
  }
  return out;
}

/** glob → 正则：`/**` 匹配任意后缀（含斜杠），单个 `*` 不跨目录 */
function ingressGlobRe(pattern) {
  /* 顺序坑：先把 `/**` 换成占位符 —— 若直接换成 `/.*`，下面单星号那步会把
   * 替换结果里的 `*` 再变成 `[^/]*`，得到 `/.[^/]*`（只匹配一层目录，曾踩过）。 */
  const DQ = '␦'; // 占位符：合法路径里不会出现（白名单只收 [A-Za-z0-9._-/*]）
  const src = pattern
    .replace(/\/\*\*/g, DQ)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(new RegExp(DQ.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '/.*');
  return new RegExp('^' + src + '$');
}

/**
 * 一条实际请求的相对路径（`ui/widget.js` / `api/home/rows`）命中 ingress 名单吗。
 * 命中回 'public' / 'token'；都不命中回 ''（交给面板登录门禁）。
 * public 优先：同一条路径同时出现在两边时按匿名放行（声明成公开就是公开）。
 */
function ingressMatch(ingress, rel) {
  const ing = ingress || {};
  const hit = (list) => (Array.isArray(list) ? list.some((p) => ingressGlobRe(p).test(rel)) : false);
  if (hit(ing.public)) return 'public';
  if (hit(ing.token)) return 'token';
  return '';
}

/** 目录下所有文件的相对路径（跳过 data/ 与隐藏文件） */
function walk(dir, base = dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (ent.isDirectory()) {
      if (rel === 'data') continue; // 插件自己的数据不参与校验
      walk(full, base, out);
    } else {
      out.push(rel);
    }
  }
  return out;
}

/**
 * 校验一个解包后的插件目录。返回归一化后的声明；不合法就抛（`code = BAD_MANIFEST`）。
 *
 * 两道 md5 的**第二道**在这里：声明里给了 `files` 就逐个核对（第一道是包的 md5，在安装入口做）。
 * 对不上就报出来 —— 不留半成品、也不"拿实际值覆写清单"假装成功。
 */
function readManifest(dir) {
  const file = path.join(dir, 'plugin.json');
  let raw;
  try {
    raw = readJson(file);
  } catch (e) {
    throw fail('读不到 plugin.json：' + ((e && e.message) || e));
  }
  if (!raw || typeof raw !== 'object') throw fail('plugin.json 必须是一个对象');

  const id = String(raw.id || '').trim();
  if (!ID_RE.test(id)) throw fail(`id 不合法：「${id || '(空)'}」（字母开头，字母数字与 . _ -，2~64 位）`);
  const name = String(raw.name || '').trim();
  if (!name) throw fail('缺少 name（显示名）');
  const version = String(raw.version || '').trim();
  if (!version) throw fail('缺少 version');
  const type = String(raw.type || '').trim();
  if (!TYPES.includes(type)) throw fail(`type 必须是 ${TYPES.join(' / ')}，实际是「${type || '(空)'}」`);
  const main = String(raw.main || 'index.js').trim();
  const mainFile = path.join(dir, main);
  if (!fs.existsSync(mainFile)) throw fail(`入口文件不存在：${main}`);

  let domain = '';
  if (type === 'metadata') {
    domain = String(raw.domain || '').trim();
    if (!/^[a-z][a-z0-9]*$/i.test(domain)) {
      throw fail(`元数据插件必须声明 domain（域 id，就是条目 Id 的前缀）：「${domain || '(空)'}」不合法`);
    }
  }
  const webui = String(raw.webui || '').trim();
  if (webui && !fs.existsSync(path.join(dir, webui))) throw fail(`webui 入口不存在：${webui}`);

  /* 自更新清单地址（可选）：只收 http(s) —— 这是面板要主动去 GET 的外部地址，
   * 不许 file:// / 内网协议头从插件清单里混进来。 */
  const updateUrl = String(raw.updateUrl || '').trim();
  if (updateUrl && !/^https?:\/\//i.test(updateUrl)) throw fail('updateUrl 必须是 http(s) 地址');

  /* ingress 声明（output 插件用；别的类型给了也不报错——它只是个网关路径名单）。
   * 只允许相对 `ui/` 与 `api/` 两段的路径，防止有人写 `../` 之类想绕开门禁。 */
  const ingress = normalizeIngress(raw.ingress);

  /* 逐文件核对（第二道 md5）：只核**声明里列出的**那些 —— 没列的不算错，
   * 但列了就必须一致（发布方与使用方对"这个包里是什么"达成一致的地方）。 */
  const files = raw.files && typeof raw.files === 'object' ? raw.files : null;
  if (files) {
    for (const [rel, want] of Object.entries(files)) {
      const p = path.join(dir, rel);
      if (!fs.existsSync(p)) throw fail(`清单里声明的文件不存在：${rel}`);
      const got = md5(fs.readFileSync(p));
      if (got !== String(want).toLowerCase()) {
        throw fail(`文件校验不过：${rel}（清单 ${String(want).slice(0, 12)}… 实际 ${got.slice(0, 12)}…）`);
      }
    }
  }

  return {
    id,
    name,
    author: String(raw.author || '').trim(),
    version,
    type,
    main,
    mainFile,
    domain,
    series: raw.series !== false,
    webui,
    webuiFile: webui ? path.join(dir, webui) : '',
    ingress,
    updateUrl,
    depends: Array.isArray(raw.depends) ? raw.depends.map((x) => String(x)) : [],
    description: String(raw.description || '').trim(),
  };
}

/** 目录内容的指纹（按文件路径 + 大小 + md5）—— 用来判断内置插件要不要重装 */
function dirDigest(dir) {
  const files = walk(dir).sort();
  if (files.length > MAX_FILES) throw fail(`包内文件太多（${files.length} > ${MAX_FILES}）`);
  let total = 0;
  const parts = [];
  for (const rel of files) {
    const buf = fs.readFileSync(path.join(dir, rel));
    total += buf.length;
    if (total > MAX_BYTES) throw fail(`包太大（超过 ${Math.round(MAX_BYTES / 1024 / 1024)}MB）`);
    parts.push(rel + ':' + buf.length + ':' + md5(buf));
  }
  return { digest: md5(Buffer.from(parts.join('\n'), 'utf8')), files: files.length, bytes: total };
}

module.exports = { TYPES, ID_RE, MAX_FILES, MAX_BYTES, md5, fail, walk, readManifest, dirDigest, normalizeIngress, ingressMatch };
