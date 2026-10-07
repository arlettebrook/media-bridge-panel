# #5 `GET /api/emby/Users/{UserId}/Items`（条目列表）

> 索引：[emby-compat.md「十、真机对照记录」](../emby-compat.md)


**真机样本**（OkEmby 4.9.1.90；予初Emby 4.9.5.0 —— 早期一度不可达（TCP/TLS 全超时），后恢复；**裸列表查询**那条样本即取自予初Emby，见下表第 23 行）

**错误分支**

| 场景 | 含义 / 客户端用途 | 真机 | 面板 | 处理 |
|---|---|---|---|---|
| 无 token（**任何分支**，含 `Filters=IsFavorite`、无参、`ParentId`、`SearchTerm`） | 全局守卫，客户端回登录页 | **401 纯文本** `Access token is invalid or expired.` | **只在"会出数据"的支路 401**；空分支（`Filters=IsFavorite`、认不出的查询）**不校验**，回 200 空 | **待定夺**（见下 5-1） |
| **有效 token + 合法但不存在的 UserId**（32 位 hex Guid） | 真机**不校验 UserId 与 token 的匹配** | **200 照常回数据**（库内容、搜索都出） | 出数据支路上 `assertUser` → **404 JSON** | **待定夺**（见下 5-2，与 #4-3 同款） |
| 有效 token + 非法格式 UserId（如 `WRONGID`） | 真机把 UserId 当 Guid 解析 | **500 纯文本** `Unrecognized Guid format.` | 404 JSON | 不模拟（面板 UserId 是任意字符串、无 Guid 概念；若 5-2 放宽则此分支在面板上自然消失为 200，属"比真机宽松"，客户端无感知） |

**成功分支**

