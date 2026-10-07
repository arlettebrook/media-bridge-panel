# #7 `GET /api/emby/Shows/{Id}/Seasons`（剧的季列表）

> 索引：[emby-compat.md「十、真机对照记录」](../emby-compat.md)


**真机样本**（OkEmby 4.9.1.90；予初Emby 仍不可达）

**错误分支**

| 场景 | 含义 / 客户端用途 | 真机 | 面板 | 处理 |
|---|---|---|---|---|
| 无 token（带/不带 `UserId`） | 全局守卫，客户端回登录页 | **401 纯文本** `Access token is invalid or expired.` | 401 纯文本（`authorize`，#3 已改） | 一致 |
| **有效 token + 合法但不存在的 UserId**（32 位 hex Guid） | 真机**不校验 UserId 与 token 的匹配** | **200 照常回季列表**（不校验） | 原 `assertUser` → 404 JSON `{error:'用户不存在'}`；**7-2 已删** | **已改**（对齐真机：只验 token，UserId 降为进度兜底，见下 7-2） |
| 有效 token + 非法格式 UserId（如 `WRONGID`） | 真机把 UserId 当 Guid 解析 | **500 纯文本** `Unrecognized Guid format.` | 404 JSON | 不模拟（同 5-2 附注：放宽后此分支在面板上自然成 200） |
| `Id` 不存在（合法 Guid） | 客户端拿了错的剧 Id | **404 纯文本** `找不到所请求的项目。可能已从服务器中删除了。` | `parseItemId` 失败 → **404 JSON** `{error:'没有这个剧'}` | 语义一致；形状差异（真机纯文本 vs 面板 JSON，属 L1158 遗留） |
| `Id` 非 Guid 形状（如 `NOPE`） | — | **500 纯文本** | 404 JSON | 不模拟（面板 Id 非 Guid 形状） |
| `Id` 是电影 / 季（非剧） | 客户端拿了错的 Id | **404 纯文本** | 404 JSON `{error:'没有这个剧'}` | 语义一致；形状差异 |

**成功分支**

| 查询形状 | 含义 / 客户端用途 | 真机 | 面板 | 处理 |
|---|---|---|---|---|
| 顶层形状 | 季列表容器 | `{Items, TotalRecordCount}` | 同 | 一致 |
| **特别篇（`IndexNumber: 0`）** | 客户端显示特别篇 | **返回**（66972「斯巴达克斯」共 5 条含 S0「特别篇」；37724「斗破苍穹」共 6 条含 S0） | 原 `seasons.filter(s => s.seasonNumber > 0)` → 过滤掉 S0；**7-1 已改为返回** | **已改**（对齐真机，见下 7-1） |
| 季条目字段集（无 `Fields`） | 客户端渲染季列表 | **18 键**：`Name/ServerId/Id/IndexNumber/IsFolder/Type/ParentLogoItemId/ParentBackdropItemId/ParentBackdropImageTags/UserData/SeriesName/SeriesId/SeriesPrimaryImageTag/ImageTags/BackdropImageTags/ParentLogoImageTag/ParentThumbItemId/ParentThumbImageTag`（**无** `Year/PremiereDate/Overview/CommunityRating/ProviderIds/ChildCount/Genres/ParentId`） | `baseItem` 恒含 ~25 键（多出 `Overview/Genres/ProviderIds/ProductionYear/ParentId/…`） | 保留（超集无害，理由同 #5；真机缺的面板多给，客户端不报错） |

**季条目逐字段**（真机 18 键 vs 面板）

