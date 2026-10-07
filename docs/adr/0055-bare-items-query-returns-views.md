# ADR-0055 无 `ParentId` 的裸 `Items` 查询回顶层库列表

- 状态：已采纳（取代 [0054](0054-bare-items-query-uses-random-feed.md)）
- 相关：[0008](0008-no-fabricated-data.md)（不编数据）、[0048](0048-emby-userid-not-identity.md)（读取类只验 token）、[0054](0054-bare-items-query-uses-random-feed.md)（被本条取代）

## 背景

`Users/{UserId}/Items` 有不带库 Id 的两类查询：

- **轮播推荐位**：`SortBy=IsFavoriteOrLiked,Random`（Rex 首页第一发，喂顶部轮播图）。
- **裸列表查询**：只带 `ExcludeItemTypes` / `StartIndex` / `Limit` / `Fields` 这类"要一批条目"的通用参数，**不指名任何库**（Filmly / 网易爆米花首页首发即是）。

早期两类都落「其余查询 → 回空」，Filmly 首页空白。上一轮依 [ADR-0054](0054-bare-items-query-uses-random-feed.md) 把裸查询也路由到插件声明 `feed: 'random'` 的行，**回条目**（方案 A）—— 但那是在**没有真机样本**下的推断。

本轮用同一条裸查询打**予初Emby 4.9.5.0**，结论与之相反：真机回**26 个 `CollectionFolder`（＝顶层库列表）**，与 `GET /Users/{id}/Views` **一字不差**（同 `Id`/`Name`/`Type`）。即真机对「无 `ParentId` 且**不递归**」的 `Items` 默认回**根节点的直接子级**（那些库）；要条目，客户端得自带 `Recursive=true`（轮播推荐位那条就带）。方案 A 判据错误。

## 决定

把裸列表查询从「路由 `feed: 'random'` 回条目」改为**回顶层库列表**：`service.libraryQueryOf(query)` 命中即 `return getViews()`（复用 `Views` 那支，条目形状、`TotalRecordCount` 与 `Views` 完全一致）。`feedOfQuery()` 相应**收窄回只认轮播推荐位**。

**`libraryQueryOf` 的判据**（**无 `ParentId`**、**无 `SortBy`**、**非 `Recursive=true`**，且**不含** `Filters` / `SearchTerm` / `AnyProviderIdEquals` / `Ids`，也**不是**按类型计数探针）—— 取**最窄档**：真机那条样本只隔离出「无 `ParentId` + 不递归」两个条件，`SortBy` 这一条是「轮播族有、裸查询无」的既有区分，一并保留以避免误伤轮播推荐位。

## 理由

- **对齐真机**：真机怎么回，面板怎么回 —— 这是兼容层的根本目标，胜过任何内部推断。方案 A 是"没有样本时的猜测"，一旦有样本就必须让位。
- **零回归**：判据取最窄档，只命中「Filmly / 网易爆米花裸查询」那一族；轮播推荐位（带 `SortBy`）、`ParentId` / `Filters` / `SearchTerm` / `AnyProviderIdEquals` / `Ids` / 计数探针各支路**一律不受影响**。
- **不编数据**：回的就是 `Views` 那支的真实库列表（来自启用的首页插件行），没有臆造内容（[ADR-0008](0008-no-fabricated-data.md)）。
- **鉴权口径不变**：仍是读取类，**只验 token、不比对 `UserId`**（[ADR-0048](0048-emby-userid-not-identity.md)）。

## 备选

- **维持方案 A（裸查询路由 `feed: 'random'` 回条目）**：与真机相反 —— 真机回库、面板回条目，Filmly 拿库列表时会拿到混装的条目，首页归类错乱。**没选**（被真机证伪）。
- **裸查询继续回空**：Filmly 首页永远空白，等于放弃这个客户端。**没选**。
- **回根节点全部子级（含非库项）**：真机那条样本只出现 `CollectionFolder`，面板的顶层恰好就是各首页插件行（`Views` 同款），无需另造层级。**没选**。

## 后果

- 对客户端是**新可见行为**：无 `ParentId` 的裸列表查询由「路由 `feed: 'random'` 回条目」变为**回顶层库列表**（与 `Views` 一致）。属契约变更，已在 [docs/emby-compat.md](../emby-compat.md) 的契约变更记录里声明。
- **`feedOfQuery` 与 `libraryQueryOf` 是一对**：前者只认轮播推荐位，后者只认裸查询；新增支路时必须同时照看这两处，别让某一支被误吸。
- 「裸列表查询」的读类口径仍**只验 token、不比对 `UserId`**（[ADR-0048](0048-emby-userid-not-identity.md)）。
- **未复测项**：真机只隔离出「无 `ParentId` + 不递归」两个条件；`SortBy` 是否为必要条件未单独验证（真机不稳，未补测）。当前按最窄档实现，零回归风险。
