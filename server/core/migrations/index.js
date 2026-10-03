'use strict';
/**
 * 数据迁移框架（见 docs/adr/0047）。
 *
 * 三件事：
 *   ① 版本标记：`data/.data-version`（整数；缺失 = v1）。代码侧 `CURRENT_DATA_VERSION`。
 *   ② 启动门禁：`evaluate()` 给出三态 —— 相等正常启动；落后进迁移模式（不起业务、
 *      其余 /api 一律 503 MIGRATION_REQUIRED）；超前只给"强制启动"（只改版本号不转数据）。
 *   ③ 串行 runner：任务在 `./tasks/NNNN-*.js`，每个任务含若干**幂等**步骤，
 *      任务整体完成才升提交点（版本号），状态落 `data/migration-state.json` 支持断点续跑。
 *
 * 本模块不认识任何业务模块；任务文件自己知道怎么动数据。
 */
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../paths');

/** 当前代码认得的数据版本。升过点之后 +1 并在 tasks/ 下补一个任务 */
const CURRENT_DATA_VERSION = 2;
/** 最早的、没有标记文件的版本 */
const FIRST_VERSION = 1;

const VERSION_FILE = path.join(DATA_DIR, '.data-version');
const STATE_FILE = path.join(DATA_DIR, 'migration-state.json');

/* -------------------------------------------------------------- 版本标记 */

function readVersion() {
  let txt = '';
  try {
    txt = fs.readFileSync(VERSION_FILE, 'utf8').trim();
  } catch {
    return FIRST_VERSION; // 没有标记文件 = 最初版本（见 docs/adr/0047）
  }
  const n = Number(txt);
  return Number.isInteger(n) && n >= 1 ? n : FIRST_VERSION;
}

function writeVersion(n) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = VERSION_FILE + '.tmp';
  fs.writeFileSync(tmp, String(n));
  fs.renameSync(tmp, VERSION_FILE);
}

/* -------------------------------------------------------------- 任务装载 */

/** 任务表：`tasks/NNNN-*.js`，文件名序号 = 它升到的版本号，缺号拒启 */
function loadTasks() {
  const dir = path.join(__dirname, 'tasks');
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}-.+\.js$/.test(f))
    .sort();
  const tasks = files.map((f) => {
    const t = require(path.join(dir, f));
    const want = Number(f.slice(0, 4));
    if (!t || Number(t.version) !== want) {
      throw new Error(`迁移任务版本号与文件名对不上：${f} 声明的是 ${t && t.version}`);
    }
    if (!Array.isArray(t.steps) || !t.steps.length) throw new Error(`迁移任务 ${f} 没有步骤`);
    t.steps.forEach((s, i) => {
      if (!s || typeof s.run !== 'function') throw new Error(`迁移任务 ${f} 第 ${i + 1} 步没有 run()`);
    });
    return t;
  });
  /* 缺号 / 重号拒启：迁移链路断了一个还照跑，数据版本就是一笔糊涂账 */
  let expect = FIRST_VERSION + 1;
  for (const t of tasks) {
    if (t.version !== expect) {
      throw new Error(`迁移任务缺号或乱序：该有升到 v${expect} 的任务，实际看到 v${t.version}`);
    }
    expect += 1;
  }
  return tasks;
}

let TASKS = null;
function tasks() {
  if (!TASKS) TASKS = loadTasks();
  return TASKS;
}

/* -------------------------------------------------------------- 运行状态 */

function readState() {
  try {
    const v = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (v && typeof v === 'object') return v;
  } catch {
    /* 没有 / 读坏了 = 没跑过 */
  }
  return { tasks: {}, overrides: [] };
}

function writeState(s) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function blankTaskView(t) {
  return {
    version: t.version,
    title: t.title || `升级到 v${t.version}`,
    irreversible: !!t.irreversible,
    status: 'pending', // pending / running / done / failed
    error: '',
    steps: t.steps.map((s) => ({ name: s.name || '步骤', status: 'pending', error: '' })),
  };
}

/* -------------------------------------------------------------- 门禁评估 */

/**
 * 评估当前数据处于哪一态。
 *   ok       数据版本 == 代码版本，正常启动
 *   migrate  数据落后，前端只给迁移向导
 *   ahead    数据来自更新的代码，只给"强制启动"（不转数据）
 *
 * 顺手把状态文件里残留的 running（上次跑到一半进程死了）重置成 pending ——
 * 步骤是幂等的，重跑时已 done 的步骤会跳过。
 */