| 查询形状 | 含义 / 客户端用途 | 真机 | 面板 | 处理 |
|---|---|---|---|---|
| `ParentId=<库Id>`（不递归） | 客户端点进一个库 | **子文件夹层级**：回 `Type:Folder` 的子文件夹（本样本每个库下 1 个虚拟子文件夹），**无真实条目**；真实条目要递归或再下钻两层（库→子文件夹→影片文件夹→条目） | **平铺真实条目**（首页行即列表） | 保留（面板刻意平铺 —— 行就是内容本身，没有目录树可下钻；客户端实测正常消费） |
| `ParentId=<库Id>&Recursive=true&IncludeItemTypes=Movie` | 库内全部电影 | 真实条目；**无 `Fields` 时只回 10 键列表级字段**：`Name/ServerId/Id/RunTimeTicks/IsFolder/Type/UserData/ImageTags/BackdropImageTags/MediaType`（`Overview/Genres/ProviderIds/ProductionYear` 等要 `Fields=` 显式要才给） | **一律回全量 ~25 键**（`baseItem` 恒含 `Overview/Genres/ProviderIds/ExternalUrls/…`） | 保留（超集无害：多给字段客户端不报错；面板无 `Fields` 裁剪机制，加了反而可能饿着某些客户端） |
| 推荐查询（无 `ParentId` + `SortBy=IsFavoriteOrLiked,Random&Recursive=true`） | Rex 等客户端首页第一发的推荐位 | 回 **Episode 级**条目（`Type:Episode`，带 `SeriesId/SeasonId`），`TotalRecordCount=111786` | 路由到插件声明 `feed:'random'` 的行，回行内条目（Movie/Series 级） | 保留（各为其主：真机从全库随机抽，面板由首页插件决定喂什么；客户端只消费列表形状） |
| 裸列表查询（**无 `ParentId` + 无 `SortBy`**，只带 `ExcludeItemTypes`/`StartIndex`/`Limit`/`Fields`） | Filmly / 网易爆米花首页首发的通用列表查询（此前落「其余查询 → 空」→ 首页空白） | **予初Emby 4.9.5.0 实测：回 26 个 `CollectionFolder`（＝顶层库列表），与 `GET /Users/{id}/Views` 一字不差（同 `Id`/`Name`/`Type`）** —— 真机对「无 `ParentId` 且不递归」的 `Items` 默认回根节点的直接子级，即那些库；要条目客户端须自带 `Recursive=true`（轮播推荐位那条就带） | **改**：`service.libraryQueryOf(query)` 命中即 `return getViews()`（回库列表，复用 `Views` 那支） | **改**：由「路由 `feed:'random'` 回条目（ADR-0054 方案 A）」改为**回库列表**，对齐真机；本地已验（裸 `Items` 与 `Views` 均回 11 个库，一字不差）；见 [ADR-0055](../adr/0055-bare-items-query-returns-views.md) |
| `Filters=IsFavorite&Recursive=true` | 收藏夹 | `Total=0` 空（该账号无收藏） | 空（无收藏数据） | 一致 |
| `Filters=IsPlayed&Recursive=true` | 已看列表 | 真数据（`Total=20`，`Type:Series` 等） | 真数据（`playback` 表） | 一致 |
| `SearchTerm=斗破&IncludeItemTypes=Movie,Series` | 按名字搜 | 命中 2 条真实条目（`Series 斗破苍穹`、`Movie 斗破乱世情`），**`TotalRecordCount=0`（疑似真机 bug：count 与 items 不一致）** | 命中条目，`TotalRecordCount` 与条数一致 | 一致（不回真机那个 0 —— 面板行为更正确，客户端拿 `TotalRecordCount` 做分页/计数，回 0 反而坑） |
| `SearchTerm=x`（无命中） | 搜索无结果 | **回 12 个根库 CollectionFolder**（把无命中当无过滤根查询，疑似该中转服务的怪癖） | `Items:[]` 空 | 保留（回空是正确语义；客户端拿到 12 个库只会困惑） |
| `AnyProviderIdEquals=imdb.tt1234567`（编造 id） | 按外部 id 定位条目 | **忽略该参数**，回 12 个根库 CollectionFolder | 认 `{域}.{编号}` → 回 1 条带面板 Id 的条目（Rex 客户端实测依赖，见「五」） | 保留（面板是功能增强：真机客户端不走这条路所以它不实现；Rex 走，断它则 Rex 详情链断） |
| `IncludeItemTypes=Movie`（无 `ParentId`，`Recursive=true&Limit=1&SortBy=SortName&SortOrder=Ascending`） | Rex 等客户端首页「总统计」探针（**只读 `TotalRecordCount`**） | **该类型库总数**（itsmygo `255` / nyamedia `714`），`Items` 回 1 条（`Limit=1` 的痕迹） | 落到「没有可识别的查询参数 → 空」，`TotalRecordCount=0`（**客户端总统计恒显示 0**） | **改**：取 `home.libraryTotals().movies` 回 `TotalRecordCount`（同 `Items/Counts` 口径）；`Items` 仍回空（**不给样本条目** —— 用户定夺，不复刻真机那 1 条）；本地已验（tmdb `1254147`），真机复测待做 |
| `IncludeItemTypes=Series`（同上，仅类型不同） | 同上 | **该类型库总数**（itsmygo `189` / nyamedia `1635`），`Items` 回 1 条 | 同上回 0 | 同上：取 `home.libraryTotals().tvshows`；本地已验（tmdb `233207`），真机复测待做 |

**真机条目字段补充观察**：`Filters=IsPlayed` 与推荐查询回的条目带 `Guid`、`ParentLogoItemId`、`ParentBackdropItemId`、`SeriesPrimaryImageTag` 等（随 `Type` 与 `Fields` 浮动）；`UserData` 恒为 `{PlaybackPositionTicks, PlayCount(部分分支缺), IsFavorite, Played}` —— 面板 `emptyUserData()` 同此四键，一致。

