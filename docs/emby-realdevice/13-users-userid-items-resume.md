# #13 `GET /api/emby/Users/{UserId}/Items/Resume`（继续观看）

> 索引：[emby-compat.md「十、真机对照记录」](../emby-compat.md)


**真机样本**（三台均登录 200；三台账号均无观看进度）

| 请求 | 含义 / 客户端用途 | 予初Emby | OkEmby | nyamedia |
|---|---|---|---|---|
| `Users/{UserId}/Items/Resume`（有效 token） | 首页「继续观看」行 | **200** `{"Items":[],"TotalRecordCount":0}` | **200** 同 | **200** 同 |
| 同上 `?Limit=1` | 客户端分页取数 | **200** 空 | **200** 空 | **200** 空 |
| 无 token / 无效 token | 全局守卫，客户端回登录页 | **401** `Access token is invalid or expired.` | **401** 同 | **401** 同（`Content-Type: text/html`） |

**鉴权分支**（有效 token + 异常 UserId，探针实测）

| 场景 | 含义 / 客户端用途 | 真机 | 面板（改前） | 处理 |
|---|---|---|---|---|
| 有效 token + **全 0 guid UserId** | 客户端换号 / 重登后仍带旧 UserId | 予初Emby / OkEmby **200** 空；nyamedia **500** `Object reference not set to an instance of an object.` | **401**（`authorize` 先比对 UserId 拦下） | **差异** → 已对齐，见 13-1 |
| 有效 token + **非 Guid 格式的 UserId** | 真机把 UserId 当普通参数 | **500** `Unrecognized Guid format.`（nyamedia `Guid should contain 32 digits …`） | **401** | **差异** → 已对齐，见 13-1 |

**判读**：真机 Resume **只验 token** —— 不存在 / 非 Guid 的 `UserId` 都不回 401/403，只可能崩成 500 误码（`Object reference not set…` / `Unrecognized Guid format.` 均为真机自身解析错误）。端点取的是**观看记录（用户私有进度）**，属读取类，**适用「只验 token」的自动对齐例外**。观看记录**按 token 解出的账号取**（`accountIdFor` token 优先 —— 传别人的 `UserId` 也只看到自己 token 账号的记录），**不引入跨账号可见性**。

**响应形状**：空态三台一致 —— `{"Items":[],"TotalRecordCount":0}`，`application/json; charset=utf-8`，33 字节。面板空态与之一致 ✓。

**差异处理**

- 13-1 **UserId 校验 → 适用自动对齐例外、已对齐「只验 token」**：真机**不比对 UserId**（有效 token + 不存在 / 非 Guid 的 UserId → 无 401/403）。取观看记录属读取类，按既定口径直接对齐 —— `service.getResume(requestedId, req, query)` 的 `authorize(req, requestedId)` → `authorize(req)`；`accountIdFor(req, requestedId)` 保留（token 优先，UserId 仅作兜底语义），**不引入跨账号可见性**。**已落码，未复测**（待端到端复核：有效 token + 任意 UserId 应回 200 空）。
- 13-2 **异常 UserId 的 500 误码 → 不复刻**：真机对全 0 guid UserId 回 `Object reference not set…`、对非 Guid UserId 回 `Unrecognized Guid format.`（nyamedia 措辞略异），属真机自身解析 bug；面板按「只验 token、UserId 只当参数」处理，**判定不复刻**（同 #10-1 取向）。
- 13-3 **字段级样本 → 待补测**：三台登录账号均无观看进度，`Items[].UserData` 非空样本未取到；待有进度账号补测逐字段含义。

**不能模拟**：真机 `Items[].UserData` 里的进度（`PlaybackPositionTicks` / `PlayedPercentage` 等）来自真机自身播放记录；面板取的是面板库的观看进度，**数据不同源**。

**状态：13-1 已落码（未复测）；13-2 判定不复刻；13-3 登记为待补测。** 样本为**空态**（三台账号均无进度）；非空 `Items` 字段样本待补测。
