# #22 旧版播放上报族（`POST|DELETE /api/emby/Users/{UserId}/PlayingItems/{ItemId}[/Progress]`）

> 索引：[emby-compat.md「十、真机对照记录」](../emby-compat.md)


**真机样本**：此族按 Emby **早期 API**（`PlayingItems`）命名，与新版 `Sessions/Playing*` 同一套语义（开始 / 进度 / 停止）。**本轮尚未在真机上逐条对照**（下表的「真机」列待补测）—— 改动的依据是**客户端抓包**，不是真机对照。

**客户端实测**（HamHub Android/1.0.0，本机 HAR 抓包，host 为局域网实例端口）

| 请求 | 客户端用途 | 面板（改前） |
|---|---|---|
| `POST /api/emby/Users/{uid}/PlayingItems/{itemId}?PlaySessionId=…` | 开始播放 | **501** `EMBY_ENDPOINT_NOT_IMPLEMENTED` |
| `POST /api/emby/Users/{uid}/PlayingItems/{itemId}/Progress?PositionTicks=…&IsPaused=false` | 心跳（实测数秒一次） | **501** 同 |
| `POST /api/emby/Users/{uid}/PlayingItems/{itemId}/Progress?PositionTicks=…&IsPaused=true` | 暂停时报 | **501** 同 |
| `DELETE /api/emby/Users/{uid}/PlayingItems/{itemId}?PositionTicks=…` | 结束 / 退出 | **501** 同 |

这一族请求都带齐 `X-Emby-Token` 头 + `Authorization` 头，**`postData` 为空**（参数全在 **query**、`ItemId` 在**路径**）—— 这是与新版 `Sessions/Playing*`（JSON body）最本质的区别。

**判读**：`PlayingItems` 是 Emby **旧版**上报族，与新版 `Sessions/Playing*` **同义**。面板此前只实现新版，HamHub 用的这一族全落 501 ⇒ **它的观看进度一条都没落库**，「继续观看」里不会出现它看过的集。

**差异处理**

- 22-1 **认领旧版族、映射到同一套落库（已落码，未复测）**：新增三条路由 —— `POST …/PlayingItems/{ItemId}`（开始）、`POST …/PlayingItems/{ItemId}/Progress`（心跳）、`DELETE …/PlayingItems/{ItemId}`（停止）；把 path / query 拼成 `recordPlayback` 认的形状，落库口径与新版族**完全一致**（含 **204 空体**、`ItemId` 认不出 → 204 **不写库**）。**真机对这三条的形状 / 状态码待补测**。
  - ⚠️ **已知限制**：旧版族**不带 `RunTimeTicks`** ⇒ 面板不知道条目时长时只能按位置记，判「看完」失去依据（`recordPlayback` 会照实记「时长未知」，`played` 不因此抬高）—— 与新版族「部分心跳带 `RunTimeTicks`」的差别。
- 22-2 **query 带 token 兜底（已落码，未复测）**：见 [#12 的 12-5](12-direct-stream.md) —— HamHub 在探测 / 拉流时把 token 也放进 **query `X-Emby-Token=`**，本层 `tokenFrom` 现认这一带法。

**不能模拟**：真机此族的逐字段响应形状（是否回 204、是否校验 token）尚未取到，待补测。

**状态：22-1 已落码（未复测）；22-2 见 #12 的 12-5。**
