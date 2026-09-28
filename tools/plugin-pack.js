#!/usr/bin/env node
'use strict';
/**
 * 打包插件：把仓库里的 `plugins/<类型>/<id>/` 打成插件包，并生成插件仓库的清单。
 *
 * 用法：
 *   node tools/plugin-pack.js --out <插件仓库的工作目录>
 *
 * 产物（写进 `--out`，**`.git` 一概不碰**）：
 *   index.json                                     清单（面板「插件库」拉的就是它）
 *   packages/<类型>/<id>/<id>-<版本>.tar.gz          包本体
 *
 * 为什么要"注入 files"：包内 `plugin.json` 的 `files` 是**第二道校验**（逐文件 md5），
 * 面板安装时按它对包里的每个文件核一遍（见 docs/plugin-contract.md 第二节）。
 * 源码里不写这个字段 —— 写死 md5 会让每次改代码都要手改一处；改由这里在打包时算出来，
 * 只写进**包里那一份** `plugin.json`。
 *
 * 清单结构与仓库约定见 docs/plugin-contract.md 第七节。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const contract = require('../server/modules/plugin/contract');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'plugins');

/** 清单结构版本（与 server/modules/plugin/library.js 的 SCHEMA 是同一个数） */
const SCHEMA = 1;

const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');

/* -------------------------------------------------------------- 参数与目录 */

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? String(process.argv[i + 1] || '').trim() : '';
}

/** 仓库里所有插件目录：`plugins/<类型>/<id>/`（有 plugin.json 才算） */
function listSources() {
  const out = [];
  if (!fs.existsSync(SRC)) return out;
  for (const t of fs.readdirSync(SRC, { withFileTypes: true })) {
    if (!t.isDirectory() || !contract.TYPES.includes(t.name)) continue;
    const typeDir = path.join(SRC, t.name);
    for (const one of fs.readdirSync(typeDir, { withFileTypes: true })) {
      if (!one.isDirectory()) continue;
      const dir = path.join(typeDir, one.name);
      if (!fs.existsSync(path.join(dir, 'plugin.json'))) continue;
      out.push({ type: t.name, dirName: one.name, dir });
    }
  }
  return out;
}

/** 复制一份包内容：**跳过 `data/` 与隐藏文件**（与 `contract.walk` 同一套口径） */
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
    if (ent.name.startsWith('.') || ent.name === 'data') continue;
    const a = path.join(from, ent.name);
    const b = path.join(to, ent.name);
    if (ent.isDirectory()) copyTree(a, b);
    else fs.copyFileSync(a, b);
  }
}

/* ------------------------------------------------------------------ 打一个包 */

/**
 * 打一个插件包。返回清单条目。
 *
 * ⚠️ 先用 `contract.readManifest` **校验源码目录**：包要是连契约都过不了，
 * 就不该被打出来（更不该进清单 —— 面板装了也会当场拒绝）。
 */
function packOne(one, outRoot, tmpRoot) {
  const m = contract.readManifest(one.dir); // 校验（id / name / version / type / main / webui / domain…）

  const stage = path.join(tmpRoot, `${m.type}-${m.id}`);
  fs.rmSync(stage, { recursive: true, force: true });
  copyTree(one.dir, stage);

  /* 第二道校验：算包里每个文件的 md5，写进包内那一份 plugin.json。
   * `plugin.json` 自己不算（无法自校验），这也正是契约里 `files` 的口径。 */
  const files = {};
  for (const rel of contract.walk(stage)) {
    if (rel === 'plugin.json') continue;
    files[rel] = md5(fs.readFileSync(path.join(stage, rel)));
  }
  const declared = JSON.parse(fs.readFileSync(path.join(stage, 'plugin.json'), 'utf8'));
  declared.files = files;
  fs.writeFileSync(path.join(stage, 'plugin.json'), JSON.stringify(declared, null, 2) + '\n');

  const rel = `packages/${m.type}/${m.id}/${m.id}-${m.version}.tar.gz`;
  const target = path.join(outRoot, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  /* `-C <stage> .` ⇒ 包内顶层就是包内容（不套一层插件目录名） */
  execFileSync('tar', ['-czf', target, '-C', stage, '.'], { stdio: 'pipe' });

  const buf = fs.readFileSync(target);
  fs.rmSync(stage, { recursive: true, force: true });

  return {
    type: m.type,
    id: m.id,
    name: m.name,
    version: m.version,
    description: m.description,
    domain: m.domain,
    hasWebui: !!m.webui,
    depends: m.depends,
    bytes: buf.length,
    md5: md5(buf),
    path: rel,
    /* 顺带给打包时看的两个数（不进清单 —— 清单的字段由契约规定，不塞私有字段） */
    _files: Object.keys(files).length + 1,
    _dirName: one.dirName,
  };
}

/* ---------------------------------------------------------------------- 主 */

function main() {
  const outArg = argValue('--out');
  if (!outArg) {
    console.error('用法：node tools/plugin-pack.js --out <插件仓库的工作目录>');
    process.exit(2);
  }
  const outRoot = path.resolve(outArg);
  fs.mkdirSync(outRoot, { recursive: true });

  /* 一次干净重建：产物是确定性的（同样的源码 ⇒ 同样的包与清单），
   * 所以先把上一次的 packages/ 与 index.json 清掉，不留孤儿包。 */
  fs.rmSync(path.join(outRoot, 'packages'), { recursive: true, force: true });
  fs.rmSync(path.join(outRoot, 'index.json'), { force: true });

  const sources = listSources();
  if (!sources.length) {
    console.error(`没有找到任何插件：${path.relative(ROOT, SRC)}/<类型>/<id>/plugin.json`);
    process.exit(1);
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-pack-'));
  const entries = [];
  try {
    for (const one of sources) entries.push(packOne(one, outRoot, tmpRoot));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
  entries.sort((a, b) => (a.type === b.type ? a.id.localeCompare(b.id) : a.type.localeCompare(b.type)));

  const plugins = entries.map(({ _files, _dirName, ...x }) => x);
  const index = { schema: SCHEMA, generatedAt: new Date().toISOString(), plugins };
  fs.writeFileSync(path.join(outRoot, 'index.json'), JSON.stringify(index, null, 2) + '\n');

  /* 一张能扫一眼的表：类型 / id / 版本 / 文件数 / 字节 / 包 md5 前 8 位 */
  console.log(`\n插件仓库产物 → ${outRoot}\n`);
  for (const e of entries) {
    if (e._dirName !== e.id) console.log(`  ⚠ 目录名与 plugin.json 的 id 不一致：${e.type}/${e._dirName} → ${e.id}`);
    console.log(`  ${e.type.padEnd(9)} ${e.id.padEnd(10)} v${String(e.version).padEnd(8)} ${String(e._files).padStart(3)} 文件  ${String(e.bytes).padStart(8)}B  md5 ${e.md5.slice(0, 8)}…`);
  }
  console.log(`\n  共 ${entries.length} 个插件 → index.json + packages/`);
}

main();