let memo = null;
/** 门禁状态。force 时重算（向导刷状态用）；平时吃缓存 —— 每请求重算预检太贵 */
function evaluate(force = false) {
  if (memo && !force) return memo;
  const dataVersion = readVersion();
  const state = readState();
  state.tasks = state.tasks || {};

  if (dataVersion === CURRENT_DATA_VERSION) {
    memo = { phase: 'ok', dataVersion, currentVersion: CURRENT_DATA_VERSION, tasks: [] };
    return memo;
  }

  if (dataVersion > CURRENT_DATA_VERSION) {
    memo = { phase: 'ahead', dataVersion, currentVersion: CURRENT_DATA_VERSION, tasks: [] };
    return memo;
  }

  /* 落后：把 (dataVersion, CURRENT_DATA_VERSION] 区间内的任务列出来，状态照 state 文件复原 */
  const views = [];
  for (const t of tasks()) {
    if (t.version <= dataVersion || t.version > CURRENT_DATA_VERSION) continue;
    const saved = state.tasks[String(t.version)] || {};
    const view = blankTaskView(t);
    if (saved.status === 'done') view.status = 'done';
    else if (saved.status === 'failed') {
      view.status = 'failed';
      view.error = String(saved.error || '');
    }
    else view.status = 'pending'; // running / pending 一律回到 pending（重进向导就是重新跑）
    if (Array.isArray(saved.steps)) {
      saved.steps.forEach((ss, i) => {
        if (view.steps[i] && ss && ss.status === 'done') view.steps[i].status = 'done';
      });
    }
    /* 预检信息（只读；冲突项之类向导要就地处置） */
    if (typeof t.precheck === 'function') {
      try {
        view.precheck = t.precheck() || null;
      } catch (e) {
        view.precheck = { error: (e && e.message) || String(e) };
      }
    }
    views.push(view);
  }
  memo = { phase: 'migrate', dataVersion, currentVersion: CURRENT_DATA_VERSION, tasks: views };
  return memo;
}

/**
 * 预检里有没有**需要人工决定**的事（见 docs/adr/0047 第 4 节）：
 *   ① 同名插件冲突（同 id 多包，得先定删哪个）；
 *   ② 某任务的预检本身报错（盘上状态读不出来，得有人看一眼）。
 * 两者都没有 = 可以静默跑完；server.js 启动时就按这个判定决定要不要自动迁移。
 */
function needsDecision() {
  const g = evaluate();
  if (g.phase !== 'migrate') return false; // ok / ahead 都不在自动迁移的射程内
  for (const t of g.tasks || []) {
    const pc = t.precheck;
    if (pc && pc.error) return true;
    if (pc && Array.isArray(pc.conflicts) && pc.conflicts.length) return true;
  }
  return false;
}

/* -------------------------------------------------------------- 执行 */

let running = false;
/** 业务启动回调：迁移在进程内跑完后由 server.js 注入，跑完直接在本进程拉起业务（不依赖重启） */
let bootBusiness = null;
function onReady(fn) {
  bootBusiness = fn;
}

/**
 * 跑完所有待执行任务。payload 原样交给每个任务（向导收集的决定，如冲突包删除名单）。
 * 串行：任务内步骤一个个来，任务之间也一个个来。
 * @returns {Promise<{phase:string, ran:number[]}>}
 */
