'use strict';
/**
 * Emby 层路由
 *
 * 已实现：
 *   GET  /api/emby/System/Info/Public        握手：客户端据此确认这是 Emby 服务器
 *   POST /api/emby/Users/AuthenticateByName  登录：校验面板账号（见「Emby → 账号管理」）
 *   GET  /api/emby/Users/{UserId}            取用户资料
 *   GET  /api/emby/Users/{UserId}/Views      媒体库列表（每个启用的首页插件行 = 一个库；不再是留白）
 *   GET  /api/emby/Users/{UserId}/Items/Resume   继续观看（读 `playback` 表的未看完条目；必须注册在 Items/{ItemId} 之前）
 *   GET  /api/emby/Users/{UserId}/Items      条目列表（列表数据由首页模块决定：认 ParentId=<库Id>；其余如实空）
 *   GET  /api/emby/Users/{UserId}/Items/{ItemId}  单条详情（元数据 + 源绑定走本模块设置里的聚合地址）
 *   POST /api/emby/Users/{UserId}/Items/{ItemId}/HideFromResume  「从继续观看里移除 / 恢复」（`Hide=false` 恢复）
 *   POST|DELETE /api/emby/Users/{UserId}/PlayedItems/{ItemId}    「标记已看 / 未看」（POST=已看、DELETE=未看）
 *   POST /api/emby/Sessions/Playing[/Progress|/Stopped]  客户端播放上报（落库，见下面「播放进度上报」）
 *   POST /api/emby/Items/{ItemId}/PlaybackInfo   播放信息（版本清单 = 线路，Path 指向下面的 Stream）
 *   GET  /api/emby/Items/{ItemId}/Stream         拉流（现取地址后按版本 Id 里的 `playVia` **分档落法**：
 *                                                `client` 302 / 清单 200 中继；`proxy` 面板代持请求头中继，
 *                                                见 ADR-0042。本地部署的源会把回环地址换成客户端域名）
 *   GET  /api/emby/videos|Videos/{ItemId}/stream[.{ext}]  直连播放（**Emby 标准端点**：实测客户端播直连时
 *                                                走的是这条 + MediaSourceId，而不是上面那条 Path；
 *                                                两种大小写都注册 —— 小写是早期日志实录，大写是 Emby 官方路径）
 *   GET  /api/emby/stream                         `proxy` 档清单改写出的分片子地址（验签名，不校验 token；
 *                                                与 /api/agg/stream?seg= 同一实现，只是必须落在实例端口收的
 *                                                /api/emby/ 前缀下）
 *   GET  /api/emby/Items/{ItemId}/Download       下载（与拉流**同一条链路**：MediaSourceId → 现取地址 → 落法；
 *                                                `client` 档 302 之后文件名/断点续传归源站，面板不扛流量）
 *   GET  /api/emby/Shows/{Id}/Seasons        剧的季列表（**占位**：插件的 seasons[]；UserId 在 query 里）
 *   GET  /api/emby/Shows/{Id}/Episodes       某一季的分集（**占位**：插件的取季动作；UserId/SeasonId 在 query 里）
 *   GET  /api/emby/Items/{Id}/Images/{type}  图片（**豁免 token**；tag = `cpimg.<base64url(URL)>.<签名>`，验签不过 404；**一律 302** 到原图；支持 `/Images/{type}/{index}`）
 *   GET  /api/emby/Items/{Id}/Similar        相似推荐（按条目坐标反查上游，归 emby 层）
 *
 * 面板自用（不是 Emby 客户端协议，但同样必须注册在通配之前）—— **都走面板门禁**：
 *   GET    /api/emby/instances                Emby 实例列表（含运行态与账号/会话/库数）
 *   POST   /api/emby/instances                新增实例（端口留空则自动挑一个空闲的）
 *   PATCH  /api/emby/instances/{iid}          改名 / 改端口 / 改首页插件 / 改搜索域 / 启停
 *   DELETE /api/emby/instances/{iid}          删实例（连带删掉它的账号与进度；默认实例不给删）
 *   GET    /api/emby/home-plugins             可选首页插件清单（实例编辑弹窗的下拉用）
 *   GET    /api/emby/meta-domains             可选元数据域清单（实例编辑弹窗的多选用：这个实例的搜索走哪些域）
 *   GET/POST    /api/emby/instances/{iid}/accounts       账号列表 / 新增（**按实例**）
 *   PUT/DELETE  /api/emby/instances/{iid}/accounts/{id}  改（用户名/密码）/ 删
 *   （元数据插件自己的设置（token / 基地址）与自检在**它自己的设置页**里：插件 → 该插件 → 设置）
 *   （首页插件的行清单 / 参数 / token 在**首页插件自己的设置页**里：插件 → 该插件 → 设置。
 *    原先那 8 个 `/api/emby/home/**` 端点已随批次 9 删除 —— 老宿主与老管理面没了。）
 *
 * 通配（必须注册在最后）：
 *   ANY  /api/emby/*rest   其余请求一律**记一行**日志 + 回 501，待明确需求后再实现
 *
 * **日志口径**：**每个请求都记一行，不做筛选**（见 `./log.js`）——
 * 2xx 记为成功、≥400 记为失败、未实现记 `未实现#N`，都带客户端标记与 query 摘要。
 * 量靠别处压：面板「日志」页是**固定条数的内存环形缓冲**，页面里还能按级别过滤。
 * 查看：面板「面板设置 → 日志」（内存最近 N 条）+ `docker logs`（长期，自带轮转）。
 *
 * **AccessToken 校验**：除下面这些豁免项外，所有端点都先过 `service.authorize()`
 *   （豁免：握手 / 登录 / 面板自用端点 / 501 通配 —— 图片端点将来也要豁免：
 *   实测 8 条图片请求里 5 条带 `x-emby-authorization`、3 条**什么凭证都不带**（原生 Rex 客户端），
 *   要求 token 会让那部分客户端图全挂；而非图片请求 9/9 都带 `x-emby-token`）。
 *
 * 端点清单与规矩见 docs/emby-compat.md。
 */
const { sendJson, sendBuffer, readBody, readRawBody } = require('../../core/http');
const service = require('./service');
/* 流内核（agg 拥有）：`proxy` 档的清单子地址与字节中继都共用那一份，别再各写一遍 */
const streamKernel = require('../agg/stream');
const log = require('./log');
const metaBridge = require('./meta-bridge');
const db = require('./db');
const home = require('./home');
const instance = require('./instance');
const meta = require('./meta');
const listener = require('./listener');

/* 取 UserId：真机客户端的写法**不统一** —— CapyPlayer 在 `Shows/NextUp`、`Shows/{id}/Seasons`、
 * `Items/{id}/Similar` 上发小写 `userId`，在 `Items` 与 `PlaybackInfo` 上发驼峰 `UserId`（Emby 约定是后者）。
 * 两种都认：小写那几条以前取到 null，被 `assertUser` 判成"id 不属于任何账号 → 404"，
 * 剧页的季列表与相似推荐整条铺不出来（NextUp 侥幸没事 —— 它走 `accountIdFor`，能从 token 兜回来）。 */
