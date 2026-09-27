'use strict';
/**
 * Emby 层模块（消费层）
 *
 * 基于「聚合层」工作：**进程内直调** `../agg/api`（`detail()` / `play()`）——
 * 两层在同一个进程里，走 HTTP 打自己的 `/api/agg/*` 只会撞面板门禁（不带 cookie → 401）。
 * 见 `agg/api.js` 顶部那段说明。
 *
 * 当前阶段只做「端点监控」：捕获 Emby 客户端打过来的全部请求，
 * 具体补哪些端点由部署者指定，见 docs/emby-compat.md。
 *
 * TMDB 设置与自检**不在本模块**（在元数据插件自己的设置页里，见
 * `plugins/metadata/tmdb/`）；本模块只留 emby 专有的那层 DTO 与图片地址，
 * 取数经 `meta.js` 转发给插件。
 */
const routes = require('./routes');
const home = require('./home');
const meta = require('./meta');
const listener = require('./listener');

/**
 * 拉流方式（`play.mode`）**已删** —— 现在一律 302，见 service.js 的 `redirectUrl()`。
 * 这里不再有"放行老值"的兼容：校验里没有它，盘上留着的 `play.mode` 既不读也不校验，
 * 任何一张卡片保存都不会被它挡住（这正是早期保留 `auto` 的理由，该理由现已不成立）。
 */