**不能模拟**：真机的目录树结构（库→子文件夹→影片文件夹）、`TotalRecordCount=111786` 量级的**真实全库计数**（`ParentId` 支路的列表计数仍不可模拟；**无 `ParentId` 的按类型探针除外** —— 那两条已改为取插件申报的库规模，见上表）、真机响应里探针顺带回的那 1 条 `Items`（面板回空）、真机多出的 `StartIndex` 键（面板各分支一致地不加）、`Guid` 字段（面板 Id 非 Guid 形状）、真机搜索结果 `TotalRecordCount=0` 那个 bug（不模拟，见上）。

**已按用户确认改（3 点）**：
- 5-1 **已改**：无 token **一律 401**（对齐真机，不再分"回空/出数据"支路）—— Items 路由的守卫从 `if (itemsWillReturnData(query)) authorize(…)` 改为无条件 `authorize(req)`（401 纯文本形状 #3 已有）。`itemsWillReturnData` 判据函数只剩 `Items/Latest` 路由在用（该端点留待后续对照）。用户附注：「收藏」后续会实现，届时本就要校验，口径不冲突。
- 5-2 **已改**：UserId 校验放宽（与 #4-3 同一把尺子）—— Items 路由 `authorize(req, params.userId)` → `authorize(req)`（只验 token）；`getItems` 删掉 `assertUser` 并改收 `req`（`Filters=IsPlayed` 分支的账号认定从 `resolveAccountById(UserId)` 换成 `accountIdFor(req, …)`：**token 优先**、UserId 兜底，与 NextUp 同款）；`getSearchItems` 的 `assertUser` 一并删（搜索是出数据支路，路由层已验 token）。「UserId 不存在 → 404」分支在 Items 上消失，与真机一致（真机 500 `Unrecognized Guid format.` 那个分支不模拟，面板上自然成为 200）。

- 5-3 **已改**：补「按类型计数探针」分支（用户定夺：**只给数字、不给样本条目**）—— 无 `ParentId` + `IncludeItemTypes` 归一后是**单一** `Movie` / `Series`（且无 `AnyProviderIdEquals`）时，取 `home.libraryTotals()` 的库规模回 `TotalRecordCount`（`movies` / `tvshows`，与 `Items/Counts` 同一份数据，见 [ADR-0052](../adr/0052-items-counts-library-total.md)）；`Items` 仍回空。落码：`service.typeCountProbeOf(query)` + `getItems` 兜底分支。只认**单类型** —— `Movie,Series` 多值不猜（无样本）。
- 5-4 **已改（方案 A，后被推翻 → 现为回库列表）**：上一轮曾把 `feedOfQuery` 判据放宽 —— **无 `ParentId` 的裸列表查询**与轮播推荐位共用 `feed: 'random'`（回条目），见 [ADR-0054](../adr/0054-bare-items-query-uses-random-feed.md)。**予初Emby 实测证伪**：裸列表查询真机回的是**库列表**（26 个 `CollectionFolder`），不是条目。现改为 **`service.libraryQueryOf()` 命中即回库列表**（复用 `Views` 那支），`feedOfQuery` 收窄回**只认轮播推荐位**；见 [ADR-0055](../adr/0055-bare-items-query-returns-views.md)（取代 ADR-0054）。本地已验。

**状态：面板端已验；真机批量复测待做**（5-1 / 5-2 / 5-3 已落码，`npm run check` 零告警；5-3 本地端到端实测〔tmdb 实例〕：`IncludeItemTypes=Movie` → `TotalRecordCount=1254147`、`Series` → `233207`，与 `Items/Counts` 的 `MovieCount` / `SeriesCount` 一致，`Items:[]`；`Movie,Series` 多值与无参兜底仍回 0。5-4 已按予初Emby 实测改正为**回库列表**，本地端到端实测〔emby 实例〕：裸 `Items` 与 `Views` 均回 11 个 `CollectionFolder`、一字不差，`api_key`-only 不再 500，轮播族 `SortBy=IsFavoriteOrLiked,Random` 仍走 `feed:'random'` 行；予初恢复后再补真机复测。）
