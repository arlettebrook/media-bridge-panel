# #19 `GET /api/emby/System/Ping`（连通性探针）

> 索引：[emby-compat.md「十、真机对照记录」](../emby-compat.md)


新客户端 **Lenna/1.0.16** 打的（日志 `✘ emby 未实现#10 GET /api/emby/System/Ping [Lenna/1.0.16]`，落到 501）。

**真机样本**（OkEmby / nyamedia / itsmygo 实测；予初Emby 多次重试**不可达**，待补测）

| 请求 | 含义 / 客户端用途 | OkEmby | nyamedia | itsmygo |
|---|---|---|---|---|
| 有效 token | 登录后周期探活 | **200** `text/plain` `Emby Server`（11B） | **200** `application/json` `Emby Server`（11B） | **200** 空体（`len=0`、无 `content-type`） |
| **无 token** | 登录前探「服务器在不在」 | **200** `Emby Server` | **200** `Emby Server` | **401** `application/json` `{"error":"unauthorized"}`（25B） |
| **无效 token** | 过期 / 换号后旧 token | **200** `Emby Server` | **200** `Emby Server` | **401** 同 |

**判读**：OkEmby / nyamedia **免鉴权**、回**常量字符串** `Emby Server`（11 字节，**不是 JSON**）；`content-type` 却各写各的（OkEmby `text/plain`、nyamedia `application/json`，疑似被中转/桥改写）。itsmygo（仿 Emby 服务）**要 token**：无 / 无效 → **401 `{"error":"unauthorized"}`**（JSON，非 Emby 惯例纯文本）、有效 token → **200 但回空体**（`len=0`）。

**差异处理**

- 19-1 **鉴权口径 → 豁免 AccessToken，对齐 OkEmby / nyamedia**：这是**握手类连通性探针**（客户端登录前就拿它测「这台服务器活着吗」），要求 token 会让探针本身失败。三台里两台免鉴权，**对齐多数**；itsmygo 的「要 token」**登记不复刻**（同 18-1 / 18-5 口径）。端点回的是**常量**、与用户无关，**不引入跨账号可见性**。
- 19-2 **响应体 → 常量 `Emby Server` + `text/plain`**：与真机正文一致（11 字节）；`content-type` 取**真 Emby 惯例** `text/plain`（StringOutputFormatter），**不复刻 nyamedia 的 `application/json`**（正文并非 JSON，那是它自己的怪癖）。
- 19-3 **itsmygo 的 401 / 空 200 → 登记备查**：401 的 JSON 形状非 Emby 纯文本惯例，且有效 token 回空体也说不通；面板**照常量回 `Emby Server`**，不复刻。

**面板特有行为**：无 —— 常量回应，与真机正文一致。

**不能模拟**：无（常量字符串，无外部依赖）。

**状态：已落码（未复测）。** 予初Emby 因网络不可达**待补测**（补测重点：是否也免鉴权、正文是否同为 `Emby Server`）。
