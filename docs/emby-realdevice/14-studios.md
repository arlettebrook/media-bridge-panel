# #14 `GET /api/emby/Studios`（工作室清单）

> 索引：[emby-compat.md「十、真机对照记录」](../emby-compat.md)


**真机样本**（三台均登录 200）

| 请求 | 含义 / 客户端用途 | 予初Emby | OkEmby | nyamedia |
|---|---|---|---|---|
| `/Studios`（有效 token） | 工作室筛选列表 | **200** 全量清单，`TotalRecordCount: 15601` | **200** 全量清单，`TotalRecordCount: 8181` | **200** 全量清单，`TotalRecordCount: 1324` |
| `/Studios?Limit=2` | 客户端分页取数 | **200** 前 2 条，`TotalRecordCount` 仍回**总数**（15601） | **200** 前 2 条 / 总数 8181 | **200** 前 2 条 / 总数 1324 |
| `/Studios?SearchTerm=Warner` | 按名字筛工作室 | **200** 命中若干（`Warner Premiere` / `Warner Bros. Pictures` / `Warner Bros. Animation` …） | **200** 命中若干 | **200** 命中 **2** 条（`Warner Bros. Japan` / `Warner Bros. Pictures`） |
| 无 token / 无效 token | 全局守卫，客户端回登录页 | **401** 纯文本 `Access token is invalid or expired.` | **401** 同 | **401** 同（`Content-Type: text/html`） |

**条目形状**（真机，予初Emby 第一条）

```json
{"Name":"Pixar","ServerId":"…","Id":"240810","Type":"Studio",
 "UserData":{"PlaybackPositionTicks":0,"PlayCount":0,"IsFavorite":false,"Played":false},
 "ImageTags":{},"BackdropImageTags":[]}
```

- `Id` 是**字符串**（数字样式：予初 `240810`、OkEmby `530`、nyamedia `45`）；`Name` / `ServerId` / `Type:"Studio"` 齐。
- `ImageTags.Thumb` **有封面时才给**（如 `Warner Bros. Pictures`）；无封面给 `ImageTags:{}`。
- `UserData` 四键（`PlaybackPositionTicks` / `PlayCount` / `IsFavorite` / `Played`）；**nyamedia（4.8.0.62）在全 0 时省略整个 `UserData`**（Emby 略去默认值）。
- `BackdropImageTags` 一律 `[]`。

**面板响应**：`{Items:[], TotalRecordCount:0}`（如实回空）。

**差异处理**

- 14-1 **鉴权 → 已按「只验 token」对齐**：真机**无 token / 无效 token 一律 401 纯文本**（三台一致）；面板改前**不校验**（回空即 200）。同 `Items`（5-1）/ `Items/Latest`（6-1）口径，在路由层加 `authorize(req)`。**已落码，未复测**（待端到端复核：无 token → 401；有效 token → 200 空）。
- 14-2 **全量清单 → 不复刻**：真机回**全库去重工作室清单**（几千至上万条），`Limit` / `SearchTerm` 生效；面板**没有片库索引**（列表数据由首页插件现跑、从不存"库里有哪些片"），硬凑只会得到随榜单波动的假清单。**判定不复刻**，仍**如实回空**（既有决策，见「五」）。**数据不同源。**
- 14-3 **空态形状 → 一致 ✓**：面板空态 `{"Items":[],"TotalRecordCount":0}` 与真机在"库内无工作室"时应有的形状一致。

**不能模拟**：真机清单来自它自己的片库（每台条目数不同）；面板无片库索引，`Items[]` 只能为空。

**状态：14-1 已落码（未复测）；14-2 判定不复刻；14-3 空态形状一致。** `Items[]` 条目级字段（`Id` 类型 / `ImageTags` / `UserData`）面板无样本可比（恒为空）。
