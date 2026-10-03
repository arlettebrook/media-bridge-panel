'use strict';
/**
 * v2：插件多类型（docs/adr/0046）配套的数据拍平。
 *
 * 旧布局                新布局
 *   plugins/<类型>/<id>/   plugins/<id>/
 *   registry: {type,...}   registry: {types:[...],...}
 *
 * 步骤（每步幂等，整任务完成才提交版本号，见 docs/adr/0047）：
 *   1. resolve-conflicts  旧布局里同 id 可在多个类型下各装一份（三个单类型包同名）。
 *                         新布局 id 全局唯一、目录只有一个，向导里必须先决定**删掉**哪些
 *                         （合并包迁移后再从插件库装）。本步按名单删目录 + 清单条目，
 *                         并把清单备份成 registry.json.bak-pre-v2。
 *   2. flatten-dirs       其余条目 <类型>/<id>/ 改名 <id>/（已在新位置的跳过）。
 *   3. rewrite-registry   每条删 `type`、加 `types:[type]`；webui 字符串入口转成 `{类型:入口}`。
 *   4. cleanup-type-dirs  删掉空掉的四个类型目录。
 *
 * ⚠️ 这个文件直接读写**旧形状**的 registry.json，不走 modules/plugin/store.js ——
 * 那一层在本任务执行前后只认新形状，迁移期借不得。
 */
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../../paths');

const TYPES = ['metadata', 'source', 'home', 'output'];
const PROOT = path.join(DATA_DIR, 'plugins');
const REGISTRY = path.join(PROOT, 'registry.json');
const BACKUP = path.join(PROOT, 'registry.json.bak-pre-v2');

function readRegistryRaw() {
  let raw;
  try {
    raw = fs.readFileSync(REGISTRY, 'utf8');
  } catch (e) {
    /* 全新安装还没有清单（面板侧读缺失文件同样按空清单，见 plugin/store.js）：
     * 这里必须跟着空，否则新装的盘会卡在迁移模式里出不来。 */
    if (e && e.code === 'ENOENT') return [];
    throw new Error('读不到 registry.json：' + ((e && e.message) || e));
  }
  let v;
  try {
    v = JSON.parse(raw);
  } catch (e) {
    throw new Error('registry.json 不是合法 JSON：' + ((e && e.message) || e));
  }
  if (!Array.isArray(v)) throw new Error('registry.json 不是数组，无法迁移');
  return v;
}

function writeRegistryRaw(arr) {
  fs.mkdirSync(path.dirname(REGISTRY), { recursive: true });
  const tmp = REGISTRY + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(arr, null, 2));
  fs.renameSync(tmp, REGISTRY);
}

/** 递归判断一个目录里有没有文件（只有空目录也算空）。不存在 = 空。 */
function hasAnyFile(dir) {
  let st;
  try {
    st = fs.statSync(dir);
  } catch {
    return false;
  }
  if (!st.isDirectory()) return true;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (hasAnyFile(p)) return true;
    } else return true;
  }
  return false;
}

function sizeOf(p) {
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.size;
  let n = 0;
  for (const ent of fs.readdirSync(p, { withFileTypes: true })) n += sizeOf(path.join(p, ent.name));
  return n;
}

