# Emby 语义类清单

本文件把 Emby 兼容层按**语义类**登记：一类客户端语义由哪些入口端点表达、收敛到哪个唯一内部实现、
返回什么 DTO 形状、真机样本在哪。**只登记，不改行为。**

存在的理由：客户端能从多条端点拿到同一语义（Emby 的对象模型里，「库列表」不是独立资源，而是根节点的
直接子级，被 `Views` / 裸 `Items` / `Library/MediaFolders` 等多条端点冗余暴露），逐条端点补丁会一直追加。
按语义类归位后，撞到新表达方式时先判「归到哪一类」，再决定是**转发到既有实现**还是**新增一支**。

**边界**：本文件是**登记表**，不是契约正文。端点的入参 / 响应 / 鉴权口径 / 失败语义以
[emby-compat.md](emby-compat.md) 为准；真机逐字段差异以 [emby-realdevice/](emby-realdevice/) 为准。
本文件只回答「哪条 query 归哪一支、由哪个实现承接」。

## 一、语义类

| 语义类 | 含义 | 唯一实现 | 入口端点 / query 形状 | DTO 形状 | 真机样本 |
|---|---|---|---|---|---|
| ① 库列表 | 根节点的直接子级（"有哪些库"） | `service.getViews()` | `GET /Users/{UserId}/Views`；`GET /Users/{UserId}/Items`（无 `ParentId` 且不递归）；真机另有 admin 口 `Library/MediaFolders`、`Items/Root` | `QueryResult<BaseItemDto>`，条目 `Type=CollectionFolder` | [#4](emby-realdevice/04-users-userid-views.md) / [#5](emby-realdevice/05-users-userid-items.md) |
| ② 条目列表 | 按坐标取一组条目（库内 / 最新 / 季 / 集 / 相似） | `home.listByQuery()`（库内）；`service.getLatest()`；`service.getSeasons()`；`service.getEpisodes()`；`service.getSimilar()` | `GET /Users/{UserId}/Items?ParentId=<库Id>`；`GET /Users/{UserId}/Items/Latest`；`GET /Shows/{Id}/Seasons`；`GET /Shows/{Id}/Episodes?SeasonId=`；`GET /Items/{ItemId}/Similar` | `QueryResult<BaseItemDto>`（`Latest` 回裸数组） | [#5](emby-realdevice/05-users-userid-items.md) / [#6](emby-realdevice/06-users-userid-items-latest.md) / [#7](emby-realdevice/07-shows-seasons.md) / [#8](emby-realdevice/08-shows-episodes.md) / [#17](emby-realdevice/17-items-similar.md) |
| ③ 条目详情 | 单个条目的完整 `BaseItemDto` | `service.getItem()`（DTO 组装在 `richItemDto()`） | `GET /Users/{UserId}/Items/{ItemId}` | 单个 `BaseItemDto` 本体（不包 `QueryResult`） | [#10](emby-realdevice/10-items-itemid-detail.md) |
| ④ 观看进度 | 用户私有进度（继续观看 / 接下来看 / 已看 / 隐藏） | `playback` 表族：`progressItem()` / `progressList()` / `applyUserData()` / `recordPlayback()` | `GET /Users/{UserId}/Items/Resume`；`GET /Shows/NextUp`；`GET /Users/{UserId}/Items?Filters=IsPlayed`；`POST /Sessions/Playing[/Progress|/Stopped]`；`POST|DELETE /Users/{UserId}/PlayedItems/{ItemId}`；`POST /Users/{UserId}/Items/{ItemId}/HideFromResume` | `QueryResult<BaseItemDto>` / `UserItemDataDto` / 204 | [#13](emby-realdevice/13-users-userid-items-resume.md) / [#15](emby-realdevice/15-shows-nextup.md) |
| ⑤ 播放 / 取源 | 版本清单与取字节 | 源绑定链：`buildMediaSource()` → `getPlaybackInfo()` → `resolveStream()` | `POST /Items/{ItemId}/PlaybackInfo`；`GET /Items/{ItemId}/Stream[/{token}]`；`GET /videos|Videos/{ItemId}/stream[.ext]`；`GET /Items/{ItemId}/Download` | `PlaybackInfoResult` / 302 / 字节 | [#11](emby-realdevice/11-items-playbackinfo.md) / [#12](emby-realdevice/12-direct-stream.md) |

## 二、扇出敏感支路清单

**判定口径**：一个客户端请求会变成 N 个上游请求（N 随条数 / 线路数增长），且真机同位置是**本地索引一次给全部**的，
即为扇出敏感。这类差异属**要保留**、不属要对齐 —— 对齐即把一次查表放大成逐条目扇出，有源站限流 / 封号风险。
改动这些支路前先说明扇出倍数与受影响端点，等确认再动（规则见 [AGENTS.md](../AGENTS.md)）。

| 支路 | 客户端请求 | 面板上游扇出 | 真机同位置 | 处置 |
|---|---|---|---|---|
| 版本清单 | `POST /Items/{ItemId}/PlaybackInfo`，或带 `Fields=MediaSources` 的条目查询 | 1 → 聚合搜索定位片源（逐条目；多线路再逐线路） | 本地文件索引一次返回全部版本 | **保留**。对齐即放大，须先确认 |
| 取字节 | `GET /videos|Videos/{ItemId}/stream[.ext]`、`Items/{ItemId}/Stream[/{token}]`、`Items/{ItemId}/Download` | 1 → 聚合 + `play`，可能再定位一次 | 直接给文件字节 | **保留**。且面板不扛流量、一律 302（[ADR-0006](adr/0006-redirect-for-playback.md)） |
| 继续观看补元数据 | `GET /Users/{UserId}/Items/Resume` | 1 → N 次元数据 lookup（每条进度一行） | 本地索引 | **保留**。不为此改行为 |
| 接下来看补元数据 | `GET /Shows/NextUp` | 0（端点在，但**恒回空**，不再逐集 `episodeExists()`） | 本地索引 | **已消解**。按 [ADR-0060](adr/0060-nextup-hidden.md) 端点保留、对外恒空，算「该看哪一集」的实现留着但暂不调用 |
| 库封面 | `GET /Users/{UserId}/Views` | 0（只读本地缓存与图片索引） | 本地 | **已消解**。绝不为了封面单独打上游（详见 [emby-compat.md](emby-compat.md)「库封面」） |

> 取源族（⑤）整支都是扇出敏感：真机与服务端的差别不在协议形状，而在**数据从哪来** ——
> 真机的源是本地文件索引，面板的源来自插件聚合搜索，天生逐条目。

## 三、收敛纪律

把「条目列表 / 详情 / 季集」收敛到统一分派时，统一的是**分派**（哪条 query 归哪一支、走哪个实现），
保留的是**已登记语义**（[emby-realdevice/](emby-realdevice/) 每条「处理」列就是既定口径）：

- 照搬已登记口径，收敛过程中**不擅自改对外行为**（如 `Items?ParentId` 不递归时面板平铺条目、
  无 `Fields` 时面板回字段超集 —— 均为已登记、保留）。
- **不得擅动扇出敏感支路**（见上表）。
- 触及**未覆盖的新形状**时，先按 [emby-compat.md](emby-compat.md)「十」的约定登记差异、再改码。

分派落点（「哪条 query / 哪种 id 形状归哪一支」只此一处，路由层与 service 共用）：

- **条目列表**：`server/modules/emby/service.js` 的 `itemsQueryBranch(query)` —— 认这条 query 归哪一支，
  `getItems` 只照它给的支路干活（次序与判据都收在那里）。
- **详情 / 季 / 集**：`server/modules/emby/meta-bridge.js` 的 `parseItemId()` 回的 `shape`
  （`movie` / `show` / `season` / `episode`）—— 调用方照 `shape` 分派，不各自去拼 `type` / `season` / `episode` 重推。
