# #15 `GET /api/emby/Shows/NextUp`（接下来看）

> 索引：[emby-compat.md「十、真机对照记录」](../emby-compat.md)


**真机样本**（予初Emby 本轮网络不稳、登录多次超时，未取到；OkEmby 4.9.1.90 / nyamedia 4.8.0.62 取到）

| 请求 | 含义 / 客户端用途 | 予初Emby | OkEmby | nyamedia |
|---|---|---|---|---|
| `/Shows/NextUp?UserId=<自己>`（有效 token） | SenPlayer「接下来看」行 | 未取到 | **200** `{"Items":[],"TotalRecordCount":0}` | **200** 同 |
| 同上，但账号**确有已看进度** | 客户端最想要的"下一集"分支 | 未取到 | **200 空**（OkEmby 账号已看《神与律师事务所》S1E1–E5） | **200 空**（nyamedia 账号已看《清潭国际高中》S1E1–E3、《亲爱的X》S1E1–E2） |
| `?SeriesId=<有进度的那部剧>` | 只问某一部剧（SenPlayer 实测会带） | 未取到 | **200 空** | **200 空** |
| `?EnableRewatching=true` | 允许重看已完成项 | 未取到 | **200 空** | **200 空** |
| `?Limit=50` | 客户端分页取数 | 未取到 | **200 空** | **200 空** |
| 无 token / 无效 token | 全局守卫，客户端回登录页 | 未取到 | **401** 纯文本 `Access token is invalid or expired.` | **401** 同（一次 `fetch failed`，未稳定复现） |

**鉴权分支**（有效 token + 异常 UserId，探针实测）

| 场景 | 含义 / 客户端用途 | 真机 | 面板（改前） | 处理 |
|---|---|---|---|---|
| 有效 token + **全 0 guid UserId** | 客户端换号 / 重登后仍带旧 UserId | **200** 空 | **401**（`authorize` 先比对 UserId 拦下） | **差异** → 已对齐，见 15-1 |
| 有效 token + **随机 guid UserId** | 同上 | **200** 空 | **401** | **差异** → 已对齐，见 15-1 |
| 有效 token + **不带 UserId** | 参数可缺 | **200** 空 | **401** | **差异** → 已对齐，见 15-1 |

**判读**：真机 NextUp **只验 token** —— 有效 token + 错配 / 不存在的 `UserId`（乃至不带）都不回 401/403，一律 **200**。端点取的是**按观看进度算下一集**（用户私有进度），属读取类，**适用「只验 token」的自动对齐例外**。进度**按 token 解出的账号取**（`accountIdFor` token 优先），**不引入跨账号可见性**。

**响应形状**：空态两台一致 —— `{"Items":[],"TotalRecordCount":0}`，`application/json`。面板空态与之一致 ✓。

**差异处理**

- 15-1 **UserId 校验 → 适用自动对齐例外、已对齐「只验 token」**：真机**不比对 UserId**（有效 token + 错配 / 不存在 / 不带 UserId → 均 200）。取"下一集"属读取类，按既定口径直接对齐 —— `service.getNextUp` 的 `authorize(req, requestedId)` → `authorize(req)`；`accountIdFor(req, requestedId)` 保留（token 优先，UserId 仅作兜底语义），**不引入跨账号可见性**。**已落码，未复测**（待端到端复核：有效 token + 任意 UserId 应回 200）。
- 15-2 **空态形状 → 一致 ✓**：面板空态 `{"Items":[],"TotalRecordCount":0}` 与真机一致。
- 15-3 **数据口径 → 不复刻真机的空**：面板 NextUp 出**真数据**（按 `playback` 表里的进度算下一集，见 [ADR-0023](../adr/0023-playback-progress.md)，供 SenPlayer / CapyPlayer 的"接下来看"）。真机这两台**明明有已看进度却恒回空**（带 `SeriesId` / `EnableRewatching` / `Limit=50` 均空，同账号 `Items/Resume` 也空），其已看条目 `UserData.LastPlayedDate` 还是 `undefined` —— 判读为**该服务器的 NextUp 功能不可用**（**服务器功能缺口，不是协议形状差异**），**面板有意出真数据、不复刻这个空**。**数据不同源。**
- 15-4 **非空样本 → 待补测**：三台都取不到非空 `Items`，`Items[]` 的 `BaseItemDto` 字段集未取到样本；待有 NextUp 可用的真机补测逐字段含义。

**面板特有行为（有意偏离，先不改）**：带 `SeriesId` 且**该剧在面板库里没有进度**时，面板回**第一集**（CapyPlayer 需要它来"从头看"）；真机该场景回空。判定为**面板特有、有意为之**，**先不改**（登记备查）。

**不能模拟**：真机清单来自它自己的观看记录 / 片库；面板取的是面板库的观看进度，**数据不同源**。另注：OkEmby / nyamedia 的条目 `Id` / `SeriesId` 是**数字**（`308210` / `232503`），非 Emby 标准 Guid —— 疑为聚合类服务器，其 NextUp 行为对"真 Emby 语义"的参考价值有限。

**状态：15-1 已落码（未复测）；15-2 空态形状一致；15-3 判定不复刻真机空、有意出真数据；15-4 登记为待补测。** 样本为空态；予初Emby 未取到样本、非空 `Items[]` 字段样本均**待补测**。