/** 预检：把同 id 多包的冲突组找出来（只读，不动盘） */
function precheck() {
  const arr = readRegistryRaw();
  const groups = new Map();
  for (const x of arr) {
    if (!x || !x.id) continue;
    const key = String(x.id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(x);
  }
  const conflicts = [];
  for (const [id, items] of groups) {
    if (items.length < 2) continue;
    conflicts.push({
      id,
      items: items.map((x) => {
        const dir = path.join(PROOT, String(x.type), String(x.id));
        const dataDir = path.join(dir, 'data');
        return {
          type: String(x.type || ''),
          id,
          name: String(x.name || x.id),
          version: String(x.version || ''),
          dirExists: fs.existsSync(dir),
          dataEmpty: !hasAnyFile(dataDir),
          dataBytes: sizeOf(dataDir),
        };
      }),
    });
  }
  /* 已经拍平过的目录（断点重跑时）：不算冲突，只报个数 */
  let flattened = 0;
  for (const x of arr) {
    if (x && fs.existsSync(path.join(PROOT, String(x.id)))) flattened += 1;
  }
  return { conflicts, total: arr.length, flattened };
}

module.exports = {
  version: 2,
  title: '插件目录拍平 + 清单改 types（多类型插件）',
  irreversible: true,
  precheck,
  steps: [
    {
      name: '按向导决定删除同 id 的冲突插件，并备份清单',
      run(ctx, payload) {
        void ctx;
        /* 清单先留一份（已存在就不覆盖：断点重跑不抹掉最初那份） */
        if (!fs.existsSync(BACKUP) && fs.existsSync(REGISTRY)) {
          fs.copyFileSync(REGISTRY, BACKUP);
        }
        let arr = readRegistryRaw();

        /* 同 id 多包 = 必须先解决的冲突。向导传 removeConflicts:[{type,id}…] */
        const dupIds = new Set();
        const count = new Map();
        for (const x of arr) {
          if (!x || !x.id) continue;
          count.set(x.id, (count.get(x.id) || 0) + 1);
        }
        for (const [id, n] of count) if (n > 1) dupIds.add(String(id));

        const remove = Array.isArray(payload && payload.removeConflicts) ? payload.removeConflicts : [];
        const removeSet = new Set(remove.map((r) => `${String(r.type)}\u0001${String(r.id)}`));

        for (const [type, id] of [...removeSet].map((s) => s.split('\u0001'))) {
          const dir = path.join(PROOT, type, id);
          fs.rmSync(dir, { recursive: true, force: true });
          arr = arr.filter((x) => !(x && String(x.type) === type && String(x.id) === id));
        }
        writeRegistryRaw(arr);

        /* 名单之外仍有同 id 多包：不替用户猜，直接点名 */
        const left = precheck().conflicts;
        if (left.length) {
          const names = left
            .map((g) => `${g.id}：${g.items.map((i) => i.type).join(' / ')}`)
            .join('；');
          throw new Error(`还有同 id 插件未决定保留哪一个（新布局里一个 id 只能有一个目录）：${names}`);
        }
      },
    },
    {
      name: '插件目录拍平：plugins/<类型>/<id>/ → plugins/<id>/',
      run() {
        const arr = readRegistryRaw();
        for (const x of arr) {
          if (!x || !x.id || !x.type) continue;
          const from = path.join(PROOT, String(x.type), String(x.id));
          const to = path.join(PROOT, String(x.id));
          const fromExists = fs.existsSync(from);
          const toExists = fs.existsSync(to);
          if (!fromExists && toExists) continue; // 上次跑已经挪过了
          if (fromExists && toExists) {
            throw new Error(`拍平 ${x.type}/${x.id} 时目标目录已存在：plugins/${x.id}（需要人工确认后再继续）`);
          }
          if (!fromExists) continue; // 包本体本来就不在（只有清单条目）；新目录随安装建
          fs.renameSync(from, to);
        }
      },
    },
    {
      name: '重写 registry.json：type → types:[type]，webui 字符串 → {类型:入口}',
      run() {
        const arr = readRegistryRaw();
        const out = arr.map((x) => {
          if (!x || typeof x !== 'object') return x;
          const rest = Array.isArray(x.types) ? Object.assign({}, x) : (() => {
            const { type, ...r } = x;
            r.types = TYPES.includes(type) ? [type] : [String(type)];
            return r;
          })();
          /* v1 清单的 webui 是字符串入口；v2 路由按 {类型:入口} map 取，
           * 不转的话旧插件升级后侧栏入口全丢（空串 = 本来就没有 webui）。 */
          if (typeof rest.webui === 'string') {
            const entry = rest.webui.trim();
            rest.webui = entry ? { [rest.types[0]]: entry } : {};
          }
          return rest;
        });
        writeRegistryRaw(out);
      },
    },
    {
      name: '删除空掉的类型目录',
      run() {
        for (const t of TYPES) {
          const dir = path.join(PROOT, t);
          let st;
          try {
            st = fs.statSync(dir);
          } catch {
            continue;
          }
          if (!st.isDirectory()) continue;
          let nonEmpty = false;
          for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            if (ent.name.startsWith('.')) continue;
            nonEmpty = true;
            break;
          }
          /* 非空只可能是漏迁的东西：不删，留着让人看见 */
          if (!nonEmpty) fs.rmdirSync(dir);
        }
      },
    },
  ],
};
