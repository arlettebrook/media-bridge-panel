# #15 `GET /api/emby/Shows/NextUp`（接下来看）

> 索引：[emby-compat.md「十、真机对照记录」](../emby-compat.md)


**真机样本**（予初Emby / 动漫Emby 已补测 —— 账号 `dlushu` 确有播放记录；OkEmby 4.9.1.90 / nyamedia 4.8.0.62 取到）

| 请求 | 含义 / 客户端用途 | 予初Emby | OkEmby | nyamedia |
|---|---|---|---|---|
| `/Shows/NextUp?UserId=<自己>`（有效 token） | SenPlayer「接下来看」行 | **200** `{"Items":[],"TotalRecordCount":0}` | **200** `{"Items":[],"TotalRecordCount":0}` | **200** 同 |
| 同上，但账号**确有已看进度** | 客户端最想要的"下一集"分支 | **200 空**（账号已看《三体》S1E1、《斗破苍穹》S5 E208–E210 等） | **200 空**（OkEmby 账号已看《神与律师事务所》S1E1–E5） | **200 空**（nyamedia 账号已看《清潭国际高中》S1E1–E3、《亲爱的X》S1E1–E2） |
| `?SeriesId=<有进度的那部剧>` | 只问某一部剧（SenPlayer 实测会带） | **200，非空**：`?SeriesId=964450`（斗破苍穹）→ 2 条（E211 `974543`、E213 `980788`）；`?SeriesId=294252`（三体）→ 29 条（E2–E30 整段未看集） | **200 空** | **200 空** |
| `?EnableRewatching=true` | 允许重看已完成项 | **200 空** | **200 空** | **200 空** |
| `?Limit=50` | 客户端分页取数 | **200 空** | **200 空** | **200 空** |
| 无 token / 无效 token | 全局守卫，客户端回登录页 | **401** `Access token is invalid or expired.` | **401** 纯文本 `Access token is invalid or expired.` | **401** 同（一次 `fetch failed`，未稳定复现） |

**鉴权分支**（有效 token + 异常 UserId，探针实测）

| 场景 | 含义 / 客户端用途 | 真机 | 面板（改前） | 处理 |
|---|---|---|---|---|
| 有效 token + **全 0 guid UserId** | 客户端换号 / 重登后仍带旧 UserId | **200** 空 | **401**（`authorize` 先比对 UserId 拦下） | **差异** → 已对齐，见 15-1 |
| 有效 token + **随机 guid UserId** | 同上 | **200** 空 | **401** | **差异** → 已对齐，见 15-1 |
| 有效 token + **不带 UserId** | 参数可缺 | **200** 空 | **401** | **差异** → 已对齐，见 15-1 |

**判读**：真机 NextUp **只验 token** —— 有效 token + 错配 / 不存在的 `UserId`（乃至不带）都不回 401/403，一律 **200**。端点取的是**按观看进度算下一集**（用户私有进度），属读取类，**适用「只验 token」的自动对齐例外**。进度**按 token 解出的账号取**（`accountIdFor` token 优先），**不引入跨账号可见性**。

**予初语义判读**：予初 **有** `Shows/NextUp` 端点（返回 **200**，非 404/501）—— **不是"不提供端点"**。但它的语义**非标准**：**裸调用恒回空**（即便账号确有已看剧集，如《斗破苍穹》S5 E208–E210、《三体》S1E1 均已看完）；**带 `SeriesId` 才出**，且回的是该剧**未看的集**（三体 E2–E30 共 **29 条**；斗破 E211 / E213 共 **2 条**），**不是标准 Emby 的"每剧一条下一集"**。即予初的 NextUp 语义与标准不符，**不能作为 NextUp 语义的真机佐证**（与下条「疑为聚合类服务器」判读一致）。

**予初改进度对照**（探针实测）：对未看集 `POST /Users/{UserId}/Items/{ItemId}/UserData`（body `{"PlaybackPositionTicks":N}`）→ **204**（写成功 —— 随即 `Items?Filters=IsResumable` 多出该集，pos 生效）；但 **`Items/Resume` 与 `Shows/NextUp`（裸）仍回空**、`?SeriesId` 结果不变 —— 说明予初这两个端点**根本不随观看进度变化**，进一步佐证其**非标准**（真正的"继续观看"数据只能由 `Items?Filters=IsResumable` 取到）。**测后已还原进度。**

**动漫Emby 补测**（**真 Emby 内核 4.10.1.0** + 聚合插件库；账号 `dlushu` 进度：《缘之空》S1 E11/E12 已看完、E4/E7/E8 在播，`IsPlayed` 112 条）

| 请求 | 含义 / 客户端用途 | 动漫Emby |
|---|---|---|
| `Shows/NextUp?UserId=<自己>`（裸） | SenPlayer「接下来看」行 | **200 空** `{"Items":[],"TotalRecordCount":0}` |
| `?SeriesId=87723`（缘之空，已看完 E11/E12）/ `+Limit=10` / `+Fields=UserData` / `+EnableRewatching=true` / `+MediaTypes=Video` | 只问某一部剧（SenPlayer 实测会带） | **200 全空**（对照：同库 `/Shows/87723/Episodes` 正常回 **12 集**） |
| 无 token / 有效 token + 不存在 UserId | 全局守卫 / UserId 不校验 | **401** / **200 空** |

