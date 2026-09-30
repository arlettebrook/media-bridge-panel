'use strict';
/**
 * 插件宿主：**每个插件一个常驻子进程**，面板通过**管道**（child IPC）与它通话。
 *
 * 这是 docs/plugin-contract.md 与 docs/adr/0028 / 0029 落到代码上的那一层，只干四件事：
 *
 *   ① 起停：`spawn` 一个常驻进程（入口是 `runner.js`），把它的 stdout/stderr 转进面板日志；
 *   ② 通话：`call(type, id, action, args)` —— 发 `{ id, action, args }`，等 `{ id, ok, … }`，
 *      带**每次调用的超时**（超时**不杀进程**：插件慢不等于它坏了）；
 *   ③ 看护：进程自己退出只**如实记账**（状态转 `stopped`、退出码写进 `lastError` 并进日志）——
 *      **不自动重启**：崩了就崩了，想让它继续跑就回管理页点「启动」；
 *   ④ 观测：状态（在不在跑、pid、最近一次错误）。
 *
 * ⚠️ "面板停、插件就停"由**宿主**保证：`stopAll()` 直接终止子进程，不依赖插件配合
 * （插件**自己**再起的实例，仍由它在收到停止指令时自行清理 —— 见契约里的 `shutdown` 义务）。
 *
 * ⚠️ 不沙箱：插件能读写自己的目录、能联网、能起进程。权限前提与风险见 docs/adr/0028。
 */
const path = require('path');
const { spawn } = require('child_process');
const store = require('./store');
const contract = require('./contract');
const hostApi = require('./host-api');

/** 每次调用插件的默认超时（毫秒）。插件慢不等于坏，所以超时只影响**这一次**调用 */
const DEFAULT_CALL_TIMEOUT_MS = 20000;
/** 启动后多久还没报 ready 就当起不来（进程会留着，但状态标成"没就绪"） */
const READY_TIMEOUT_MS = 15000;
/** SIGKILL 之后还愿意等多久（等不到就放弃等待，不无限挂着调用方） */
const KILL_GRACE_MS = 2000;

/** sid → 运行态 */
const running = new Map();

const keyOf = (type, id) => store.sid(type, id);
const logTag = (type, id) => `[plugin:${type}/${id}]`;

function log(line) {
  console.log('  ' + line);
}

/**
 * 起一个插件进程。已经在跑的**不重复起**（返回现有那份状态）。
 * 返回 `{ ok, state }`；起不来的原因如实写在 `state.lastError` 里。
 */
