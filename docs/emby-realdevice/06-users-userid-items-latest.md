# #6 `GET /api/emby/Users/{UserId}/Items/Latest`（最新条目）

> 索引：[emby-compat.md「十、真机对照记录」](../emby-compat.md)


**真机样本**（OkEmby 4.9.1.90；予初Emby 仍不可达）

**错误分支**（与 #5 完全同款）

| 场景 | 真机 | 面板 | 处理 |
|---|---|---|---|
| 无 token（**任何形状**：带/不带 `ParentId`、无参） | **401 纯文本** `Access token is invalid or expired.` | 只在"会出数据"支路（带本面板库 `ParentId`）401；不带 `ParentId` 回 200 空 | **待定夺**（6-1，与 5-1 同款） |
| 有效 token + 合法但不存在的 UserId | **200 照常回数据**（`ParentId=4416&Limit=1` → 1 条） | `assertUser` → 404 JSON | **待定夺**（6-2，与 5-2 同款） |

**成功分支**

| 查询形状 | 真机 | 面板 | 处理 |
|---|---|---|---|
| `ParentId=<库Id>` | **裸数组**真实条目（movies 库直接给 `Movie`，tvshows 库给 `Series` —— 与 `Items` 不递归给子文件夹**不同**，Latest 不绕目录层）；无 `Fields` 时 **10 键**列表字段（同 #5：`Name/ServerId/Id/RunTimeTicks/IsFolder/Type/UserData/ImageTags/BackdropImageTags/MediaType`） | **裸数组**插件行真实条目（Movie/Series，平铺），全量 ~25 键 | 一致（字段超集保留，理由同 #5） |
| `Limit` 缺省 | **20**（不带 ParentId 实测正好 20 条） | **20**（`LATEST_DEFAULT_LIMIT`） | 一致 |
| `StartIndex` | 生效（`Limit=2&StartIndex=1` → 跳过 1 条、回 1 条） | 原样透传模块 | 一致 |
| **不带 `ParentId`** | **跨库 20 条**（全局最新，11 键：条目带 `Status`/`AirDays` 等） | **空数组** | **保留**（面板无跨库索引：凑它要把每个插件行都跑一遍 = N 次上游，拿代价换答不准的答案，service.getLatest 注释已写；实测客户端 VidHub 是**逐库打**，不发无 ParentId 形状） |

**不能模拟**：真机"最新"= 文件入库时间排序（面板没有片库/文件，行返回的顺序即"最新"，有意如此）；不带 `ParentId` 的跨库聚合。

**已按用户确认改（2 点，均同 #5 口径）**：
- 6-1 **已改**：Latest 守卫改无条件 `authorize(req)`（无 token 一律 401，含不带 `ParentId` 的空分支）。
- 6-2 **已改**：UserId 放宽 —— 路由 `authorize(req, params.userId)` → `authorize(req)`；`getLatest` 删 `assertUser` 且签名收敛为只收 `query`（本端点不读用户私有数据，`applyUserData` 已自带 token 兜底）。
- 6-3 **已改（未复测）：条目不再回空串 `PremiereDate` / `Overview`**。真机 `Items/Latest` 响应**不含 `PremiereDate` 键**（拿不到就不给；本项目实测的两包对照：面板 `Items/Latest` 每响应 `"PremiereDate":""` ×20，真机包零空串、零 `PremiereDate`）。客户端（Hills 1.9.1）对该字段做 `DateTime.parse(value)`，`parse('')` 抛 `FormatException: Invalid date format`、**整条响应解码失败** → 首页「最新」整个打不开。现对齐真机：`baseItem()` 里 `PremiereDate` / `Overview` 改为**有值才挂键**（口径同 `DateCreated` / `DateModified`，见 [ADR-0061](../adr/0061-omit-missing-scalar-fields.md)）；**数组类字段仍铺 `[]`**。**未复测**（需再抓一次 `Items/Latest` 确认 `PremiereDate` 键在无值时消失、客户端不再报 `FormatException`）。同一改动也覆盖 `Items/Resume` / `Items` 列表 / 详情等（`baseItem` 共用）。
- **顺带清理**：随 5-1/6-1 失去全部调用方的 `itemsWillReturnData()` 与 `searchProviderId()` 已删（死代码），相关注释同步。~~Studios 端点仍保持 token 豁免（它永远回空，注释已注明口径分叉）~~ —— 该豁免**已作废**：`Studios` 自 #14 起对齐真机改**只验 token**（详见「十」#14）。

**状态：未复测**（6-1 / 6-2 已落码：`node tools/check-syntax.js` 通过；面板端到端待批量复测。6-3 已落码、**未复测** —— 待抓 `Items/Latest` 复核 `PremiereDate` 键在无值时消失、客户端不再报 `FormatException`）。
