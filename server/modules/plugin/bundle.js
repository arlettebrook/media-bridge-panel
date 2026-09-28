'use strict';
/**
 * 插件包的**解包与安全校核**：安装入口（手动上传）与「插件库」共用这一处。
 *
 * 两道 md5 的**第一道**在这里做（包本身的 md5 —— 发布方给的那个，可省）；
 * 第二道（清单里 `files` 的逐文件核对）在 `store.installDir` → `contract.readManifest` 里。
 *
 * 解出来的东西**必须都在临时目录内**：包是外部来的（插件库那条更是从远端拉的），
 * 一个 `../` 就能写到目录外面去，所以逐个 realpath 核一遍。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const contract = require('./contract');

/**
 * 把包（tar.gz 的字节）解到临时目录，返回该目录（**调用方负责删 `dir`**）。
 *
 * `expectMd5` = 发布方给的包 md5 —— 对不上当场拒绝，既不"先装上再说"，
 * 也不拿实际值去覆写清单假装成功（与源包的做法一致，见 docs/adr/0015）。
 */
function extractToTemp(buf, expectMd5) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw new Error('没有拿到包内容');
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

module.exports = { extractToTemp };