function start(type, id) {
  const entry = store.get(type, id);
  if (!entry) return { ok: false, error: `没有这个插件：${type}/${id}` };

  const sid = keyOf(type, id);
  const cur = running.get(sid);
  if (cur && cur.proc && cur.proc.exitCode === null) return { ok: true, state: stateOf(type, id) };

  let manifest;
  try {
    manifest = contract.readManifest(store.dirOf(type, id));
  } catch (e) {
    const st = Object.assign(cur || {}, {
      type,
      id,
      status: 'broken',
      lastError: (e && e.message) || String(e),
    });
    running.set(sid, st);
    log(`✘ 插件起不来 ${logTag(type, id)}：${st.lastError}`);
    return { ok: false, error: st.lastError };
  }

  const proc = spawn(process.execPath, [path.join(__dirname, 'runner.js'), store.dirOf(type, id), manifest.main], {
    cwd: store.dirOf(type, id),
    env: Object.assign({}, process.env, { MBP_PLUGIN_ID: id, MBP_PLUGIN_TYPE: type }),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  const st = {
    type,
    id,
    sid,
    domain: entry.domain || '',
    proc,
    pid: proc.pid,
    status: 'starting', // starting / running / stopped / broken
    actions: [],
    startedAt: Date.now(),
    lastError: '',
    inflight: new Map(),
    seq: 0,
    /** 主动停的标记：用来区分"宿主叫它停"与"它自己崩了" */
    stopping: false,
  };
  running.set(sid, st);

  /* 插件的输出**逐行转发进面板日志**（带前缀），排查时一眼看出是谁打的 */
  const pipe = (stream, level) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) {
        const t = l.trimEnd();
        if (t) console.log(`  ${level === 'err' ? '✘' : '·'} ${logTag(type, id)} ${t}`);
      }
    });
  };
  pipe(proc.stdout, 'out');
  pipe(proc.stderr, 'err');

  const readyTimer = setTimeout(() => {
    if (st.status === 'starting') {
      st.lastError = `启动后 ${READY_TIMEOUT_MS / 1000} 秒没有报 ready（入口可能卡住了）`;
      log(`⚠️ 插件没就绪 ${logTag(type, id)}：${st.lastError}`);
    }
  }, READY_TIMEOUT_MS);

  proc.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ready') {
      clearTimeout(readyTimer);
      st.status = 'running';
      st.actions = Array.isArray(msg.actions) ? msg.actions : [];
      st.lastError = '';
      log(`✔ 插件已就绪 ${logTag(type, id)}：动作 ${st.actions.join(' / ') || '(无)'}`);
      return;
    }
    if (msg.type === 'fatal') {
      clearTimeout(readyTimer);
      st.status = 'broken';
      st.lastError = String(msg.error || '入口报 fatal');
      log(`✘ 插件报告 fatal ${logTag(type, id)}：${st.lastError}`);
      return;
    }
    /* 插件 → 宿主 的反向调用（output 插件读首页 / 聚合能力用，见 host-api.js）。
     * 回复形状 { type:'hostCallReply', id, ok, value?, error? } —— 与正向调用同一套口径。
     * 进程已死时 send 会抛，吞掉即可（人都走了，回信没人收）。 */
    if (msg.type === 'hostCall') {
      hostApi
        .dispatch(msg)
        .then((result) => {
          try {
            st.proc.send(Object.assign({ type: 'hostCallReply', id: msg.id }, result));
          } catch {
            /* 管道已断 */
          }
        });
      return;
    }
    if (msg.id && st.inflight.has(msg.id)) {
      const one = st.inflight.get(msg.id);
      st.inflight.delete(msg.id);
      clearTimeout(one.timer);
      one.resolve(msg);
    }
  });

  proc.on('exit', (code, signal) => {
    clearTimeout(readyTimer);
    /* 把没答完的调用全部如实拒掉（不给假的成功） */
    for (const [, one] of st.inflight) {
      clearTimeout(one.timer);
      one.resolve({ ok: false, error: { code: 'PLUGIN_EXITED', message: `插件进程退出（code=${code} sig=${signal}）` } });
    }
    st.inflight.clear();
    st.proc = null;
    st.pid = null;
    st.status = 'stopped';
    if (!st.stopping) {
      /* 崩了就是崩了：**不自动重启**（要它继续跑就回管理页点「启动」） */
      st.lastError = `进程退出（code=${code} sig=${signal}）`;
      log(`✘ 插件进程退出 ${logTag(type, id)}：${st.lastError}`);
    }
  });

  log(`↻ 插件启动中 ${logTag(type, id)}（v${entry.version}，pid ${proc.pid}）`);
  return { ok: true, state: stateOf(type, id) };
}

/**
 * 停一个插件（主动停，不算崩溃、不触发重启）。
 *
 * **返回一个 Promise，等进程真的退出**才 resolve —— 这件事是必须的：
 * `restart()` 里若只等一个固定时长就去 `start()`，而 `start()` 看到"旧进程还在"会直接返回，
 * 结果就是**停掉了却起不来**（插件自己的善后逻辑越认真、退出越慢，越容易撞上）。
 * 上限到了就 SIGKILL，再等 `KILL_GRACE_MS` 还不退就如实放弃等待（不无限挂着调用方）。
 */
function stop(type, id, { timeoutMs = 5000 } = {}) {
  const sid = keyOf(type, id);
  const st = running.get(sid);
  if (!st || !st.proc) {
    if (st) {
      st.status = 'stopped';
      st.stopping = true;
    }
    return Promise.resolve({ ok: true, already: true });
  }
  st.stopping = true;
  const proc = st.proc;
  log(`· 插件停止中 ${logTag(type, id)}`);
  return new Promise((resolve) => {
    let done = false;
    const finish = (killed) => {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      clearTimeout(giveUpTimer);
      resolve({ ok: true, killed });
    };
    proc.once('exit', () => finish(false));
    try {
      proc.kill('SIGTERM');
    } catch {
      finish(false); // 已经没了就算了
    }
    const killTimer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* 同上 */
      }
    }, timeoutMs);
    const giveUpTimer = setTimeout(() => finish(true), timeoutMs + KILL_GRACE_MS);
    killTimer.unref?.();
    giveUpTimer.unref?.();
  });
}

