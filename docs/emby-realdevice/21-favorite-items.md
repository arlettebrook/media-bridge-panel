# #21 收藏（`POST|DELETE /api/emby/Users/{UserId}/FavoriteItems/{ItemId}` + `Items?Filters=IsFavorite`）

> 索引：[emby-compat.md「十、真机对照记录」](../emby-compat.md)


**触发**：日志里 `POST /Users/{UserId}/FavoriteItems/{ItemId}` 与 `DELETE …/FavoriteItems/{ItemId}` 落到 501（`✘ emby 未实现#5` / `#6`，客户端 Rex/1.0.0）；紧跟着 `Items?Filters=IsFavorite` 回空（当时本面板**没有收藏数据**，如实回空）。三者是同一件事的三面：写收藏、取消收藏、读收藏列表。

**真机样本**（四台实测；地址已用代号，抓取探针见「十」的约定）

写端点的请求体**为空**，路径参数 `ItemId` 是**客户端从列表里拿到的原样 Id**（本面板发出去的 Id；真机这里是数字串，如 `864879`）。

| 请求 | 含义 / 客户端用途 | 予初Emby 4.9.5 | OkEmby 4.9.1 | nyamedia 4.8.0 | itsmygo（仿制） |
|---|---|---|---|---|---|
| `POST …/FavoriteItems/{ItemId}`（有效 token） | 标记收藏 | **200**（见下形状） | **200** 同 | **200** 同 | **200** 同 |
| `DELETE …/FavoriteItems/{ItemId}`（有效 token） | 取消收藏 | **200**（同上、`IsFavorite:false`） | **200** 同 | **200** 同 | **200** 同 |
| 无 token / 无效 token | 全局守卫，客户端回登录页 | **401** 纯文本 `Access token is invalid or expired.` | **401** 同 | **401** 同 | **401** `{"error":"unauthorized"}` |
| 有效 token + **不存在的 ItemId** | 客户端拿了个已下架 / 拼错的 Id | **500** 纯文本 `Object reference not set to an instance of an object.` | **500** 同 | **500** 同 | **404** `{"error":"not found"}` |

**写端点的响应形状**（`UserItemDataDto`，字段随该条目的用户态而变）

```json
// 予初Emby 4.9.5（该条目有观看进度 → 多带进度两键）
{"PlayedPercentage":5.76911471934157,"PlaybackPositionTicks":4425547900,"PlayCount":0,"IsFavorite":true,"Played":false}

// OkEmby 4.9.1 / nyamedia 4.8.0（该条目无进度 → 零值省略，只 4 键）
{"PlaybackPositionTicks":0,"PlayCount":0,"IsFavorite":true,"Played":false}

// itsmygo（仿制，字段更多且自带 Key/ItemId/ServerId/LastPlayedDate，非 Emby 惯例）
{"IsFavorite":true,"ItemId":"…","Key":"…","LastPlayedDate":null,"PlayCount":0,"PlaybackPositionTicks":0,"Played":false,"PlayedPercentage":0,"ServerId":"embyshare0001"}
```

**读列表的形状**（`Items?Filters=IsFavorite`）