const userIdOf = (query) => query.get('UserId') || query.get('userId');

/* 取 SeasonId：同一个客户端在参数大小写上本来就混着发（见上面的 `userId`）。
 * 小写 `seasonId` 取不到时，分集列表会回 **200 但 Items=0** —— 静默空，比 404 更难查，照样放宽。 */
const seasonIdOf = (query) => query.get('SeasonId') || query.get('seasonId');

/**
 * 未实现端点的统一回应：**记一行**日志（返回序号）+ 501。
 *
 * 通配路由 与「路径形状被已实现端点占住、但 Id 不归它管」的请求共用 ——
 * 后者指 `Users/{UserId}/Items/{ItemId}` 这条：`Items/Resume` / `Items/Latest`（继续观看 / 最新）
 * 路径形状一样，但这里只认本面板发出去的条目 Id（前缀归元数据域），认不出的仍按「未实现」记一行 + 501，不静默吞掉。
 *
 * `body` 可选（通配路由读下来的原始体）：只用来打一行摘要（掩码 + 压平 + 限长，见 `log.bodyBrief`）。
 * POST 端点没有 query，不看 body 就无从知道客户端报了什么。
 */
function notImplemented(req, res, { pathname, query, body }) {
  const n = log.logMissing(req, { pathname, query, body });
  res.writeHead(501, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(
    JSON.stringify({
      error: 'EMBY_ENDPOINT_NOT_IMPLEMENTED',
      path: pathname,
      logSeq: n,
      hint: '该端点尚未实现，已记录到面板日志',
    })
  );
}

/**
 * 把 `resolveStream` 的结果落到响应上。**三种形态**（由内核的 `planStream` 分档，见 ADR-0042）：
 *
 *   · `out.stream`   —— 302，只回一个 `Location`，字节全在源与客户端之间跑（`client` 档的非清单线路）
 *   · `out.playlist` —— 200，回一份**改写过的 HLS 清单**（`client` 补绝对 / `proxy` 换成面板签名子地址）：
 *     清单**不能 302** —— 里面的地址是相对的，客户端按"自己最初请求的那条 URL"拼，
 *     一跳过去它就拼到面板身上了（实测 VidHub 的 ffmpeg 去打 `/videos/{Id}/360p/video.m3u8` → 501）。
 *     ⚠️ 面板搬的是**一份清单**（几百字节），不是媒体流量。
 *   · `out.relay`    —— 200，**面板代持请求头**去取字节并搬到客户端（`proxy` 档的非清单线路）：
 *     客户端带不了那串鉴权头，只能由面板带头发给上游。搬运是**分块并发**的（有界 Range 切块，
 *     参数见面板设置 `streamRelay`），实现在 `../agg/stream.js` 的 `relayBytes`（与 agg 流端点同一份）。
 *
 * 本地部署的源回的地址是回环地址，这里拿到的已经是**换过域名**的那份（见源插件的地址改写）。
 *
 * `verb` 只进日志那行（拉流 / 下载）：两个端点共用这一段，日志里得能分清是哪条在跑。
 */
function serveStream(req, res, out, label, verb = '拉流') {
  if (!out.stream && !out.playlist && !out.relay) {
    /* 失败时把**客户端原始 URL** 一起打出来 —— 光看状态行根本不知道它回传了什么
     * `MediaSourceId`（排查"缺少 vod"时就卡在这）。**只在失败时打**，所以并成一行。 */
    log.logResult(req, `${verb} ${label}`, out, out.status >= 400 ? ` 原始请求: ${req.url}` : '');
    return sendJson(res, out.status, out.body);
  }
  log.logResult(req, `${verb} ${label}`, { status: out.status, log: out.log });
  if (out.playlist) return sendBuffer(res, 200, Buffer.from(out.playlist.text, 'utf8'), out.playlist.contentType);
  /* 字节中继：搬运函数自己写响应头与状态行，这里不要再碰 `res` */
  if (out.relay) return streamKernel.relayBytes(req, res, out.relay);
  /* ⚠️ `Location` 里的**非 ASCII 必须先编码**：HTTP 头的值只认 ASCII，Node 碰上中文会直接抛
   * `Invalid character in header content ["Location"]` —— 那时状态行已经写了一半，
   * 客户端看到的是一个莫名其妙的 500（实测：源回的地址里带中文站名时会这样）。
   * `encodeURI` 只动非 ASCII 与空格，`?`/`&`/`=`/`/` 这些保留字符照旧（不会破坏 query）。 */
  res.writeHead(302, { Location: encodeURI(out.stream.url), 'Cache-Control': 'no-store' });
  return res.end();
}

/**
 * 把 `{status, body}` 落到响应上：**没有 body 就 204 空体**。
 *
 * 播放上报与几个写端点共用 —— 这类端点的 body 本来就是可选的：有就回 JSON
 * （客户端拿它更新界面上的「已看 / 继续观看」），没有就一个字节都不回。
 */
function sendOut(res, out) {
  if (!out.body) {
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    return res.end();
  }
  return sendJson(res, out.status, out.body);
}

module.exports = function routes(r) {
  /* ---------------- 已实现端点（先于通配注册） ---------------- */

  r.add('GET', '/api/emby/System/Info/Public', (req, res) => {
    const info = service.publicInfo(req);
    log.logResult(req, '握手 System/Info/Public', { status: 200, log: `ServerName=${info.ServerName} Version=${info.Version}` });
    return sendJson(res, 200, info);
  });

  r.add('POST', '/api/emby/Users/AuthenticateByName', async (req, res) => {
    const body = await readBody(req);
    const out = service.authenticate(req, body);
    /* 登录**成功与失败都记**：客户端登录时带上试的用户名，401 排查全靠它 */
    const who = String((body && (body.Username || body.username)) || '(空)');
    log.logResult(req, '登录 Users/AuthenticateByName', out, ` user=${who}`);
    return sendJson(res, out.status, out.body);
  });

  r.add('GET', '/api/emby/Users/:userId', (req, res, { params }) => {
    /* AccessToken 守卫（见 service.authorize）：无效/缺失一律 401 */
    const denied = service.authorize(req, params.userId);
    if (denied) {
      log.logResult(req, `取用户资料 Users/${params.userId}`, denied);
      return sendJson(res, denied.status, denied.body);
    }

    const out = service.getUser(params.userId);
    log.logResult(req, `取用户资料 Users/${params.userId}`, out);
    return sendJson(res, out.status, out.body);
  });

  /* 媒体库列表：每个「启用的」首页插件行 = 一个库（已不再是留白端点） */
  r.add('GET', '/api/emby/Users/:userId/Views', (req, res, { params, query }) => {
    const q = log.queryBrief(query);
    /* AccessToken 守卫（见 service.authorize）：无效/缺失一律 401 */
    const denied = service.authorize(req, params.userId);
    if (denied) {
      log.logResult(req, `媒体库 Users/${params.userId}/Views`, denied, q);
      return sendJson(res, denied.status, denied.body);
    }

    const out = service.getViews(params.userId);
    log.logResult(req, `媒体库 Users/${params.userId}/Views`, out, q + " " + log.countOf(out, "Items"));
    return sendJson(res, out.status, out.body);
  });

  /**
   * 继续观看 —— 客户端 `POST /Sessions/Playing*` 上报的进度落在 `playback` 表里，这条读它。
   *
   * ⚠️ **必须注册在下面 `Users/:userId/Items/:itemId` 之前** —— 两条的路径形状完全一样
   * （`Items/Resume` 会被 `:itemId` 当成一个条目 Id 吞掉）。之前它 501 就是这个原因：
   * 落进 `:itemId` 后 `parseItemId('Resume')` 认不出 → 走 `notImplemented`。
   *
   * 校验账号（回的是**某个账号的观看记录**）：`service.getResume` 内部就校验了，路由层不重复。
   */
  r.add('GET', '/api/emby/Users/:userId/Items/Resume', async (req, res, { params, query }) => {
    const q = log.queryBrief(query);
    const out = await service.getResume(params.userId, req, query);
    log.logResult(req, `继续观看 Users/${params.userId}/Items/Resume`, out, q + " " + log.countOf(out, "Items"));
    return sendJson(res, out.status, out.body);
  });

  /**
   * GET /Studios[?UserId=…&Limit=…] —— 工作室（制片公司 / 电视台）清单
   *
   * **如实回空**。理由见 `service.getStudios`：不是没做，
   * 是**没有片库可枚举** —— 硬凑只会得到一个随榜单波动的假清单，比空更糟。
   *
   * **不校验 token / UserId**：**回空的响应没有数据可保护**，
   * 校验只会有坏处 —— 客户端不带 token 时白吃一个 401，而它本该拿到一个空列表。
   * 同口径的还有 `Items/Resume` 与 `Items` 里那些回空的分支（见 `service.itemsWillReturnData`）。
   */
  r.add('GET', '/api/emby/Studios', (req, res, { query }) => {
    const q = log.queryBrief(query);
    const out = service.getStudios();
    log.logResult(req, '工作室 Studios', out, q + " " + log.countOf(out, "Items"));
    return sendJson(res, out.status, out.body);
  });

  /**
   * GET /Shows/NextUp —— 「接下来看」（SenPlayer 实测在请求该端点，还会带 `SeriesId` 只问一部剧）
   *
   * 按库里的进度算"该看哪一集"，见 `service.getNextUp`。
   * `UserId` 在 **query**（`&UserId=…`），不在路径里 —— 与 `Shows/{Id}/Seasons` 同款。
   *
   * 无路由冲突：这里**没有**裸的 `Shows/:showId` 那条路由（只有 `Shows/:showId/Seasons|Episodes`），
   * 所以 `NextUp` 不会被当成 showId 吞掉；`SeriesId` 是 query 参数，与路由形状无关。
   */
  r.add('GET', '/api/emby/Shows/NextUp', async (req, res, { query }) => {
    const q = log.queryBrief(query);
    const out = await service.getNextUp(userIdOf(query), req, query);
    log.logResult(req, '接下来看 Shows/NextUp', out, q + " " + log.countOf(out, "Items"));
    return sendJson(res, out.status, out.body);
  });

  /**
   * GET /Items/Counts —— 全库各类条目数量（SenPlayer 实测在请求该端点）
   *
   * **回全 0**＝"数不出来"，不是"库是空的"（理由见 `service.getItemCounts` —— 没有片库索引，
   * 而唯一能凑的数据源是插件行的 `total`，那是上游榜单总数，不是本面板的库，拿它当数就是编数据）。
   *
   * 无路由冲突：条目详情那条是 `Users/:userId/Items/:itemId`，**没有**裸的 `Items/:itemId`，
   * 所以 `Counts` 不会被当条目 Id 吞掉（⚠️ 但 `Users/:userId/Items/Resume` 曾被这种
   * 同形状路由吞掉 —— 以后若新增 `Items/{Id}` 之类，需把这条挪到前面）。
   * **不校验账号**：回空没有数据可保护。
   */
  r.add('GET', '/api/emby/Items/Counts', (req, res, { query }) => {
    const q = log.queryBrief(query);
    const out = service.getItemCounts();
    log.logResult(req, '条目计数 Items/Counts', out, q);
    return sendJson(res, out.status, out.body);
  });

  /* 条目列表：列表数据由首页模块决定（认 ParentId=<库Id>）；收藏/已播放如实空；其余查询如实空 */
  r.add('GET', '/api/emby/Users/:userId/Items', async (req, res, { params, query }) => {
    const q = log.queryBrief(query);
    /* AccessToken 守卫**只挂在这条真会出数据的路上**（见 `service.itemsWillReturnData`）：
     * 收藏/已播放、以及认不出的查询都是**如实回空**，回空没有数据可保护，
     * 校验只会有坏处 —— 客户端不带 token 时白吃一个 401，而它本该拿到空列表。
     * ⚠️ 判据与 `service.getItems` 内部用的是**同一个函数**，别在这里另写一份。 */
    if (service.itemsWillReturnData(query)) {
      const denied = service.authorize(req, params.userId);
      if (denied) {
        log.logResult(req, `条目列表 Users/${params.userId}/Items`, denied, q);
        return sendJson(res, denied.status, denied.body);
      }
    }

    const out = await service.getItems(params.userId, query);
    service.applyUserData(out, params.userId, req);
    log.logResult(req, `条目列表 Users/${params.userId}/Items`, out, q + " " + log.countOf(out, "Items"));
    return sendJson(res, out.status, out.body);
  });

  /**
   * 最新条目（VidHub 首页每一行都靠它）—— **回的是裸数组**，不是 `QueryResult`。
   *
   * ⚠️ **必须注册在下面 `Users/:userId/Items/:itemId` 之前** —— 两条路径形状一样，
   * `Items/Latest` 会被 `:itemId` 当成一个条目 Id 吞掉，然后 501（`Items/Resume` 曾因同样的路由顺序被吞掉）。
   *
   * 内容由首页模块决定（见 `service.getLatest`）：emby 层不排序、不筛"入库时间"。
   */
  r.add('GET', '/api/emby/Users/:userId/Items/Latest', async (req, res, { params, query }) => {
    const q = log.queryBrief(query);
    /* 与 `Items` 同一条口径：只在"真会出数据"的路上校验账号（判据共用 `itemsWillReturnData`） */
    if (service.itemsWillReturnData(query)) {
      const denied = service.authorize(req, params.userId);
      if (denied) {
        log.logResult(req, `最新条目 Users/${params.userId}/Items/Latest`, denied, q);
        return sendJson(res, denied.status, denied.body);
      }
    }

    const out = await service.getLatest(params.userId, query);
    service.applyUserData(out, params.userId, req);
    log.logResult(req, `最新条目 Users/${params.userId}/Items/Latest`, out, q + " " + log.countOf(out, "items"));
    return sendJson(res, out.status, out.body);
  });

  /* 季列表：只认剧的 Id（{域}_{编号}_tv）；UserId 在 query 里，走同一套账号校验 */
  r.add('GET', '/api/emby/Shows/:showId/Seasons', async (req, res, { params, query }) => {
    const q = log.queryBrief(query);
    /* AccessToken 守卫（见 service.authorize）：无效/缺失一律 401 */
    const denied = service.authorize(req, userIdOf(query));
    if (denied) {
      log.logResult(req, `季列表 Shows/${params.showId}/Seasons`, denied, q);
      return sendJson(res, denied.status, denied.body);
    }

    const out = await service.getSeasons(params.showId, userIdOf(query));
    service.applyUserData(out, userIdOf(query), req);
    log.logResult(req, `季列表 Shows/${params.showId}/Seasons`, out, q + " " + log.countOf(out, "Items"));
    return sendJson(res, out.status, out.body);
  });

  /* 分集列表：只认剧的 Id + SeasonId（{域}_{编号}_tv_s{n}），其余回空 */
  r.add('GET', '/api/emby/Shows/:showId/Episodes', async (req, res, { params, query }) => {
    const q = log.queryBrief(query);
    /* AccessToken 守卫（见 service.authorize）：无效/缺失一律 401 */
    const denied = service.authorize(req, userIdOf(query));
    if (denied) {
      log.logResult(req, `分集列表 Shows/${params.showId}/Episodes`, denied, q);
      return sendJson(res, denied.status, denied.body);
    }

    const out = await service.getEpisodes(params.showId, userIdOf(query), seasonIdOf(query));
    service.applyUserData(out, userIdOf(query), req);
    log.logResult(req, `分集列表 Shows/${params.showId}/Episodes`, out, q + " " + log.countOf(out, "Items"));
    return sendJson(res, out.status, out.body);
  });

  /* 单条详情：只认本面板发出去的条目 Id（前缀归元数据域）；认不出的（如 Items/Resume）走 501 */
  r.add('GET', '/api/emby/Users/:userId/Items/:itemId', async (req, res, { params, query, pathname }) => {
    const q = log.queryBrief(query);
    /* AccessToken 守卫（见 service.authorize）：无效/缺失一律 401 */
    const denied = service.authorize(req, params.userId);
    if (denied) {
      log.logResult(req, `条目详情 Users/…/Items/${params.itemId}`, denied, q);
      return sendJson(res, denied.status, denied.body);
    }

    if (!metaBridge.parseItemId(params.itemId)) return notImplemented(req, res, { pathname, query });

    /* `host` 传进去是为了让 `MediaSources[].Path` / 条目级 `Path` 是**绝对 URL**
     * （真机的 Path 也从来不是相对路径）。用请求自己的 Host —— 那正是客户端能连到的地址。 */
    const out = await service.getItem(params.itemId, params.userId, req.headers.host || '');
    service.applyUserData(out, params.userId, req);
    log.logResult(req, `条目详情 Users/…/Items/${params.itemId}`, out, q + (out.body && out.body.CatpawSource ? " 源=" + out.body.CatpawSource.Site : ""));
    return sendJson(res, out.status, out.body);
  });

  /* 播放信息：客户端点播放前必来，返回版本清单（Path 指向下面的 Stream 端点，不带时效地址） */
  r.add('POST', '/api/emby/Items/:itemId/PlaybackInfo', async (req, res, { params, query }) => {
    const q = log.queryBrief(query);
    /* AccessToken 守卫（见 service.authorize）：无效/缺失一律 401 */
    const denied = service.authorize(req, userIdOf(query));
    if (denied) {
      log.logResult(req, `播放信息 Items/${params.itemId}/PlaybackInfo`, denied, q);
      return sendJson(res, denied.status, denied.body);
    }

    const out = await service.getPlaybackInfo(params.itemId, userIdOf(query), req.headers.host || '', service.tokenFrom(req).token);
    log.logResult(req, `播放信息 Items/${params.itemId}/PlaybackInfo`, out, q + " " + log.countOf(out, "MediaSources"));
    return sendJson(res, out.status, out.body);
  });

  /**
   * 渠道 ①：`MediaSource.Path` 指向的端点 —— 形状 `/Stream/{token}[/{文件名}]`（见 `service.streamPath`）。
   * `token` 是 base64url 的版本 Id（自带站点/线路/vod）；**末段文件名只为版本行副标题存在**：
   * 客户端会把 Path 解码后取「最后一个 `/` 之后」当副标题，所以那里放集名，而不是源路径里的 `8471.html`。
   * 注册两条（带文件名 / 不带）共用同一处理。
   */
  const streamByPath = async (req, res, { params, query }) => {
    /* AccessToken 守卫（见 service.authorize）：无效/缺失一律 401 */
    const denied = service.authorize(req, userIdOf(query));
    if (denied) {
      log.logResult(req, `拉流 Items/${params.itemId}/Stream`, denied);
      return sendJson(res, denied.status, denied.body);
    }

    const src = service.decodeSourceToken(params.token);
    if (!src) {
      console.log(`  ✘ emby 拉流 Items/${params.itemId}/Stream → HTTP 400  token 认不出：${params.token}${log.clientTag(req)}`);
      return sendJson(res, 400, {
        error: '路径里的 token 认不出（应是 base64url 的、以 catpaw: 开头的版本 Id）',
      });
    }
    const out = await service.resolveStream(params.itemId, src, userIdOf(query), req);
    return serveStream(req, res, out, `Items/${params.itemId}/Stream`);
  };
  r.add('GET', '/api/emby/Items/:itemId/Stream/:token', streamByPath);
  r.add('GET', '/api/emby/Items/:itemId/Stream/:token/:file', streamByPath);

  /* 渠道 ①'：老的 `?src=&vod=` 形状 —— 不再写进 `Path`，留着手工调试（文档里那条实测走的就是它）。 */
  r.add('GET', '/api/emby/Items/:itemId/Stream', async (req, res, { params, query }) => {
    /* AccessToken 守卫（见 service.authorize）：无效/缺失一律 401 */
    const denied = service.authorize(req, userIdOf(query));
    if (denied) {
      log.logResult(req, `拉流 Items/${params.itemId}/Stream`, denied);
      return sendJson(res, denied.status, denied.body);
    }

    const out = await service.resolveStream(params.itemId, query.get('src'), userIdOf(query), req);
    return serveStream(req, res, out, `Items/${params.itemId}/Stream`);
  });

  /**
   * 渠道 ②：Emby 的标准直连端点 —— **客户端真正走的**是这条
   *   `GET /videos/{ItemId}/stream.mkv?Static=true&MediaSourceId=<版本 Id>&PlaySessionId=…&api_key=…`
   * （实测日志 emby#39~#45），而**不是**上面那条 Path。缺了它播放一律 501，客户端只会反复重试。
   *
   * `MediaSourceId` 自带站点/线路/vod（**压缩后 base64url 编在 Id 里**，见 service.catpawSourceId），所以这里没有额外参数；
   * `Static=true` 表示要直连（不转码），与一律 302 的语义一致。
   * `:file` 只认 `stream` / `stream.<扩展名>`（后缀来自 `MediaSource.Container`）；`original.mkv` 之类
   * 没在任何日志里出现过，仍按「未实现」记日志 + 501，不提前猜。
   */
  const serveDirectVideo = async (req, res, { params, query, pathname }) => {
    /* AccessToken 守卫（见 service.authorize）：无效/缺失一律 401 */
    const denied = service.authorize(req, userIdOf(query));
    if (denied) {
      log.logResult(req, `拉流 videos/${params.itemId}/${params.file}`, denied);
      return sendJson(res, denied.status, denied.body);
    }

    if (!/^stream(\.[a-z0-9]+)?$/i.test(params.file)) return notImplemented(req, res, { pathname, query });

    const out = await service.resolveStream(
      params.itemId,
      query.get('MediaSourceId'),
      userIdOf(query),
      req // 由本跳的 Host 推 clientHost / origin：本地实例回的是回环地址，插件拿它拼成客户端够得着的
    );
    return serveStream(req, res, out, `videos/${params.itemId}/${params.file}`);
  };
  /* **两种大小写都注册**：路由是**区分大小写**的，而两条实录都得认 —— 小写 `videos` 是早期日志
   * （emby#39~#45），大写 `Videos` 是 Emby 官方路径（实测 Lumenic/1.0.0 打的就是大写：
   * 先白吃一个 501，随后才退回小写拿到 302）。同一条实现，不复制逻辑。 */
  r.add('GET', '/api/emby/videos/:itemId/:file', serveDirectVideo);
  r.add('GET', '/api/emby/Videos/:itemId/:file', serveDirectVideo);

  /**
   * `GET /api/emby/stream?seg=…&sid=…` —— **`proxy` 档 HLS 清单改写出来的子地址**（分片 / 子清单 / 密钥）。
   *
   * 与 agg 那条 `/api/agg/stream?seg=` 是**同一条实现**（`relayBytes` + 签名子地址），只是路径不同：
   * Emby 实例端口的监听**只收 `/api/emby/` 前缀**（见 `listener.js`），清单是客户端在**实例端口**上
   * 取回去的，里面改写出的分片地址也只会打回实例端口 —— 指到 `/api/agg/stream` 必吃 404。
   *
   * **不走面板 cookie 门禁**（`core/auth.js` 的 `needsAuth` 对非面板自用的 `/api/emby/*` 放行），
   * 也不校验 Emby token：这是**面板自己发出去的子地址**，唯一的凭证是那道 HMAC 签名
   * （`core/auth.js` 的 `signStreamPart`）。没有它，这个端点就是个人人可用的开放代理。
   *
   * ⚠️ **必须注册在通配 `ANY /api/emby/*rest` 之前**。
   */
  r.add('GET', '/api/emby/stream', async (req, res, { query }) => {
    const seg = String(query.get('seg') || '').trim();
    if (!seg) return notImplemented(req, res, { pathname: '/api/emby/stream', query });
    return streamKernel.servePart(req, res, { seg, sid: String(query.get('sid') || '').trim() });
  });

  /**
   * 下载：`GET /api/emby/Items/{ItemId}/Download?MediaSourceId=<版本 Id>&DeviceId=…`。
   *
   * 实测（SenPlayer/6.2.1，三体 S1E2）12 小时里试了 **8 次**，每次都落进通配的 501 → 它就一直重试。
   * 这条端点要的东西**和拉流一模一样**：`MediaSourceId` 里已经编着 站点/线路/vod，所以直接复用
   * `resolveStream` → `serveStream`（同一条链路、同一次上游取地址），不新增任何取数逻辑。
   *
   * ⚠️ **302 之后由源站应答**：`Content-Disposition`（文件名）、`Content-Type`、断点续传全是源站说了算，
   * 面板改不了。要"片名.S01E01.mkv"那种漂亮文件名，只能在面板里代为转发**全量字节**并自己写
   * `Content-Disposition` —— 那与「面板不扛流量」（ADR-0006）直接冲突，本实现不做。
   *
   * 同族的 `Items/{ItemId}/File`（也是下载）**先不做**：客户端日志里从没出现过，
   * 按"等客户端日志暴露再接线"的老规矩办 —— 出现了再加一条同样的路由即可。
   */
  r.add('GET', '/api/emby/Items/:itemId/Download', async (req, res, { params, query }) => {
    /* AccessToken 守卫（见 service.authorize）：无效/缺失一律 401 */
    const denied = service.authorize(req, userIdOf(query));
    if (denied) {
      log.logResult(req, `下载 Items/${params.itemId}/Download`, denied);
      return sendJson(res, denied.status, denied.body);
    }

    const out = await service.resolveStream(
      params.itemId,
      query.get('MediaSourceId'),
      userIdOf(query),
      req // 由本跳的 Host 推 clientHost / origin：本地实例回的是回环地址，插件拿它拼成客户端够得着的
    );
    return serveStream(req, res, out, `Items/${params.itemId}/Download`, '下载');
  });

  /* 相似推荐：按条目的坐标反查上游（与季/集同类，归 emby 层，不走首页模块） */
  r.add('GET', '/api/emby/Items/:itemId/Similar', async (req, res, { params, query }) => {
    const q = log.queryBrief(query);
    const denied = service.authorize(req, userIdOf(query));
    if (denied) {
      log.logResult(req, `相似推荐 Items/${params.itemId}/Similar`, denied, q);
      return sendJson(res, denied.status, denied.body);
    }

    const out = await service.getSimilar(params.itemId, userIdOf(query), query.get('Limit'));
    service.applyUserData(out, userIdOf(query), req);
    log.logResult(req, `相似推荐 Items/${params.itemId}/Similar`, out, q + " " + log.countOf(out, "Items"));
    return sendJson(res, out.status, out.body);
  });

  /* ---------------- 图片（**豁免 AccessToken**） ---------------- */

  /**
   * `GET /Items/{ItemId}/Images/{type}[?tag=…&maxWidth=…&quality=…]` —— `type` 形如 `Primary` / `Backdrop` / `Logo`。
   *
   * - **豁免 AccessToken**：实测图片请求的凭证携带**不统一**（同一批 8 条里 5 条带 `x-emby-authorization`、
   *   3 条**什么凭证都不带**）。要求 token 会让那部分客户端图全挂。
   * - tag 是 `cpimg.<base64url(图片URL)>.<签名>`（见 `service.imageTag`）——
   *   **验签不过一律 404**：这个端点豁免 token，不签名就等于把面板变成"替任何人取任意 URL"的开放代理。
   * - **一律 302**（面板不再代取字节，取向与拉流 / 下载一致）：只回一个 `Location`，图在源站与
   *   客户端之间直接跑。代价是**客户端得自己连得到图床**（该域申报的图片基地址那台站），面板不再兜这条网络。
   * - **两条取图路**：① tag 验签通过（客户端把 tag 带回来了）→ 从 tag 里解出 URL；
   *   ② 没带 tag / 验签不过 → 查**本地图片索引**（见下）。两条都取不到才 404。
   *   ⚠️ 已否决方案：不要用"按条目 Id 反查上游"作兜底 ——
   *   那随片库规模**线性**消耗上游配额（实测 340 次请求 ≈ 55 次调用），而图片位置**本来就在本地**。
   *   现为零成本的本地索引。
   * - `maxWidth` / `quality` / `type` / `index` 忽略：URL 来自 tag 或索引，302 到**原图**
   *   （插件给的地址本来就是按尺寸取的）。
   * - **`/:index` 变体**：给了多张背景图（`BackdropImageTags[]`）后，客户端会按
   *   `Images/Backdrop/0`、`/1`… 逐张要 —— 路径里那个 index **只在查索引时用**（tag 里逐张带着呢）。
   */
  const imagesByType = async (req, res, { params, query }) => {
    const label = `Items/${params.itemId}/Images/${params.type}${params.index !== undefined ? '/' + params.index : ''}`;
    const rawTag = String(query.get('tag') || '');

    /* tag 验签通过 → 直接用它里面的 URL（零上游调用）。
     * ② 没带 tag / 验签不过 → 查**本地图片索引**（`service.imageUrlFromIndex`）：
     *    索引在发 tag 时顺带记下（见 `service.tagAndRemember`），URL 本来就在本地，
     *    所以这一步**零上游调用**。命中即可正常出图。
     * ③ 都取不到 → 404，**不回退上游反查** —— 那条路随片库规模线性消耗配额
     *    （实测 340 次请求 ≈ 55 次调用，6h 过期重来），而位置本就在索引里。
     * 图片端点豁免 token，所以"URL 必须由本面板签过或记过"是这里唯一的 SSRF 防线。 */
    let url = service.parseImageTag(params.itemId, rawTag);
    let via = 'tag';
    if (!url) {
      url = service.imageUrlFromIndex(params.itemId, params.type, params.index);
      via = '索引';
    }
    if (!url) {
      /* 诊断要能一眼看出"是没带 tag，还是带了但对不上"——两者的修法完全不同 */
      const shape = rawTag
        ? rawTag.startsWith('cpimg.')
          ? 'tag 验签不过'
          : `tag 非本面板格式：${rawTag.slice(0, 24)}…`
        : '客户端未回传 tag';
      console.log(`  ✘ emby 图片 ${label} → HTTP 404 ${shape}，索引也没有${log.clientTag(req)}`);
      return sendJson(res, 404, { error: '这张图取不到：tag 验签不过，索引里也没有' });
    }

    /* 一律 302（见上面那段）：面板只回 `Location`，字节全在源站与客户端之间跑。
     * 两条取图路（tag / 本地索引）已经在上面对 URL 做过校验，仍是这里唯一的 SSRF 防线。 */
    log.logResult(req, `图片 ${label}`, { status: 302, log: `via=${via}` });
    /* ⚠️ `Location` 里的**非 ASCII 必须先编码**（同 serveStream 那段）：HTTP 头只认 ASCII。 */
    res.writeHead(302, { Location: encodeURI(url), 'Cache-Control': 'public, max-age=86400' });
    return res.end();
  };
  r.add('GET', '/api/emby/Items/:itemId/Images/:type', imagesByType);
  r.add('GET', '/api/emby/Items/:itemId/Images/:type/:index', imagesByType);

  /* ---------------- 面板自用（非 Emby 客户端协议） ----------------
   * 这一节里的端点**都走面板门禁**（core/auth.js 的 EMBY_PANEL_RE）：Emby 客户端不该、
   * 也调不到它们；实例端口那一侧由 listener.js 的 PANEL_ONLY_RE 用同一份名单挡掉。
   * ⚠️ 必须全部注册在下面那条 ANY 通配之前，否则一律 501。
   */

  /**
   * 把处理器跑在某个实例的上下文里（见 instance.runWith）——
   * 账号、会话、播放进度、握手身份、首页插件全跟着这个实例走。
   *
   * 实例不存在就 404，**绝不回落默认实例**：面板传错 id 时要看得见错误，
   * 而不是悄悄把改动落到别人头上（那是"删错账号"级别的坑）。
   */
  const withInstance = (fn) => (req, res, ctx) => {
    const inst = instance.get(ctx.params.iid);
    if (!inst) return sendJson(res, 404, { error: '实例不存在' });
    return instance.runWith(inst, () => fn(req, res, ctx));
  };

  /** 面板对外的主机名：从请求的 Host 头取、去掉端口 —— 拼"连接地址"给用户复制用。
   * 写死 127.0.0.1 对用户没用：客户端多半在另一台机器上（面板跑在容器里更是如此）。 */
  function reqHost(req) {
    const h = String((req.headers && req.headers.host) || '').trim();
    if (!h) return '127.0.0.1';
    if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1); // IPv6 字面量
    return h.split(':')[0];
  }

  /* ---------------- 面板自用：Emby 实例（多实例） ----------------
   * 清单 = `data/emby/instances.json`（见 instance.js）；运行态 = listener.states()。
   * ⚠️ 下面那几个计数**必须在实例上下文里取**：账号与会话在各自的库里，媒体库条数跟着
   * 该实例选中的首页插件走（见 home.enabledRows）。 */
  function describeInstance(inst, req) {
    const st = listener.states()[inst.id] || {};
    return {
      ...instance.publicInstance(inst),
      running: !!st.running,
      error: st.error || '',
      url: `http://${reqHost(req)}:${inst.port}`,
      accountCount: db.countAccounts(),
      sessionCount: db.countSessions(),
      viewCount: home.enabledRows().length,
    };
  }

  const described = (inst, req) => instance.runWith(inst, () => describeInstance(inst, req));

  r.add('GET', '/api/emby/instances', (req, res) => {
    const list = instance.list().map((x) => described(x, req));
    log.logResult(req, 'Emby 实例列表', { status: 200, log: `${list.length} 个` });
    return sendJson(res, 200, { instances: list, max: instance.MAX_INSTANCES });
  });

  /* 实例编辑弹窗那个下拉用：列**所有** home 插件（含未启用的，见 home.pluginChoices） */
  r.add('GET', '/api/emby/home-plugins', (req, res) => {
    const plugins = home.pluginChoices();
    log.logResult(req, '首页插件清单', { status: 200, log: `${plugins.length} 个` });
    return sendJson(res, 200, { plugins });
  });

  /* 实例编辑弹窗那个多选用：列所有元数据域（含未启用的，见 meta.domains）—— 决定这个实例的搜索走哪些域 */
  r.add('GET', '/api/emby/meta-domains', (req, res) => {
    meta.ensureProviders();
    const domains = meta.domains().map((d) => ({ domain: d.domain, label: d.label, enabled: d.enabled, status: d.status }));
    log.logResult(req, '元数据域清单', { status: 200, log: `${domains.length} 个` });
    return sendJson(res, 200, { domains });
  });

  r.add('POST', '/api/emby/instances', async (req, res) => {
    const body = (await readBody(req)) || {};
    let inst;
    try {
      inst = await instance.add(body); // 端口留空则自己挑一个空闲的（见 instance.findFreePort）
    } catch (e) {
      console.log(`  ✘ emby 新增实例 → HTTP 400 ${(e && e.message) || e}`);
      return sendJson(res, 400, { error: (e && e.message) || '新增实例失败' });
    }
    /* 当场起监听：**失败也不回错** —— 实例已经建好了，端口被占只是运行态（面板上红字提示） */
    const up = await listener.restart(inst.id);
    console.log(`  ✔ emby 新增实例 → HTTP 200 id=${inst.id} 端口=${inst.port}${up.ok ? '' : `（未监听：${up.error}）`}`);
    return sendJson(res, 200, { instance: described(inst, req) });
  });

  r.add('PATCH', '/api/emby/instances/:iid', async (req, res, { params }) => {
    const body = (await readBody(req)) || {};
    let inst;
    try {
      /* 校验都在 instance.validate 里（名字长度 / 端口范围 / 不能占面板端口 / 端口不能与别的实例重复） */
      inst = instance.patch(params.iid, body);
    } catch (e) {
      console.log(`  ✘ emby 改实例 → HTTP 400 ${(e && e.message) || e}`);
      return sendJson(res, 400, { error: (e && e.message) || '修改实例失败' });
    }
    if (!inst) return sendJson(res, 404, { error: '实例不存在' });

    /* 端口 / 启停可能变了 —— 一律重开一次监听（restart 幂等：同端口且已在听就什么都不做） */
    const up = await listener.restart(inst.id);
    console.log(`  ✔ emby 改实例 → HTTP 200 id=${inst.id} 端口=${inst.port} 启用=${inst.enabled}${up.ok ? '' : `（未监听：${up.error}）`}`);
    return sendJson(res, 200, { instance: described(inst, req) });
  });

  r.add('DELETE', '/api/emby/instances/:iid', (req, res, { params }) => {
    /* 先停监听：否则实例文件都删了、端口上还挂着一个"属于不存在实例"的服务 */
    listener.stop(params.iid);
    let inst;
    try {
      inst = instance.remove(params.iid);
    } catch (e) {
      /* 默认实例不给删（见 instance.remove）—— 老数据的落点在它身上 */
      console.log(`  ✘ emby 删实例 → HTTP 400 ${(e && e.message) || e}`);
      return sendJson(res, 400, { error: (e && e.message) || '删除实例失败' });
    }
    if (!inst) return sendJson(res, 404, { error: '实例不存在' });
    console.log(`  ✔ emby 删实例 → HTTP 200 id=${inst.id}（该实例的账号与观看进度一并删掉）`);
    return sendJson(res, 200, { ok: true, remaining: instance.list().length });
  });

  /* ---------------- 面板自用：账号（**按实例**） ----------------
   * 账号表在**该实例自己的库**里（`dbFile`，见 instance.js），密码只有 scrypt 哈希。
   * 入参校验 + 日志都在这里；**响应与日志绝不出现密码或哈希**（对外的形状统一走 db.publicAccount）。 */
  const ACC_NAME_MAX = 64;
  const ACC_PASS_MIN = 6;

  /** 新增账号的入参校验；返回 { error } 或 { username, password } */
  function readNewAccount(body) {
    const username = String((body && body.username) || '').trim();
    const password = String((body && body.password) || '');
    if (!username) return { error: '用户名不能为空' };
    if (username.length > ACC_NAME_MAX) return { error: `用户名最长 ${ACC_NAME_MAX} 个字符` };
    if (password.length < ACC_PASS_MIN) return { error: `密码至少 ${ACC_PASS_MIN} 位` };
    return { username, password };
  }

  const isUniqueErr = (e) => /UNIQUE/i.test(String((e && e.message) || ''));

  const listAccounts = (req, res, ctx) => {
    /* UserId 是**算出来**的（md5(serverId|用户名)，见 service.userId），库里没这一列；
     * 客户端日志里只出现它，页面上带上才排查得动。 */
    const list = db.listAccounts().map((a) => ({ ...db.publicAccount(a), userId: service.userId(a.username) }));
    log.logResult(req, `账号列表 [${ctx.params.iid}]`, { status: 200, log: `${list.length} 个` });
    return sendJson(res, 200, { accounts: list });
  };

  const createAccount = async (req, res, ctx) => {
    const body = await readBody(req);
    const input = readNewAccount(body);
    if (input.error) {
      console.log(`  ✘ emby 新增账号 [${ctx.params.iid}] → HTTP 400 ${input.error}`);
      return sendJson(res, 400, { error: input.error });
    }
    if (db.findAccountByName(input.username)) {
      console.log(`  ✘ emby 新增账号 [${ctx.params.iid}] → HTTP 409 用户名已存在：${input.username}`);
      return sendJson(res, 409, { error: '用户名已存在' });
    }
    try {
      const acc = db.publicAccount(db.addAccount(input.username, input.password));
      console.log(`  ✔ emby 新增账号 [${ctx.params.iid}] → HTTP 200 id=${acc.id} user=${acc.username}`);
      return sendJson(res, 200, { account: acc });
    } catch (e) {
      /* 并发插入时唯一约束兜底（上面的查重只是给友好提示） */
      if (isUniqueErr(e)) return sendJson(res, 409, { error: '用户名已存在' });
      throw e;
    }
  };

  /* 改：username / password 各自可选（只传 password 就是改密）；两个都不传 = 没内容可改 */
  const updateAccount = async (req, res, { params }) => {
    const exists = db.getAccount(params.id);
    if (!exists) {
      console.log(`  ✘ emby 改账号 [${params.iid}] → HTTP 404 id=${params.id}`);
      return sendJson(res, 404, { error: '账号不存在' });
    }
    const body = (await readBody(req)) || {};
    const patch = {};

    if (body.username !== undefined) {
      const username = String(body.username).trim();
      if (!username) return sendJson(res, 400, { error: '用户名不能为空' });
      if (username.length > ACC_NAME_MAX) return sendJson(res, 400, { error: `用户名最长 ${ACC_NAME_MAX} 个字符` });
      const other = db.findAccountByName(username);
      if (other && Number(other.id) !== Number(exists.id)) {
        console.log(`  ✘ emby 改账号 [${params.iid}] → HTTP 409 用户名已存在：${username}`);
        return sendJson(res, 409, { error: '用户名已存在' });
      }
      patch.username = username;
    }
    if (body.password) {
      const password = String(body.password);
      if (password.length < ACC_PASS_MIN) return sendJson(res, 400, { error: `密码至少 ${ACC_PASS_MIN} 位` });
      patch.password = password;
    }
    if (!patch.username && !patch.password) return sendJson(res, 400, { error: '没有要修改的内容' });

    try {
      const acc = db.publicAccount(db.updateAccount(params.id, patch));
      const changed = [patch.username && patch.username !== exists.username ? '用户名' : '', patch.password ? '密码' : ''].filter(Boolean).join('+');
      console.log(`  ✔ emby 改账号 [${params.iid}] → HTTP 200 id=${acc.id} user=${acc.username} 改了：${changed}`);
      return sendJson(res, 200, { account: acc });
    } catch (e) {
      if (isUniqueErr(e)) return sendJson(res, 409, { error: '用户名已存在' });
      throw e;
    }
  };

  const removeAccount = (req, res, { params }) => {
    const acc = db.getAccount(params.id);
    if (!acc || !db.removeAccount(params.id)) {
      console.log(`  ✘ emby 删账号 [${params.iid}] → HTTP 404 id=${params.id}`);
      return sendJson(res, 404, { error: '账号不存在' });
    }
    /* 删最后一个也允许：删光后退化成「还没有账号 → 登录 401」，面板随时能重建 */
    console.log(`  ✔ emby 删账号 [${params.iid}] → HTTP 200 user=${acc.username} 剩余 ${db.countAccounts()} 个`);
    return sendJson(res, 200, { ok: true, remaining: db.countAccounts() });
  };

  /* 四条**都带实例维度**：面板「Emby → 账号」页顶部先选实例，下面这张表只作用于它。
   * 注册在这里 = 在下面那条 ANY 通配之前；路径里的 `:iid` 由 withInstance 翻成实例上下文，
   * 所以处理器里 db.* 取到的就是**那个实例自己的库**（见 instance.js 的 dbOf）。 */
  r.add('GET', '/api/emby/instances/:iid/accounts', withInstance(listAccounts));
  r.add('POST', '/api/emby/instances/:iid/accounts', withInstance(createAccount));
  r.add('PUT', '/api/emby/instances/:iid/accounts/:id', withInstance(updateAccount));
  r.add('DELETE', '/api/emby/instances/:iid/accounts/:id', withInstance(removeAccount));

  /* 缓存用量 / 清空**不在这一层**了：缓存跨两个库（`data/cache/detail.db` +
   * `data/emby/cache.db`），"清空"必须只有一个入口 —— 见面板层 `GET|DELETE /api/panel/cache`。 */

  /* ⚠️ 首页插件那 8 个面板自用端点（`/api/emby/home/**`）**已删** ——
   * 首页插件改造成统一插件（走插件机制装的那种）之后，装 / 卸 / 启停 / 设置全在
   * 「插件 → 管理」页上（插件自己的设置页是它自带的 webui），见
   * docs/plugin-migration-plan.md 批次 9。 */

  /* ---------------- 播放进度上报（客户端 → 落库） ----------------
   * 实测（SenPlayer 6.2.1，见 docs/playback-progress.md §11）：
   *   · 开始 1 次 `POST /Sessions/Playing`；心跳每 **10 秒** 1 次 `POST /Sessions/Playing/Progress`；结束 1 次 `…/Stopped`；
   *   · body 里 `ItemId` 就是**本面板发出去的 Id**（`{域}_{编号}_tv_s{n}_e{m}` / `{域}_{编号}_movie`），
   *     另有 `PositionTicks` / `RunTimeTicks`（**只有部分心跳带**）/ `MediaSourceId` / `PlaySessionId`；
   *   · **没有 `Played` 字段，也不带 `UserId`** ⇒ "看完"只能按比例判，账号从 token 认。
   * 三条一律回 **204 空体**（真机实测同此：它连 `Progress` 的 token 都不校验；本层按 ADR-0009 三条都校验）。
   * ⚠️ 必须注册在下面的通配之前，否则又是 501。
   */
  const playbackReport = (kind, label) =>
    r.add('POST', `/api/emby/Sessions/${label}`, async (req, res, { query }) => {
      let body = {};
      try {
        body = await readBody(req);
      } catch {
        /* body 不是合法 JSON（或读失败）→ 当空上报处理，`recordPlayback` 会如实说"Id 认不出" */
        body = {};
      }
      const out = service.recordPlayback(req, kind, body);
      log.logResult(req, `播放上报 Sessions/${label}`, out, log.queryBrief(query));
      return sendOut(res, out);
    });
  playbackReport('start', 'Playing');
  playbackReport('progress', 'Playing/Progress');
  playbackReport('stop', 'Playing/Stopped');

  /* ---------------- 观看状态的**写**端点（客户端改「继续观看」「已看」） ----------------
   * 三条都是实测在打的：
   *   · `POST Users/{UserId}/Items/{ItemId}/HideFromResume?Hide=true|false` —— Rex/0.1.0，「从继续观看里移除」；
   *   · `POST Users/{UserId}/PlayedItems/{ItemId}` —— SenPlayer/6.2.1，「标记已看」；
   *   · `DELETE Users/{UserId}/PlayedItems/{ItemId}` —— 同上，「标记未看」。
   * 一律**校验 token**（动的是某个账号的观看记录，见 ADR-0009），回 **200 + 该条目的 `UserData`**；
   * Id 认不出 → **204 且不写库**（与三条上报同口径 —— 客户端只是想让状态变一下，回错会弹错误框）。
   * ⚠️ 必须注册在下面的通配之前，否则又是 501。
   */
  r.add('POST', '/api/emby/Users/:userId/Items/:itemId/HideFromResume', (req, res, { params, query }) => {
    /* `Hide` 缺省当 true —— 端点名字就是 Hide，客户端只在要恢复时才带 `false` */
    const hide = String(query.get('Hide') || '').toLowerCase() !== 'false';
    const out = service.setHiddenFromResume(req, params.userId, params.itemId, hide);
    log.logResult(req, `继续观看开关 Users/…/Items/${params.itemId}/HideFromResume`, out, log.queryBrief(query));
    return sendOut(res, out);
  });

  /* 标记已看 / 未看：同一个处理器，只差 `played`（真机是 POST = 已看、DELETE = 未看） */
  const playedItems = (played) => (req, res, { params, query }) => {
    const out = service.setPlayed(req, params.userId, params.itemId, played);
    log.logResult(req, `标记${played ? '已看' : '未看'} Users/…/PlayedItems/${params.itemId}`, out, log.queryBrief(query));
    return sendOut(res, out);
  };
  r.add('POST', '/api/emby/Users/:userId/PlayedItems/:itemId', playedItems(true));
  r.add('DELETE', '/api/emby/Users/:userId/PlayedItems/:itemId', playedItems(false));

  /* ---------------- 通配：其余一切 /api/emby/** ---------------- */

  r.add('ANY', '/api/emby/*rest', async (req, res, { pathname, query }) => {
    let body = null;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      try {
        body = await readRawBody(req, 1024 * 1024);
      } catch {
        body = '(请求体读取失败)';
      }
    }
    return notImplemented(req, res, { pathname, query, body });
  });
};