/** 停掉所有插件（面板退出时调；**不依赖插件配合**）。返回被停的那些插件 */
function stopAll() {
  const out = [];
  for (const [sid, st] of running) {
    if (st.proc) {
      out.push({ type: st.type, id: st.id });
      stop(st.type, st.id, { timeoutMs: 3000 });
    }
    void sid;
  }
  return out;
}

/** 重启：**等旧进程真的退出**再起新的（见 `stop()` 的说明） */
async function restart(type, id) {
  await stop(type, id);
  await new Promise((r) => setTimeout(r, 200)); // 让端口/管道彻底松开一点再起
  return start(type, id);
}

/** 开机把所有**启用中**的插件拉起来 */
function bootAll() {
  const out = [];
  for (const entry of store.list()) {
    if (!entry.enabled) continue;
    out.push({ type: entry.type, id: entry.id, ...start(entry.type, entry.id) });
  }
  return out;
}

/**
 * 向插件发起一次动作调用。
 *
 * 面板侧的调用方（页面、emby 层）都走这里 —— 这样"通道、超时、错误形状"只有一处实现。
 * 返回 `{ ok, value }` 或 `{ ok:false, error:{code,message} }`；**从不抛**（调用方各自决定怎么呈现）。
 */
function call(type, id, action, args, { timeoutMs = DEFAULT_CALL_TIMEOUT_MS } = {}) {
  const sid = keyOf(type, id);
  const st = running.get(sid);
  if (!st || !st.proc) {
    return Promise.resolve({ ok: false, error: { code: 'NOT_RUNNING', message: `插件没在运行：${type}/${id}` } });
  }
  if (st.status !== 'running') {
    return Promise.resolve({ ok: false, error: { code: 'NOT_READY', message: `插件还没就绪：${type}/${id}（当前 ${st.status}）` } });
  }
  const myId = ++st.seq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      st.inflight.delete(myId);
      /* 超时**不杀进程**：插件可能只是慢。如实报"这一次超时"，由调用方决定重试还是跳过 */
      resolve({ ok: false, error: { code: 'TIMEOUT', message: `插件动作超时（${timeoutMs}ms）：${action}` } });
    }, Math.max(1000, Number(timeoutMs) || DEFAULT_CALL_TIMEOUT_MS));
    timer.unref?.();
    st.inflight.set(myId, { resolve, timer, action });
    try {
      st.proc.send({ id: myId, action, args: args || {} });
    } catch (e) {
      clearTimeout(timer);
      st.inflight.delete(myId);
      resolve({ ok: false, error: { code: 'IPC_DOWN', message: '与插件的管道断了：' + ((e && e.message) || e) } });
    }
  });
}

/** 一个插件的对外状态（管理页与调试台都用它） */
function stateOf(type, id) {
  const st = running.get(keyOf(type, id));
  const entry = store.get(type, id);
  return {
    type,
    id,
    name: (entry && entry.name) || id,
    version: (entry && entry.version) || '',
    domain: (entry && entry.domain) || '',
    enabled: !!(entry && entry.enabled),
    origin: (entry && entry.origin) || '',
    status: st ? st.status : 'stopped',
    pid: (st && st.pid) || null,
    actions: (st && st.actions) || [],
    uptimeMs: st && st.startedAt && st.status === 'running' ? Date.now() - st.startedAt : 0,
    lastError: (st && st.lastError) || '',
    inflight: st ? st.inflight.size : 0,
  };
}

/** 全部插件的状态（含没装的运行态残留的清理） */
function states() {
  return store.list().map((x) => stateOf(x.type, x.id));
}

module.exports = {
  DEFAULT_CALL_TIMEOUT_MS,
  start,
  stop,
  stopAll,
  restart,
  bootAll,
  call,
  stateOf,
  states,
};