| 场景 | 含义 | 真机 |
|---|---|---|
| 有收藏（刚 POST 后） | 首页 / 收藏页取列表 | **200** `{"Items":[{…, "UserData":{"IsFavorite":true,…}}],"TotalRecordCount":1}` |
| 无收藏（DELETE 还原后） | 同上 | **200** `{"Items":[],"TotalRecordCount":0}`（33 字节，与 `Resume`(#13) 空态同形） |

集合条目带**条目级 `UserData`**，其 `IsFavorite` 读出真值 `true`（其余字段见 #08 / #17 的条目形状）。

**收藏对象（可收藏的条目类型）** —— OkEmby 4.9.1 实探

真机写端点**按 Id 认条目、与类型无关**：对同一账号的四种条目各 `POST` 一次，均 200 且 `IsFavorite:true`，随后 `DELETE` 还原为 `IsFavorite:false`（还原后 `GET /Items/{Id}` 复核）：

| 条目类型 | Id | `POST` 响应 | 还原复核 |
|---|---|---|---|
| Movie | `864879`（前序样本） | 200 `IsFavorite:true` | 已还原 |
| **Series（剧）** | `169812` | 200 `IsFavorite:true` | `Type Series … IsFavorite:false` |
| **Season（季）** | `174217` | 200 `IsFavorite:true` | `IsFavorite:false` |
| **Episode（集）** | `171054` | 200 `IsFavorite:true` | `IsFavorite:false` |

→ **面板认的 Id 形状与真机对齐 = 电影 / 剧 / 季 / 集全认**（不能像 `playableOf()` 那样只认可播的电影 / 集；「收藏整部剧」是真机的常规用法）。

**判读**

- 真机写端点**返回 `UserItemDataDto`**（不是空体）—— 与 `PlayedItems`（`POST|DELETE`）同一族，字段集就是 `{PlaybackPositionTicks, PlayCount, IsFavorite, Played}`（有进度再带 `PlayedPercentage`）。**零值 / null 字段被省略**（OkEmby / nyamedia 无进度时不带 `PlayedPercentage`；真机都不带 `LastPlayedDate`）。
- **`ISFavorite` 写的是"用户私有数据"**：请求路径带 `UserId`、影响的是该用户的收藏集合 → 属**写用户数据**类，**不适用**读取类的「只验 token」自动对齐例外；写端点**一律校验账号**（同 `PlayedItems` / `HideFromResume` 的既定口径）。
- itsmygo 的 401 / 404 是**它自己的 JSON 形状**（Go 后端），非 Emby 纯文本惯例 —— 登记备查、**不复刻**（同 #18-5）。
- 真机对「不存在的 ItemId」回 **500 误码**（`NullReferenceException`），是**真机自身解析 bug**，与 #10-2 / #11-2 同族 —— 判定**不复刻**。
- 真机写端点对**文件夹类**条目（剧 / 季）的 `UserItemDataDto` 里多带 `UnplayedItemCount`（见上「收藏对象」实探），与读侧季条目的同名键同源；面板写端点是否补该键，落码时定。
- `Items?Filters=IsFavorite` **是真数据**：真机按该账号的收藏集合回条目；面板读自己的收藏库（[ADR-0058](../adr/0058-favorite-items.md)），此前回空是**没有这份数据**，判为**界内**（[ADR-0056](../adr/0056-emby-compat-scope.md) 曾记「界内待补」，现已实现）。

**差异与处理**

- **认领端点**：写端点（`POST|DELETE …/FavoriteItems/{ItemId}`）与读支路（`Filters=IsFavorite`）都属**界内**（"标记收藏 / 列出收藏"就是面板该给的能力），故实现、不再落 501。
- 21-1 **写端点返回 200 + `UserItemDataDto` → 对齐**：以 `PlayedItems` 为模板 —— 校验账号 → 按 Id 认条目 → 写收藏库 → 回 200 + `UserItemDataDto`（`IsFavorite:true|false`）。字段给 `{PlaybackPositionTicks, PlayCount, IsFavorite, Played}`（进度从面板 `playback` 表取，有进度再带 `PlayedPercentage`）。**未复测**。
- 21-2 **「不存在的 ItemId」→ 不复刻真机的 500**：面板 Id 前缀认不出 / 认得出但查不到 → **204 且不写库**（同 `PlayedItems` 口径，不 500、不 404，防枚举）。**未复测**。
- 21-3 **鉴权 → 写端点一律校验账号**：无 / 无效 token → **401 纯文本**（与真机一致）。`UserId` 仍比对（写用户数据，不享受读取类的放宽）。**未复测**。
- 21-4 **`Filters=IsFavorite` → 由"如实回空"转"真数据"**：读收藏库（按 token 解出的账号）→ 用**收藏时已快照的元数据**重建 `QueryResult<BaseItemDto>`；`UserData.IsFavorite` 出真值。**0 上游请求**（快照口径见 [ADR-0058](../adr/0058-favorite-items.md)；**不与** `IsPlayed` / `Resume` 的「读时反查」同族）。**未复测**。
- 21-5 **`UserData.IsFavorite` 全链路出真值**：列表 / 详情 / 季集等各处 `UserData` 不再写死 `false`，改按收藏库查。**未复测**。
- 21-6 **可收藏的条目类型 → 与真机对齐（电影 / 剧 / 季 / 集全认）**：真机写端点与类型无关（见上「收藏对象」实探），面板**不得**限于可播 Id（`playableOf()` 只认电影 / 集）。**未复测**。

**不能模拟**：真机的收藏集合来自真机自己的用户库；面板的收藏是**面板自己新增的存储**（一行 = 账号 + 条目），与真机数据**不同源**。客户端看到的是本面板的收藏，不是真机那份。

**状态：真机样本已取齐（四台；写端点 200 形状 + 401 + 500/404 误码 + 读列表空 / 非空两态）；可收藏条目类型于 OkEmby 实探（电影 / 剧 / 季 / 集四类全接受，已还原无残留）。** 面板侧 21-1～21-6 **已落码**、标「**未复测**」，待端到端复核。
