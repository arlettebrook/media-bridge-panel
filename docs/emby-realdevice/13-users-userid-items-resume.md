# #13 `GET /api/emby/Users/{UserId}/Items/Resume`（继续观看）

> 索引：[emby-compat.md「十、真机对照记录」](../emby-compat.md)


**真机样本**（四台均登录 200；OkEmby / nyamedia 账号无观看进度；予初Emby / 动漫Emby 账号 `dlushu` **确有播放记录**，见下补测）

| 请求 | 含义 / 客户端用途 | 予初Emby | OkEmby | nyamedia |
|---|---|---|---|---|
| `Users/{UserId}/Items/Resume`（有效 token） | 首页「继续观看」行 | **200** `{"Items":[],"TotalRecordCount":0}` | **200** 同 | **200** 同 |
| 同上 `?Limit=1` | 客户端分页取数 | **200** 空 | **200** 空 | **200** 空 |
| 无 token / 无效 token | 全局守卫，客户端回登录页 | **401** `Access token is invalid or expired.` | **401** 同 | **401** 同（`Content-Type: text/html`） |

**予初Emby 补测**（账号 `dlushu` 有播放记录 —— 修正此前「三台账号均无进度」的旧结论；其条目 `Id` / `SeriesId` 是**数字**，疑为聚合类服务器）

| 请求 | 含义 / 客户端用途 | 予初Emby |
|---|---|---|
| `Items/Resume`（裸，有效 token） | 标准「继续观看」（位置>0、未看完） | **200** `{"Items":[],"TotalRecordCount":0}`（复测 2 次均空） |
| 同上 `?MediaTypes=Video&Limit=50` | 带过滤的分页取数 | **200，2 条** —— 位置 **0**、未看的「下一集」（斗破苍穹 S5 E211 `974543` / SeriesId `972383`；三体 S1 E2 `352980` / SeriesId `294252`） |
| `Items?Recursive=true&Filters=IsResumable` | 标准「继续观看」口径（位置>0 未看完） | **200，3 条** —— 全是**在播电影**：《'15'》`864879`（5.77%）、蜘蛛侠《崭新之日》`973055` / `981561`（31.31%） |

**动漫Emby 补测**（**真 Emby 内核 4.10.1.0** + 聚合插件库 —— 条目 `Path` 是远端 URL、`Id` 为数字；账号 `dlushu` 有进度：`Filters=IsResumable` 3 条在播剧集、`IsPlayed` 112 条）

| 请求 | 含义 / 客户端用途 | 动漫Emby |
|---|---|---|
| `Items/Resume`（裸 / 带 `MediaTypes=Video` / `Recursive=true` / `IncludeItemTypes=Episode\|Movie` / `Filters=IsResumable` / `/emby` 前缀） | 标准「继续观看」（位置>0、未看完） | **200 恒空** `{"Items":[],"TotalRecordCount":0}` |
| `Items?Recursive=true&Filters=IsResumable` | 标准「继续观看」口径 | **200，3 条** —— 《缘之空》S1 E4 `90625`（86.16%）、E7 `90621`（3.88%）、E8 `90618`（19.65%），均 `Played=false` |
| 无 token / 有效 token + 不存在 UserId | 全局守卫 / UserId 不校验 | **401** / **200 空**（同其余真机） |

**动漫Emby 语义判读**：**明明有 3 条在播剧集（`Filters=IsResumable` 取到），`Items/Resume` 仍恒空** —— 其 `Items/Resume` 由聚合插件提供、**未实现标准语义**，**不能作为 Resume 语义佐证**（同予初）。另注该服务器**查询参数只实现了一部分**：`IsResumable=true` 被忽略（回**全库 54021 条**）、`LocationTypes=Virtual\|FileSystem` 被忽略（都回 3 条），只有 `Filters=IsResumable` 生效。

**鉴权分支**（有效 token + 异常 UserId，探针实测）

| 场景 | 含义 / 客户端用途 | 真机 | 面板（改前） | 处理 |
|---|---|---|---|---|
| 有效 token + **全 0 guid UserId** | 客户端换号 / 重登后仍带旧 UserId | 予初Emby / OkEmby **200** 空；nyamedia **500** `Object reference not set to an instance of an object.` | **401**（`authorize` 先比对 UserId 拦下） | **差异** → 已对齐，见 13-1 |
| 有效 token + **非 Guid 格式的 UserId** | 真机把 UserId 当普通参数 | **500** `Unrecognized Guid format.`（nyamedia `Guid should contain 32 digits …`） | **401** | **差异** → 已对齐，见 13-1 |