module.exports = {
  id: 'emby',
  label: 'Emby',
  apiPrefix: ['/api/emby'],
  upstream: 'agg',

  settings: {
    defaults: () => ({
      /* ⚠️ 服务器名 / 服务器 Id / 图片签名密钥**都不在这里了** —— 它们现在是**实例属性**：
       * 面板支持多个 Emby 实例（见 instance.js），每个实例各有一套握手身份，
       * 改在「Emby → 实例」的编辑弹窗里（存 `data/emby/instances.json` 的 name / serverId / imageKey）。
       * `settings/emby.json` 里老的同名字段只在**首次迁移**时被读一次（instance.migrate），此后不再使用。
       * 老的单账号（明文）—— 只为兼容老备份/老前端而留的空壳：
       * 真正的账号在 data/emby/emby.db（多账号，见 db.js），首次用到库时这个空壳会被清空。 */
      account: { username: '', password: '' },
      /* ⚠️ TMDB 设置**不在这里**（也不在面板层了）：它属于**元数据插件** ——
       * token / 基地址 / 语言都在插件自己的数据目录里（插件 → tmdb → 设置）。
       * 面板只从插件的「注册」动作里拿图片基地址（替客户端取图要用），见 emby/meta.js。 */
      /* 拉流方式是**一律 302**：面板不扛流量，客户端直连源。
       * 本地部署的源回的地址是回环地址，302 前会换成客户端访问用的那个域名 + 源端口
       * （见 service.redirectUrl）；自定义源按源给的真实地址。所以这里没有可选项。 */
      /* ⚠️ **线路过滤搬走了**（→ `agg.json` 的 `lineFilter`，UI 在「聚合设置 → 聚合参数」）：
       * 线路是聚合层产出的东西，规则与它放在一起，所以归聚合设置而不在本模块。
       * 盘上老的 `play.filter` 由 `server.js` 启动时搬一次到 `agg.json`（搬完这里就不认它）。 */
      servers: [],
      defaultIndex: 0,
      /* ⚠️ `serverId` / `imageKey` **也搬去了实例清单**（同上）—— 一个实例一套身份，
       * 它们由 instance.identityOf() 首次用到时生成并落盘，这里不再有对应键。 */
      /* ⚠️ 缓存设置**不在这里**了（已搬到面板层 `panel.json` 的 `cache.*`）：
       * 缓存已跨两个库（core 的 `data/cache/tmdb.db` 与这里的 `data/emby/cache.db`），
       * 而「清空缓存」与「用量显示」要一把抓两个 —— 设置跟着面板走才不会出现
       * "面板上管一半、模块里管一半"。UI 在「面板设置 → 缓存设置」。 */
    }),
    /* ⚠️ 这一层**没有可编辑的设置项了**：服务器名 / 服务器 Id / 图片签名密钥都是实例属性
     * （见上），改在「Emby → 实例」页；老的单账号空壳是内部兼容字段，不给人看。 */
    fields: [],
    /** 没有面板侧设置项要校验（validate 收到的是全量对象）；恒回 null */
    validate: () => {
      /* ⚠️ 服务器名的校验**搬去了 instance.validate** —— 它是实例名，长度上限同在那里管。
       * `play.mode` **不再校验**（"面板代理"已去掉，该键已无意义）——
       * 老配置盘上留着这个键照样能保存任意一张卡片。 */
      /* ⚠️ 线路过滤的校验**搬走了**（→ `agg/settings.js` 的 `lineFilter`）：设置跟着它的新位置走。
       * 盘上老键 `play.filter` 既不读也不校验（启动时已搬到 agg.json）。 */
      /* 缓存数值的校验**不在这里**了 —— 那是面板层的设置（见 panel/index.js）。
       * 注意两个 0 的语义**不一样**：天数 0 = 不缓存（写完即过期）；上限 0 = **不限**（不淘汰）。 */
      return null;
    },
  },

  /**
   * 面板启动时调（见 `server.js`，**排在插件模块起来之后**）。
   *
   * 首页的行清单、取数、设置现在全归 `home` 类型插件（见 `home/index.js` 那段说明）；
   * 这里只做一件事：把各首页插件的行清单**预热**进面板的内存快照 ——
   * 免得开机后第一发 `Views` 拿到空。失败**不挡面板启动**（过期会自己重试）。
   */
  warmHome: async () => {
    try {
      await home.warmHome();
    } catch (e) {
      console.log('  ✘ 首页插件预热失败（面板继续）：' + ((e && e.message) || e));
    }
  },

  /**
   * 每个**启用中**的实例在它自己的端口上挂一个监听（见 `listener.js`）——
   * 客户端填 `http://<面板主机>:<实例端口>` 就能连上，不再与面板的 8099 混用。
   *
   * 调用时机**必须在 `warmHome()` 之后、插件起来之后**：清单首次生成时要读插件清单
   * 挑一个首页插件（`instance.migrate`），插件没起来就挑不到。
   * 单个实例的端口被占**不挡面板启动** —— 错误记在该实例的运行态里，面板上红字提示。
   */
  startListeners: () => listener.startAll(),
  stopListeners: () => listener.stopAll(),
  /** 增删改实例之后调：先停旧的，再按新端口 / 新启停状态起一个（见 routes.js 的实例端点） */
  restartListener: (iid) => listener.restart(iid),

  routes,

  /**
   * 元数据域表：按插件清单重建（**认哪个前缀由元数据插件说了算**，见 core/providers.js）。
   * server.js 在插件起来之后调一次；请求路径上还会顺手同步一次（`ensureMetaProviders`）——
   * 这样"面板跑着的时候装/启用了元数据插件"不必重启面板才生效。
   */
  syncMetaProviders: () => {
    const out = meta.syncProviders();
    for (const s of out.skipped) console.log(`  ✘ 元数据域申报被跳过：${s.id || '(空)'} —— ${s.reason}`);
    if (out.registered) {
      console.log(`  ✔ 元数据域：${meta.domains().map((d) => d.domain + (d.enabled ? '' : '(未启用)')).join('、')}`);
    }
    return out;
  },

  /** 请求路径上的顺手同步（便宜：读一次插件清单，没变就什么都不做） */
  ensureMetaProviders: () => meta.ensureProviders(),

  /** 开机把每个域的声明拉一份（图片基地址这类值早一点就是对的；失败不挡启动） */
  warmMeta: () => meta.warm(),
};