async function run(payload = {}) {
  memo = null;
  const g = evaluate();
  if (g.phase !== 'migrate') return { phase: g.phase, ran: [] };
  if (running) throw httpError(409, '已经有迁移在跑了');
  /* ⚠️ 互斥量用布尔量、工作体直接写在本 async 函数里：
   * 别写成 `runningNow = (async()=>{ finally{runningNow=null} })()` —— 当任务在首个
   * 真实 await 之前就同步抛错时，IIFE 的 finally 会在外层赋值**之前**执行，
   * null 立刻又被外层赋值（rejected promise）盖回去，后续请求永远 409。 */
  running = true;
  const state = readState();
  state.tasks = state.tasks || {};
  const ran = [];
  try {
    for (const t of tasks()) {
      if (t.version <= readVersion() || t.version > CURRENT_DATA_VERSION) continue;
      const view = g.tasks.find((x) => x.version === t.version) || blankTaskView(t);
      const rec = (state.tasks[String(t.version)] = state.tasks[String(t.version)] || { steps: [] });
      rec.steps = rec.steps || [];
      rec.status = 'running';
      rec.error = '';
      writeState(state);

      const ctx = { DATA_DIR, taskVersion: t.version };
      for (let i = 0; i < t.steps.length; i += 1) {
        const step = t.steps[i];
        if (rec.steps[i] && rec.steps[i].status === 'done') continue; // 断点续跑：幂等步骤已完成就跳过
        try {
          await step.run(ctx, payload);
        } catch (e) {
          rec.steps[i] = { name: step.name, status: 'failed', error: (e && e.message) || String(e) };
          rec.status = 'failed';
          rec.error = (e && e.message) || String(e);
          writeState(state);
          throw e;
        }
        rec.steps[i] = { name: step.name, status: 'done', error: '' };
        writeState(state); // 每步落盘：跑到哪一步死的，重启后从下一步继续
      }

      /* 提交点：**任务整体完成**才升版本号（见 docs/adr/0047） */
      writeVersion(t.version);
      rec.status = 'done';
      rec.error = '';
      writeState(state);
      ran.push(t.version);
    }
    /* 全部完成：先重算门禁缓存 —— 不刷新的话 memo 还停在开跑时的 migrate，
     * 本进程后续请求会继续吃 503（只有重启才恢复，见 adr/0047 的 in-place 完成口径）。 */
    memo = null;
    evaluate();
    /* 然后在本进程内把业务拉起来（不依赖 docker restart） */
    if (typeof bootBusiness === 'function') {
      try {
        await bootBusiness();
      } catch (e) {
        console.error('  ✘ 迁移完成后的业务启动失败：' + ((e && e.message) || e));
      }
    }
    return { phase: 'ok', ran };
  } finally {
    running = false;
  }
}

/**
 * 超前启动：数据版本比代码新。**只改版本号、不转数据**，勾选知悉后才允许。
 * 留痕一条 override 记录（谁、从哪版、按到哪版、何时）。
 */
async function override() {
  memo = null;
  const g = evaluate();
  if (g.phase !== 'ahead') return { phase: g.phase };
  const state = readState();
  state.overrides = Array.isArray(state.overrides) ? state.overrides : [];
  state.overrides.push({ type: 'override', from: g.dataVersion, to: g.currentVersion, at: new Date().toISOString() });
  writeState(state);
  writeVersion(g.currentVersion);
  memo = null;
  evaluate(); // 同 run：立刻解除本进程门禁
  if (typeof bootBusiness === 'function') {
    try {
      await bootBusiness();
    } catch (e) {
      console.error('  ✘ 强制启动后的业务启动失败：' + ((e && e.message) || e));
    }
  }
  return { phase: 'ok' };
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/* -------------------------------------------------------------- 路由 */

/**
 * 迁移模式下仅有的几条 API：
 *   GET  /api/migration/status   门禁状态 + 任务清单 + 预检结果
 *   POST /api/migration/run      执行迁移（body 是向导收集的决定，原样交给任务）
 *   POST /api/migration/override 超前时强制启动
 * 都在 /api/ 下，**仍受面板登录门禁**。
 */
function registerRoutes(router) {
  const { sendJson, sendError, readBody } = require('../http');
  router.add('GET', '/api/migration/status', (req, res) => sendJson(res, 200, evaluate(true)));
  router.add('POST', '/api/migration/run', async (req, res) => {
    let body = {};
    try {
      body = await readBody(req);
    } catch (e) {
      return sendError(res, 400, (e && e.message) || '请求体不合法');
    }
    try {
      const out = await run(body || {});
      return sendJson(res, 200, Object.assign({ ok: true }, out));
    } catch (e) {
      return sendJson(res, e.status || 500, { error: (e && e.message) || '迁移失败' });
    }
  });
  router.add('POST', '/api/migration/override', async (req, res) => {
    try {
      const out = await override();
      return sendJson(res, 200, Object.assign({ ok: true }, out));
    } catch (e) {
      return sendJson(res, e.status || 500, { error: (e && e.message) || '强制启动失败' });
    }
  });
}

module.exports = {
  CURRENT_DATA_VERSION,
  FIRST_VERSION,
  VERSION_FILE,
  STATE_FILE,
  readVersion,
  writeVersion,
  evaluate,
  /** 只要相位（请求门禁用；吃缓存，不跑预检） */
  phase: () => evaluate().phase,
  /** 预检里有没有要人决定的事（server.js 启动时的静默迁移判定） */
  needsDecision,
  run,
  override,
  onReady,
  registerRoutes,
};
