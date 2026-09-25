'use strict';
/**
 * 自检 · 回声（宿主自检用的最小插件）
 *
 * 它只证明"宿主这一层是通的"：装/卸、启停、管道动作调用、日志转发、内存显示、webui 转发。
 * **不申报任何站点、不打上游** —— 所以它不参与任何真实取数。
 *
 * 写法就是契约里那一条：`module.exports = { actions: { … } }`
 * （见 docs/plugin-contract.md）。每个动作拿到 `(args, ctx)`：
 *   · `args` = 面板传进来的参数（面板**不解释**它，原样转过来）
 *   · `ctx`  = `{ type, id, dataDir, log }` —— 自己是谁、自己的数据目录在哪、往哪打日志
 *
 * 想自己存点东西就写 `ctx.dataDir`（面板不会碰它；"清空插件数据"就是删那个目录）。
 */
module.exports = {
  actions: {
    /** 面板调得通吗？ */
    async ping() {
      return { pong: true, at: Date.now(), pid: process.pid };
    },

    /** 原样回显参数（用来确认"面板到底传了什么过来"） */
    async echo(args, ctx) {
      ctx.log(`收到一条 echo：${JSON.stringify(args).slice(0, 200)}`);
      return { got: args, from: `${ctx.type}/${ctx.id}`, pid: process.pid };
    },

    /**
     * webui 的转发入口（**动作名固定是 `http`**，见契约）。
     * 面板把浏览器发来的 `方法 / 路径 / query / body` 原样交给这里，插件回 `{ status?, body }`。
     * 真实的插件在这里处理它自己的设置读写；这个示例只回一句实话。
     */
    async http(args, ctx) {
      ctx.log(`webui 转发：${args.method} ${args.path}`);
      return {
        status: 200,
        body: {
          ok: true,
          note: '这是「自检 · 回声」的转发入口，它只证明 webui 能打到插件；真实的插件在这里读写自己的设置。',
          request: { method: args.method, path: args.path, query: args.query, body: args.body, contentType: args.contentType },
          from: `${ctx.type}/${ctx.id}`,
        },
      };
    },
  },
};
