# #16 `GET /api/emby/Items/Counts`（条目计数）

> 索引：[emby-compat.md「十、真机对照记录」](../emby-compat.md)


**真机样本**（予初Emby 本轮登录超时、未取到；OkEmby 4.9.1.90 / nyamedia 4.8.0.62 取到）

| 请求 | 含义 / 客户端用途 | 予初Emby | OkEmby | nyamedia |
|---|---|---|---|---|
| 有效 token + 自己 `UserId` | 首页「媒体库数量」汇总 | 未取到 | **200** `{"MovieCount":7550,"SeriesCount":2592,"EpisodeCount":82747,…其余 0}` | **200** `{"MovieCount":722,"SeriesCount":1710,"EpisodeCount":52806,…其余 0}` |
| 有效 token + **全 0 guid UserId** | 客户端换号 / 重登后仍带旧 UserId | 未取到 | **200** 同上（全局计数） | **200** `722/1710/52806`（回到全局值） |
| 有效 token + **随机 guid UserId** | 同上 | 未取到 | **200** 同上 | **200** `722/1710/52806` |
| 无 token | 全局守卫，客户端回登录页 | 未取到 | **401** 纯文本 `Access token is invalid or expired.`（`text/plain`） | **401** 同（`text/html`） |
| 无效 token | 同上 | 未取到 | **401** 同 | **401** 同 |

**鉴权分支**（探针实测）

| 场景 | 含义 / 客户端用途 | 真机 | 面板（改前） | 处理 |
|---|---|---|---|---|
| 有效 token + **全 0 / 随机 guid UserId** | 客户端换号 / 重登后仍带旧 UserId | **200** | **200**（原样不校验账号） | 一致 ✓（改后仍 200） |
| **无 token / 无效 token** | 全局守卫 | **401** 纯文本 | **200**（原样不校验 token） | **差异** → 已对齐，见 16-1 |

**判读**：真机 Counts **只验 token** —— 无 token / 无效 token 一律 **401 纯文本**；有效 token + 错配 / 不存在的 `UserId` 照旧 **200**，不比对 UserId。计数属内容数据、与具体用户无关，读取类，**适用「只验 token」的自动对齐例外**，**不引入跨账号可见性**。

**响应形状**：真机 `ItemCounts` 字段集与面板**一致 ✓**（`MovieCount` / `SeriesCount` / `EpisodeCount` / `GameCount` / `ArtistCount` / `ProgramCount` / `GameSystemCount` / `TrailerCount` / `SongCount` / `AlbumCount` / `MusicVideoCount` / `BoxSetCount` / `BookCount` / `ItemCount` 共 14 字段，一个不少），`application/json`。

**差异处理**

- 16-1 **鉴权 → 已对齐「只验 token」**：真机**校验 token、不比对 UserId**。面板改前**完全不校验账号**（连 token 都不看），与真机不符。按既定口径直接对齐 —— `routes.js` 的 `Items/Counts` 路由加 `service.authorize(req)` 门禁（无 token / 无效 token → 401 纯文本 `Access token is invalid or expired.`；有效 token + 任意 UserId → 200）。**已落码，未复测**（待端到端复核：无 token 应回 401、有效 token + 任意 UserId 应回 200）。
- 16-2 **真实计数 → 对齐电影 / 剧集 / 集数三类**：真机回**自己片库的真实计数**（OkEmby `MovieCount:7550 / SeriesCount:2592 / EpisodeCount:82747`；nyamedia `722 / 1710 / 52806`）。面板**没有片库索引**（见 [ADR-0008](../adr/0008-no-fabricated-data.md) 不编数据），原本**如实回全 0**。「填库总数」变更把 **`MovieCount` / `SeriesCount` 改为取首页插件申报的库总数**（`rows.total`，见 [ADR-0052](../adr/0052-items-counts-library-total.md)）；「填集数」变更把 **`EpisodeCount` 改为取剧库行申报的集数**（`rows.episodes`，见 [ADR-0053](../adr/0053-home-row-declared-episodes.md)）；**其余字段仍回 0** —— 真机那些数无对应来源，**不复刻**。**数据不同源**：面板回的是**上游全库规模**、真机回的是**它自己片库的计数**，故数值不会相等（属有意）。**已落码，未复测**（待端到端复核：插件申报了该类型库规模 / 剧库集数的实例，字段应等于申报值；未申报仍是 0）。
- 16-3 **字段集 / 形状 → 一致 ✓**：14 字段与真机一项不差，空值亦以 `0` 呈现，客户端解析无差异。
- 附注 **nyamedia 用户级计数**：带**自己的** `UserId` 时值略小（`714 / 1635 / 51236`），带全 0 / 随机 guid 回到全局值（`722 / 1710 / 52806`）—— 疑真机按"用户可见范围"计数。面板**不分用户范围**（恒回实例级总数）、未申报的字段仍是 0，**登记备查**。

**面板特有行为**：面板原为如实回全 0（无片库索引）；真机回真实计数。数据不同源、有意为之 —— 现已把 电影 / 剧集 / 集数 三类分别改为取**插件申报的库总数（`total`）与剧库集数（`episodes`）**（16-2），其余字段仍 0。

**不能模拟**：真机计数来自它自己的片库索引；面板没有片库索引，只能取**插件申报**的库规模（电影 / 剧集 / 集数 三类），其余类别**如实回 0**。

**状态：16-1 已落码（未复测）；16-2 已落码（未复测）—— 电影 / 剧集取插件申报的库总数、集数取剧库行申报的 `episodes`、其余 11 类仍 0；16-3 字段集一致 ✓。** 予初Emby 未取到样本（登录超时）**待补测**。
