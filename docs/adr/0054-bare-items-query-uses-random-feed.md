# ADR-0054 无 `ParentId` 的裸列表查询复用 `feed: 'random'`

- 状态：已被取代（被 [0055](0055-bare-items-query-returns-views.md) 取代 —— 予初Emby 实测证明裸列表查询真机回**库列表**而非条目）
- 相关：[0008](0008-no-fabricated-data.md)（不编数据）、[0051](0051-home-row-declared-total.md)（首页行可申报库总数）、[0052](0052-items-counts-library-total.md)（`Items/Counts` 取首页申报的库规模）、[0053](0053-home-row-declared-episodes.md)（同一条路子延伸到集数）

## 背景

`Users/{UserId}/Items` 有**两类**查询都不带库 Id，早期一律回空：

- **轮播推荐位**：`SortBy=IsFavoriteOrLiked,Random`（Rex 首页第一发，喂顶部轮播图）。
- **裸列表查询**：只带 `ExcludeItemTypes` / `StartIndex` / `Limit` / `Fields` 这类"要一批条目"的通用参数，**不指名任何库**（Filmly / 网易爆米花首页即是：无 `ParentId`、无 `SortBy`、无 `Filters`、无 `SearchTerm`）。

推荐位此前已路由到**插件声明了 `feed: 'random'` 的那一行**；裸查询没有归宿，命中「其余查询 → 空」，于是 Filmly 首页一片空白（`Items: []`、`TotalRecordCount: 0`）。

面板自己**不知道**"这一行内容该是什么"，这条信息只有插件作者掌握 —— 但插件契约里**没有**"裸列表查询"对应的 `feed` 取值。要在不新增契约字段的前提下让裸查询有归宿，只有三种做法。

## 决定

把 `feedOfQuery()` 的判据**从"推荐位"放宽到"推荐位 + 裸列表查询"**：只要**不指名库**、也不是任何一条**已有专属支路**的查询（见下），就归 `'random'`，路由到**插件声明了 `feed: 'random'` 的那一行**。两类共用同一个 `feed` 取值，**不新增 `feed` 取值、不改插件契约**。

**让路的支路**（命中则不进 `'random'`，各自照旧处理）：

- 有 `ParentId`（**含不是本面板的**）→ 正常按库取；
- 有 `Filters`（收藏 / 已播放）；
- 有 `SearchTerm`（按名字搜）；
- 有 `AnyProviderIdEquals`（按外部 id 定位，含认不出的那串）；
- 有 `Ids`（按条目 id 点名要，**不是**"要一批条目"，维持回空）；
- 无 `ParentId` 的**按类型计数探针**（`IncludeItemTypes` 归一后单一 `Movie` / `Series`）→ 取库规模回 `TotalRecordCount`。

## 理由

- **零跨仓库成本**：复用既有 `feed: 'random'`，插件契约不动、插件不用改、不发新版本。新增 `feed` 取值（方案 C）要改插件仓库契约 + 内置首页插件 + 文档，为一条"形状相近、语义同类"的查询不值得。
- **语义一致**：两类查询都是"面板里没有库 Id、客户端先要一批内容垫首页"，本来就是一回事；归到同一行不产生语义冲突。
- **可路由、不撒谎**：路由目标仍由**插件自己声明**（`feed: 'random'`），不是面板随机挑一行。挑错了等于用内容撒谎（违 [ADR-0008](0008-no-fabricated-data.md)）。
- **不编数据**：没有插件声明 `feed: 'random'` → **照旧回空**，行为可预期。

## 备选

- **面板随机挑一个库返回**（方案 B）：`TotalRecordCount` 随请求抖动，客户端分页 / 缓存会错乱；且"随机挑库"等于面板替插件决定内容，与 `rowByFeed` 的既有原则（不挑一行顶上）冲突。**没选**。
- **新增 `feed` 取值（如 `feed: 'items'`）**（方案 C）：语义最清晰，但**改的是插件契约**（在另一个仓库），要动约定 + 内置首页插件 + 两份文档，代价最大。**没选**（留作后续：若将来两类查询需要彼此独立的行，再拆不迟）。
- **裸查询继续回空**：Filmly 首页永远空白，等于放弃这个客户端。**没选**。

## 后果

- 对客户端是**新可见行为**：无 `ParentId` 的裸列表查询由"回空"变为**跑 `feed: 'random'` 行**（命中插件声明时）；无声明时仍回空。属契约变更，已在 [docs/emby-compat.md](../emby-compat.md) 的契约变更记录里声明。
- **共用一个 `feed` 取值的代价**：轮播推荐位与裸列表查询**无法各自路由到不同的行** —— 想要它们各自独立，只能走方案 C（新增 `feed` 取值）。
- **让路判据要维护**：判据里 `ParentId` / `Filters` / `SearchTerm` / `AnyProviderIdEquals` / `Ids` / 计数探针六条是"别抢别支"的白名单边界，新增支路时必须同步让路，否则会被 `'random'` 抢先。
- 「裸列表查询」的读类口径仍**只验 token、不比对 `UserId`**（[ADR-0048](0048-emby-userid-not-identity.md)）。