| 字段 | 真机 | 面板 | 含义 / 客户端用途 | 处理 |
|---|---|---|---|---|
| `Name`/`ServerId`/`Id`/`Type`/`IsFolder`/`IndexNumber` | 有（`Type:Season`、`IsFolder:true`、`IndexNumber` = 季号） | 有 | 季名 / 服务器 / 季 Id / 类型 / 文件夹标记 / 季号 | 一致 |
| `SeriesId`/`SeriesName` | 有（= 所属剧 Id / 剧名） | 有 | 反向指回剧（客户端跳转/标题） | 一致 |
| **`UserData`** | **5 键**：`{UnplayedItemCount, PlaybackPositionTicks, PlayCount, IsFavorite, Played}` | 原 **4 键**（无 `UnplayedItemCount`）；**7-3 已补** | 播放进度 / 收藏 / 已看 / 本季未看集数 | **已改**（补 `UnplayedItemCount`，见下 7-3） |
| **`SeriesPrimaryImageTag`** | 有（真实 tag） | **无** | 剧主图 tag（客户端显示剧缩略图） | **不改**（见下 7-4：回退原则） |
| **`ParentThumbItemId`/`ParentThumbImageTag`** | 有（= 剧 Id + tag） | **无** | 父级缩略图（客户端显示季缩略图兜底） | **不改**（见下 7-4） |
| **`ParentLogoItemId`/`ParentLogoImageTag`** | 有 | **无** | 父级 logo | **不改**（见下 7-4） |
| **`ParentBackdropItemId`/`ParentBackdropImageTags`** | 有（= 剧 Id + 3 个 tag 数组） | **无** | 父级背景图 | **不改**（见下 7-4） |
| **`ImageTags`** | `{Primary, Banner}` | 只 `{Primary}`（有图时） | 季图 tag | **不改**（见下 7-5：插件无 banner 概念） |
| `BackdropImageTags` | `[]` | `[]` | 季背景图 | 一致 |

**不能模拟**：真机 `Id` 是数字/`Guid` 形状（面板 Id 是派生字符串）；系列级父图字段的**真实 tag 值**（面板需先有真实图源，见 7-4）。

**观察（非确定性差异）**：37724「斗破苍穹」的响应里，第 4、5 季的 `SeriesId` 是 **41144**（`SeriesName` 仍为「斗破苍穹」），前 3 季则是 37724。真机疑似按剧名/集合把不同"剧条目"的季混出（上游库结构所致），面板按 Id 严格切分、不会混。不模拟。

**差异处理（能补的就补 + 回退原则）**

- 7-1 **特别篇（`IndexNumber: 0`）→ 已改为返回**（对齐真机）：`getSeasons` 去掉 `seasonNumber > 0` 过滤；对账口径改为**只看常规季（`IndexNumber > 0`）**与 `show.seasonCount` 比较。特别篇季 Id `…_tv_s0` 由 `itemId`/`parseItemId` 互逆可回查（正则 `_s(\d+)` 允许 s0）。
- 7-2 **UserId 放宽 → 已改**（对齐真机，同 5-2/6-2）：路由 `authorize(req, userIdOf(query))` → `authorize(req)`；`getSeasons(showId)` 删 `assertUser`。用户私有进度改由 `applyUserData` 按 token 解出的账号补，`UserId` 只当兜底。
- 7-3 **`UserData.UnplayedItemCount` → 已补**：`db.countPlayedInSeason(accountId, seriesId, season)` 按「剧 + 季」数 `played = 1` 的集数，季条目 `UnplayedItemCount = ChildCount − 已看集数`（负数夹到 0）。只算 `played = 1` —— 看了没看完仍算未看（对齐真机那个数的语义）。
- 7-4 **系列级父图字段 → 不改**。依据**回退原则**（见「四」）：**emby 层不认识、也不为任何元数据插件特调**。
  **插件侧实查**（TMDB 元数据插件源码 `roles/metadata/lib/meta.js`）：基础取数只给剧 `posterPath`（1 张）与 `backdropPath`（1 张）；`logoPath` 与至多 8 张 `backdropPaths` **只在 rich 详情页取数**才有；**没有 series thumb、没有 banner**（TMDB 无 banner 概念）。
  即「剧海报」有、「剧 logo」有条件有、「剧缩略图」根本没有，且**各插件能给的还不一样** —— 无法在不特调插件的前提下稳定补齐，故**不加**（可选字段缺失只降级，不动主结构）。
- 7-5 **`ImageTags.Banner` → 不改**：真机季有 `Banner`，但 TMDB 插件**没有 banner 图**。硬填一个 tag 只会让客户端去要一张取不到的图（404），不如不给。

**状态：7-1 / 7-2 / 7-3 已落码（未复测）**；7-4 / 7-5 判定不改（回退原则）。`node --check` 通过；面板端到端待批量复测。