**判读**：真机 Resume **只验 token** —— 不存在 / 非 Guid 的 `UserId` 都不回 401/403，只可能崩成 500 误码（`Object reference not set…` / `Unrecognized Guid format.` 均为真机自身解析错误）。端点取的是**观看记录（用户私有进度）**，属读取类，**适用「只验 token」的自动对齐例外**。观看记录**按 token 解出的账号取**（`accountIdFor` token 优先 —— 传别人的 `UserId` 也只看到自己 token 账号的记录），**不引入跨账号可见性**。

**予初语义判读**：予初 `Items/Resume` **不遵循标准 Emby 语义** —— 裸调用（标准「继续观看」口径）恒回空；带 `MediaTypes=Video` 才出，且出的是位置 0、未看的**「下一集」**；真正的「继续观看」（`Filters=IsResumable`，位置>0 未看完）全是**电影**。即予初把「下一集」塞进了 Resume，与标准含义不符，**不能作为 Resume 语义的真机佐证**（与 #15 判读一致：疑为聚合类服务器）。

**予初改进度对照**（探针实测）：对未看集 `POST /Users/{UserId}/Items/{ItemId}/UserData`（body `{"PlaybackPositionTicks":N}`）→ **204**（写成功，`IsResumable` 随即多出该集）；但 **`Items/Resume`（裸）仍回空** —— 说明予初 `Items/Resume` **根本不随观看进度变化**，进一步佐证其**非标准**。**测后已还原进度。**

**响应形状**：空态四台一致 —— `{"Items":[],"TotalRecordCount":0}`，`application/json; charset=utf-8`，33 字节。面板空态与之一致 ✓。

**差异处理**

- 13-1 **UserId 校验 → 适用自动对齐例外、已对齐「只验 token」**：真机**不比对 UserId**（有效 token + 不存在 / 非 Guid 的 UserId → 无 401/403）。取观看记录属读取类，按既定口径直接对齐 —— `service.getResume(requestedId, req, query)` 的 `authorize(req, requestedId)` → `authorize(req)`；`accountIdFor(req, requestedId)` 保留（token 优先，UserId 仅作兜底语义），**不引入跨账号可见性**。**已落码，未复测**（待端到端复核：有效 token + 任意 UserId 应回 200 空）。
- 13-2 **异常 UserId 的 500 误码 → 不复刻**：真机对全 0 guid UserId 回 `Object reference not set…`、对非 Guid UserId 回 `Unrecognized Guid format.`（nyamedia 措辞略异），属真机自身解析 bug；面板按「只验 token、UserId 只当参数」处理，**判定不复刻**（同 #10-1 取向）。
- 13-3 **字段级样本 → 部分取到（予初 / 动漫Emby）**：OkEmby / nyamedia 账号无进度，未取到；予初账号 `dlushu` 已取到非空 `Items`，但**全是电影或位置 0 条目**（`Filters=IsResumable` 的 3 条在播电影 + `MediaTypes=Video` 的 2 条位置 0「下一集」）；动漫Emby 账号 `dlushu` 补到**「在播剧集」样本**（《缘之空》S1 E4 86.16% / E7 3.88% / E8 19.65%），但**只在 `Filters=IsResumable` 下取到，`Items/Resume` 恒空** —— 两台端点语义都非标准（见上判读），逐字段含义参考价值有限。
- 13-4 **已改（未复测）：条目不再回空串 `PremiereDate` / `Overview`**。Resume 的条目 DTO 与列表共用 `service.baseItem()`：此前拿不到首播日期就回 `"PremiereDate": ""`（本项目实测两包：面板 Resume 响应里有 1 处空串；真机包零空串、零 `PremiereDate`）。客户端对该字段做 `DateTime.parse(value)` 会崩。现改为**有值才挂键**，见 [ADR-0061](../adr/0061-omit-missing-scalar-fields.md)；逐条登记见 [#6 的 6-3](06-users-userid-items-latest.md)。**未复测**。

**不能模拟**：真机 `Items[].UserData` 里的进度（`PlaybackPositionTicks` / `PlayedPercentage` 等）来自真机自身播放记录；面板取的是面板库的观看进度，**数据不同源**。

**状态：13-1 已落码（未复测）；13-2 判定不复刻；13-3 予初 / 动漫Emby 部分取到、其余待补测。** 两台非空样本的端点语义都不标准（予初疑聚合类；动漫Emby 是**真 Emby 内核 + 聚合插件库**，`Items/Resume` 恒空、只有 `Filters=IsResumable` 生效），不能作为 Resume 语义佐证；**标准 Emby（本地文件库）样本仍待补测**。
