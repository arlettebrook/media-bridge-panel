'use strict';
/**
 * 插件进程那一半（**由宿主 spawn，插件作者不用管这个文件**）。
 *
 * 用法：`node runner.js <插件目录> <入口文件>`
 *
 * 这个文件做三件事：切到插件目录、加载它的入口、把宿主的消息分发给它的动作。
 * 面板与插件之间的协议（管道，JSON 消息）：
 *
 *   宿主 → 插件   `{ id, action, args }`
 *   插件 → 宿主   `{ id, ok: true, value }` / `{ id, ok: false, error: { code, message } }`
 *   插件 → 宿主   `{ type: 'ready', actions: [...] }`（加载完成后发一次）
 *   插件 → 宿主   `{ type: 'fatal', error }`（入口有问题，装不起来）
 *
 * **插件侧要做的**：`module.exports = { actions: { 动作名: async (args, ctx) => 返回值 } }`。
 * 名字与形状见 docs/plugin-contract.md —— 契约里没有的字段，面板不会提供。
 *
 * ⚠️ 插件**自己**能读盘、能联网、能起进程（不沙箱，见 docs/adr/0028）；
 * 这个文件不替它做任何事，只负责把"面板问什么、它答什么"接起来。
 */
const path = require('path');

const dir = path.resolve(String(process.argv[2] || ''));
const main = String(process.argv[3] || 'index.js');

let seq = 0;
function send(msg) {
  try {
    if (process.send) process.send(msg);
  } catch {
    /* 管道断了：宿主已经不当这个进程活着了，什么都不用做 */
  }
}

function fatal(message) {
  send({ type: 'fatal', error: String(message) });
  console.error('[插件] 起不来：' + message);
  process.exit(1);
}

/* 切到插件目录：插件用相对路径读自己的文件（例如 ui/、模板）时才不会读错地方 */
try {
  process.chdir(dir);
} catch (e) {
  fatal('切到插件目录失败：' + ((e && e.message) || e));
}

let mod;
try {
  mod = require(path.join(dir, main));
} catch (e) {
  fatal('加载入口失败：' + ((e && e.stack) || e));
}

const actions = (mod && mod.actions) || null;
if (!actions || typeof actions !== 'object' || Array.isArray(actions)) {
  fatal('入口必须导出 `module.exports = { actions: { … } }`');
}
for (const [name, fn] of Object.entries(actions)) {
  if (typeof fn !== 'function') fatal(`动作 ${name} 不是函数`);
}

/** 交给插件的上下文：只有它自己的身份、数据目录与日志口 */
const ctx = {
  type: String(process.env.CATPAW_PLUGIN_TYPE || ''),
  id: String(process.env.CATPAW_PLUGIN_ID || ''),
  dataDir: path.join(dir, 'data'),
  /** 打日志：走 stdout → 宿主转发进面板日志（带 `[plugin:<类型>/<id>]` 前缀） */
  log: (...args) => console.log(...args),
};

process.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'ping') return send({ type: 'pong', at: Date.now() });
  if (!msg.id) return;
  const id = msg.id;
  const fn = actions[msg.action];
  if (typeof fn !== 'function') {
    return send({
      id,
      ok: false,
      error: { code: 'NO_ACTION', message: `这个插件没有实现动作「${msg.action}」（它实现的是：${Object.keys(actions).join(' / ')}）` },
    });
  }
  const t0 = Date.now();
  try {
    const value = await fn(msg.args || {}, ctx);
    seq += 1;
    send({ id, ok: true, value, ms: Date.now() - t0 });
  } catch (e) {
    send({ id, ok: false, error: { code: (e && e.code) || 'PLUGIN_ERROR', message: (e && e.message) || String(e) }, ms: Date.now() - t0 });
  }
});

/* 插件自己抛的异步错误：如实记一行，**不让进程退出**（退出会把没答完的请求全丢掉） */
process.on('unhandledRejection', (e) => console.error('[插件] 未处理的 Promise 拒绝：' + ((e && e.stack) || e)));

send({ type: 'ready', actions: Object.keys(actions) });
