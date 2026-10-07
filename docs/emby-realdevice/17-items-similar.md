# #17 `GET /api/emby/Items/{ItemId}/Similar`（相似推荐）

> 索引：[emby-compat.md「十、真机对照记录」](../emby-compat.md)


**真机样本**（予初Emby 4.9.5.0 / OkEmby 4.9.1.90 / nyamedia 4.8.0.62，三台均登录 200）

样本条目：予初Emby 电影 `864879`、OkEmby 电影 `47156`、nyamedia 电影 `232431`。

| 请求 | 含义 / 客户端用途 | 予初Emby | OkEmby | nyamedia |
|---|---|---|---|---|
| 有效 token + 自己 `UserId` | 详情页「相似 / 更多类似」 | **200**（2297 条） | **200** | **200**（357 条） |
| 有效 token + 自己 `UserId`（**小写 `userId`**） | 客户端参数大小写混用 | **200** | 未取到（网络抖动） | **200** |
| 有效 token + **全 0 guid UserId** | 客户端换号 / 重登后仍带旧 UserId | **200** | 未取到（超时） | **500** `Object reference not set to an instance of an object.` |
| 有效 token + **随机 guid UserId** | 同上 | **200** | **200** | **500** 同 |
| 有效 token + **不带 UserId** | 参数可缺 | **200** | **200** | **500** 同 |
| 无 token / 无效 token | 全局守卫，客户端回登录页 | **401** 纯文本 `Access token is invalid or expired.`（`text/plain`） | **401** 同 | **401** 同（`text/html`） |

**鉴权分支**（探针实测）

| 场景 | 含义 / 客户端用途 | 真机 | 面板（改前） | 处理 |
|---|---|---|---|---|
| 有效 token + **错配 / 不存在 / 不带 UserId** | 客户端换号 / 重登后仍带旧 UserId | **200**（予初Emby / OkEmby） | **401**（`authorize` 先比对 UserId 拦下） | **差异** → 已对齐，见 17-1 |
| **无 token / 无效 token** | 全局守卫 | **401** 纯文本 | **401** 纯文本 | 一致 ✓ |

**判读**：真机 Similar **只验 token** —— 无 token / 无效 token → **401 纯文本**；有效 token + 错配 / 不存在 / 不带 `UserId` → 予初Emby / OkEmby 照旧 **200**，不比对 UserId。端点取的是**上游的关联内容**（内容数据、与具体用户无关），读取类，**适用「只验 token」的自动对齐例外**，**不引入跨账号可见性**。nyamedia 对「不可解析 / 缺失的 `UserId`」回 **500 空指针误码**（`Object reference not set to an instance of an object.`）—— 是**真机自身的 bug**（同 #13 的 nyamedia 空指针），**不属鉴权拒绝**，**不复刻**。

**响应形状**：真机顶层**两键** `{Items:[...], TotalRecordCount:N}`，`application/json`；`Items.length` 与 `TotalRecordCount` 相等（予初Emby 2297 / nyamedia 357）。条目是**精简版 `BaseItemDto`**（真机首条 10 键：`Name` / `ServerId` / `Id` / `RunTimeTicks` / `IsFolder` / `Type` / `UserData` / `ImageTags` / `BackdropImageTags` / `MediaType`，带条目级 `UserData`）。面板 `leanItemDto` 形状与之一致 ✓。

**差异处理**

- 17-1 **UserId 校验 → 适用自动对齐例外、已对齐「只验 token」**：真机**不比对 UserId**（有效 token + 错配 / 不存在 / 不带 UserId → 予初Emby / OkEmby 均 200）。端点是**按条目坐标反查上游的关联内容**（内容数据、与用户无关），属读取类，按既定口径直接对齐 —— 路由 `service.authorize(req, userIdOf(query))` → `service.authorize(req)`；`service.getSimilar` 去掉 `assertUser(requestedId)`（连带去掉其第二参 `requestedId`）。进度仍由 `applyUserData(out, userIdOf(query), req)` 按 **token 解出的账号**补（`accountIdFor` token 优先）—— 传别人的 `UserId` 也只看到自己 token 账号的进度，**不引入跨账号可见性**。**已落码，未复测**（待端到端复核：有效 token + 任意 / 不存在的 UserId 应回 200）。
- 17-2 **响应形状 → 一致 ✓**：真机 `QueryResult<BaseItemDto>`（`{Items, TotalRecordCount}`），面板形状一致；条目为精简版 `BaseItemDto`，与面板 `leanItemDto` 一致。此前「形状待客户端实测复核」的标注**据此结清**。
- 17-3 **nyamedia 的 500 → 不复刻**：对不可解析 / 缺失的 `UserId`，nyamedia 回 500 空指针误码（真机 bug，同 #13）。按本层「不编、防枚举」口径**维持 200**（有效 token 即放行）。
- 17-4 **数据不同源 → 不复刻**：真机回它**自己片库**算出的关联内容；面板回的是**上游（元数据插件）在同一次详情 lookup 里给的 `recommendations`**。**数据不同源**，**如实出面板自己的推荐**、不追真机清单。

**不能模拟**：真机的相似来自它自己的片库 / 元数据；面板取的是上游插件的 `recommendations`（与详情同一次请求就拿到，不额外打上游）。

**状态：17-1 已落码（未复测）；17-2 形状一致 ✓；17-3 / 17-4 判定不复刻。** OkEmby 的「小写 `userId` / 全 0 guid」两支因网络抖动未取到、**待补测**。