**动漫Emby 语义判读**：账号该剧**已看完 E11/E12**、另有 **3 条在播集**，`Shows/NextUp` 仍**恒空**（带不带 `SeriesId` 都空），而同库的 `/Shows/{Id}/Episodes` 正常 —— 判读为**该服务器的 `Shows/NextUp` 未实现（聚合插件缺口）**，与 15-3 的「服务器功能缺口」一致，**不能作为 NextUp 语义佐证**。另注该服务器**查询参数只实现了一部分**（`IsResumable=true` 被忽略、回全库），同 #13 判读。

**响应形状**：空态四台一致 —— `{"Items":[],"TotalRecordCount":0}`，`application/json`。面板空态与之一致 ✓。

**差异处理**

- 15-1 **UserId 校验 → 适用自动对齐例外、已对齐「只验 token」**：真机**不比对 UserId**（有效 token + 错配 / 不存在 / 不带 UserId → 均 200）。取"下一集"属读取类，按既定口径直接对齐 —— `service.getNextUp` 的 `authorize(req, requestedId)` → `authorize(req)`；`accountIdFor(req, requestedId)` 保留（token 优先，UserId 仅作兜底语义），**不引入跨账号可见性**。**已落码，未复测**（待端到端复核：有效 token + 任意 UserId 应回 200）。
- 15-2 **空态形状 → 一致 ✓**：面板空态 `{"Items":[],"TotalRecordCount":0}` 与真机一致。
- 15-3 **数据口径 → 端点保留、对外恒空**：面板 NextUp **恒回空**（`{"Items":[],"TotalRecordCount":0}`），见 [ADR-0060](../adr/0060-nextup-hidden.md)（取代 [ADR-0023](../adr/0023-playback-progress.md) 中「`Shows/NextUp` 出真数据」那一格）。缘由**不是**复刻真机的空：真机的空是**服务器功能缺口**；面板恒空是**有意藏掉客户端首页那一行「接下来看」** —— 它与「继续观看」（`Items/Resume`）在常规顺序观看下指向同一集、两行重复。端点**保留不删**（老客户端 SenPlayer / CapyPlayer 会主动请求，避免 404 报错），**不加开关**；算「该看哪一集」的实现（`nextEpisodeItem` / `episodeExists` / `firstEpisodeItem`）**原样留着但不调用**，恢复时改回即可。四台真机**明明有已看进度却裸调用恒回空**（OkEmby / nyamedia 带 `SeriesId` / `EnableRewatching` / `Limit=50` 均空，同账号 `Items/Resume` 也空；予初裸调用同样空、带 `SeriesId` 才回"整段未看集"；动漫Emby 裸调用与带 `SeriesId` 都空、而同库 `/Shows/{Id}/Episodes` 正常），其已看条目 `UserData.LastPlayedDate` 还是 `undefined` —— 判读为**该服务器的 NextUp 功能不可用**（**服务器功能缺口，不是协议形状差异**）。**面板恒空的缘由与真机不同**（面板是有意藏掉重复行），**数据不同源。**
- 15-4 **非空样本 → 部分取到（予初，但语义不标准）**：予初带 `SeriesId` 会回非空 `Items`（如三体整段未看集 E2–E30），但其形状是"整段未看集"、非标准 Emby 的"每剧一条下一集"，**不能作为标准 `BaseItemDto` 字段样本**；OkEmby / nyamedia / 动漫Emby 仍取不到非空 `Items`（动漫Emby 带 `SeriesId` 也空）。标准非空 `Items[]` 字段样本**待补测**。

**面板特有行为（已随 ADR-0060 失效，留档）**：此前带 `SeriesId` 且**该剧在面板库里没有进度**时，面板回**第一集**（CapyPlayer 需要它来"从头看"）；真机该场景回空。ADR-0060 起端点恒回空，该行为一并**不再对外生效**（实现留着不调用）。

**不能模拟**：真机清单来自它自己的观看记录 / 片库；面板取的是面板库的观看进度，**数据不同源**。另注：四台真机的条目 `Id` / `SeriesId` 都是**数字**（予初 `293120` / `972383`，OkEmby / nyamedia `308210` / `232503`，动漫Emby `90625` / `87723`），**非 Emby 标准 Guid** —— 判读为**聚合类服务器**（动漫Emby 更明确：**真 Emby 内核 4.10.1.0 + 聚合插件库**，条目 `Path` 是远端 URL、`IsResumable=true` 参数被忽略），其 `Shows/NextUp`（及 `Items/Resume`）语义与标准 Emby 不符（裸调用恒空 / 带参回"下一集 / 整段未看集" / 端点未实现），对"真 Emby 语义"的参考价值有限。

**状态：15-1 已落码（未复测）；15-2 空态形状一致；15-3 按 [ADR-0060](../adr/0060-nextup-hidden.md) 端点保留、对外恒空（有意藏掉与「继续观看」重复的那一行，非复刻真机空）；15-4 予初部分取到、标准样本待补测。** 予初 / 动漫Emby 已补测（账号 `dlushu` 有进度），但两者语义都不标准（动漫Emby 的 `Shows/NextUp` 干脆未实现、恒空），不能作为标准 Emby 语义佐证；标准非空 `Items[]` 字段样本仍**待补测**。
