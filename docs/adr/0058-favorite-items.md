# ADR-0058 收藏：收藏时快照元数据落库，读侧只吃这份「用户数据」

- 状态：已采纳
- 相关：[0023](0023-playback-progress.md)（观看进度：写端点 + 落库的先例）·
  [0008](0008-no-fabricated-data.md)（不编数据）· [0009](0009-unauthenticated-empty-responses.md)
  （真数据必须校验账号）· [0011](0011-cache-split-by-consumer.md)（缓存与用户数据分库）·
  [0007](0007-emby-dto-shape.md)（DTO 形状）· [0056](0056-emby-compat-scope.md)（收藏=界内）·
  [真机对照 #21](../emby-realdevice/21-favorite-items.md) ·
  [db.js](../../server/modules/emby/db.js)（`favorite` 表）·
  [service.js](../../server/modules/emby/service.js)（`setFavorite` / `listFavorites` / `progressOf`）·
  [routes.js](../../server/modules/emby/routes.js)（写端点）

## 背景

客户端能收藏条目（`POST|DELETE /Users/{UserId}/FavoriteItems/{ItemId}`），也能按收藏筛列表
（`Items?Filters=IsFavorite`）。面板此前两条都没接：写端点落到 501 通配，读侧 `Filters=IsFavorite`
**如实回空**（[0056](0056-emby-compat-scope.md)：界内、待补）。于是收藏列表永远是空的。

收藏与观看进度（[0023](0023-playback-progress.md)）是同一类东西：**用户数据**，按账号归属，
要增删改。但**读侧的数据来源不同**：

- 进度读侧要「按坐标反查元数据」（`progressItem` 逐条打上游）—— 因为库里只存了坐标与位置，
  名字 / 封面仍要去元数据插件取，一条一次，**列表 1 → N 扇出**；
- 收藏如果照抄，也会变成同样的 1 → N 扇出，且一旦上游那一条挂了（改名 / 下架 / 插件没启用），
  列表里那一条就**列不出来**（[0008](0008-no-fabricated-data.md)：不编名字、不编封面）。

用户对收藏的要求是：**收藏时就把元数据存下来，取消时删掉，收藏有独立的数据来源；这份数据不随
缓存清理**（它是用户数据，不是缓存）。也就是说，收藏列表**不从上游重查**。

## 决定

**收藏动作发生时快照该条目的列表元数据，落到 `emby.db` 的 `favorite` 表；收藏列表只读这份快照，
0 上游请求。**

- **存储**：`data/emby/emby.db` 新增 `favorite` 表（`SCHEMA_VERSION` 4 → 5）：
  `account_id, item_id, payload(JSON 快照), updated_at`，主键 `(account_id, item_id)`，**覆盖写**。
  与 `accounts` / `sessions` / `playback` **同库** —— 这份库整体是**用户数据**（进整份数据卷备份），
  与可清理的缓存（`data/cache/*`）分开，所以**不随缓存清理**。
- **关联键用 `account_id`**（同 [0023](0023-playback-progress.md)：`user_id` 会因 serverId / 改名而变）。
- **`removeAccount` 一并清收藏**（账号没了，那些行就是没人认领的数据，与 `playback` 同处理）。
- **快照内容 = 列表项所需的中立元数据**（`domain` / `type` / `entryId` / `title` / `year` / `overview` /
  `communityRating` / `posterPath` / `backdropPath` / `seasonCount` …，即 `metaBridge.lookup` 的中立形状里
  列表要用的那几个字段）。**图片地址不入快照**（存 `posterPath` 这类路径，读时按当前域的
  `imageBase` 现拼）—— 域换了图片基地址，列表跟着变，不会存下一串死链。
- **写端点 `POST|DELETE /Users/{UserId}/FavoriteItems/{ItemId}`**：
  - 先 `authorize`（校验 token，动的是某账号的收藏）→ `sessionOf`；
  - `POST`：认 Id → **反查元数据 → 快照 upsert**；`DELETE`：认 Id → **删行**（不反查）；
  - 回 **200 + `UserItemDataDto`**（真机实测两条都是 200，形状见 [#21](../emby-realdevice/21-favorite-items.md)）；
  - **Id 认不出 / 反查失败 → 204 且不写库**（与 `PlayedItems` / `HideFromResume` 同口径）。
  - 认的 Id 形状**放宽到 `movie` / `show` / `season` / `episode`**：真机写端点与条目类型无关，
    2026-10-07 于 OkEmby 实探四类各 `POST` 一次均 200（见 [#21](../emby-realdevice/21-favorite-items.md)），
    故面板不得像 `playableOf()` 那样只认「可播 Id」（电影 / 集）。收藏用**单独**的 Id 解析，不复用 `playableOf`。
- **读侧 `Items?Filters=IsFavorite`**：只读快照 → 按域 + 坐标用 `leanItemDto` 重建列表项
  （纯 CPU、0 上游请求）→ `QueryResult<BaseItemDto>`。**不逐条反查**，因此不存在 1 → N 扇出，
  也不存在「上游没了就列不出来」。
- **`UserData.IsFavorite` 出真值**：`progressOf` 里写死的 `IsFavorite: false` 改成读 `favorite` 表
  （有行 = true）。这样列表 / 详情 / 季 / 集各处条目的 `IsFavorite` 一致。
- **快照只服务于「收藏列表」**：条目**详情**（`GET /Items/{ItemId}`）仍走既定反查路径（`richItemDto`），
  不因收藏而改。

## 理由

- **用户数据不随缓存清理**：放进 `emby.db`（用户数据卷）而不是缓存库，符合
  [0011](0011-cache-split-by-consumer.md) 的分库取向；备份 / 换机后收藏还在。
- **收藏是低频显式动作，写时快照不亏**：一次收藏 = 一次反查，量级 1 → 1；而读侧（客户端拉收藏列表）
  更频繁，把它做成 0 上游请求，是这份数据的自然形态。
  （[0023](0023-playback-progress.md) 里「写时快照」曾被否，是因为进度**心跳每 10 秒一条**、写路径变重；
  收藏没有那个频率，取舍相反。）
- **列表不再受上游波动影响**：改名 / 下架 / 插件临时没启用，都不影响已经收藏的那条怎么显示 ——
  「收藏过」这一事实由面板自己记着。

## 硬约束（落码不得违反）

- **分库边界按「能否一键清空」划，不按文件大小划**：收藏（及账号 / 进度）只进 `emby.db` 这份
  **用户数据**，**绝不进** `cache.db` / `cache/lines.db` / 插件缓存。判据是运维动作
  `/api/panel/cache` 的语义 —— 它清缓存时，账号 / 进度 / 收藏必须**原封不动**
  （[panel/routes.js](../../server/modules/panel/routes.js) 那句「账号不受影响」）。不得为了「少一个库文件」
  把用户数据塞进缓存库（见 [0011](0011-cache-split-by-consumer.md)）。
- **`emby.db` 内部不再拆文件**：`accounts` / `sessions` / `playback` / `favorite` **同库分表**。
  它们共享同一失效与备份单位（都不可删、同进整份备份、同属一个实例），拆成多文件只让
  「备份 / 迁移 / 换实例」从「复制一个文件」变成多文件事务，收益为零。
- **`payload` 只存「列表字段」，不存 rich**：快照只放列表渲染所需的中立字段
  （`domain` / `type` / `entryId` / `title` / `year` / `overview` / `communityRating` /
  `posterPath` / `backdropPath` / `seasonCount` …），**不得**存 `metaBridge.lookup({rich:true})`
  那批（分级 / 时长 / 标语 / 演职 / 公司 / 关键词 / 预告 / 图集 / 相似）。条目**详情**
  （`GET /Items/{ItemId}`）走既有 `richItemDto` 反查，与快照无关。
  理由：`favorite` 是本方案里**唯一**随「用户数 × 收藏数」增长的存储，单条快照要压在
  几百字节～1KB 量级（1000 用户 × 200 收藏 × ~1KB ≈ 200MB 封顶）。

## 备选

- **照抄进度（读时逐条反查）**：实现最省事，但列表 1 → N 扇出（触发 [AGENTS](../../AGENTS.md)
  的「扇出放大」红线，且收藏是个用户会反复打开的列表），且上游一波动就漏条目。**否**。
- **`payload` 存已经拼好的 `BaseItemDto`**：读侧最省事（直接吐）。代价是图片地址被烤进快照，
  域换图片基地址后列表里是死链。**否**，改存中立元数据、读时现拼。
- **收藏只认电影 / 集（复用 `playableOf`）**：与播放入口同口径，实现更简单。但收藏的常见对象就是**剧**，
  只认电影 / 集会漏掉「收藏整部剧」。**否**，放宽到剧 / 季 / 集。

## 后果

- **快照会与上游的后续变化脱节**：上游改了条目名 / 封面，已收藏的那条**仍显示收藏当时的元数据**，
  直到用户取消再重新收藏。这是「独立数据来源」的代价，也是它的定义（与 [0023](0023-playback-progress.md)
  否掉「写时快照」的理由相反，此处**接受**）。
- **取消收藏 = 删行**：没有 tombstone；重新收藏会**按当时的元数据**重新快照。
- **`SCHEMA_VERSION` 4 → 5**：新表用 `CREATE TABLE IF NOT EXISTS` 即可，从 v4 升上来不必搬数据
  （新表而已，同 `sessions` 当初）。
- **契约变更**：`Filters=IsFavorite` 从「必然空」变成「真数据」，写端点从 501 变成 200 ——
  须同步 [emby-compat.md](../emby-compat.md)（含「契约变更记录」）与 [CHANGELOG.md](../../CHANGELOG.md)，
  并把 [0056](0056-emby-compat-scope.md) 里收藏那一行的「待补」改掉（见 [AGENTS](../../AGENTS.md)）。
