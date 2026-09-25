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
 *   version  必填
 *   type     必填，metadata / source / home
 *   main     可选，入口文件名（默认 index.js）
 *   domain   元数据插件必填：**它注册的域 id**（就是条目 Id 的前缀，见 docs/adr/0031）
 *   series   元数据插件可选：剧集式（默认 true）还是电影式
 *   webui    可选：webui 入口（相对包目录，例如 ui/index.html）
 *   files    可选：{ 相对路径: md5 } —— 给了就**逐文件核对**（第二道校验）
 *   depends  可选：依赖的域 id 或 `类型:id`，缺依赖**如实失败并点名**（不半启动）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TYPES = ['metadata', 'source', 'home'];
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
    version,
    type,
    main,
    mainFile,
    domain,
    series: raw.series !== false,
    webui,
    webuiFile: webui ? path.join(dir, webui) : '',
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

module.exports = { TYPES, ID_RE, MAX_FILES, MAX_BYTES, md5, fail, walk, readManifest, dirDigest };
