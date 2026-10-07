# ADR-0060 「接下来看」端点保留但对外恒空

- 状态：已采纳（取代 [0023](0023-playback-progress.md) 中「`Shows/NextUp` 出真数据」那一格）
- 相关：[0023](0023-playback-progress.md)（观看进度）· [0008](0008-no-fabricated-data.md)（不编数据）·
  [0048](0048-emby-userid-not-identity.md)（鉴权口径）· [emby-compat.md](../emby-compat.md) ·
  [15-shows-nextup](../emby-realdevice/15-shows-nextup.md) ·
  [service.js](../../server/modules/emby/service.js)（`getNextUp`）

## 背景

客户端首页有「继续观看」（`GET /Items/Resume`）与「接下来看」（`GET /Shows/NextUp`）两条读端点。
[0023](0023-playback-progress.md) 让两条都出真数据：`Resume` 回「有位置、未看完」的条目，
`NextUp` 回「该剧的下一集」。

常规顺序观看时，半看的那一集往往**就是**该剧的下一集，于是同一个条目在两行里各出现一次 ——
用户看到「两行重复」。按官方语义这本就允许（半看的正是下一集时才重叠，并非数据冲突），
但对面板的用户来说，首页两行长得一样，观感就是个 bug。

**怎么改都绕不开的一个事实**：`NextUp` 的计算实现（"该剧看哪一集"）与 `Resume` 高度重合，
想让它稳定不重复没有低成本的干净办法 —— 只能让其中一条不出数据。

## 决定

`GET /Shows/NextUp` **端点保留、对外恒空**：一律回 `200 {Items:[], TotalRecordCount:0}`，
只为藏掉首页那行「接下来看」。

- **不删端点**：老客户端（SenPlayer / CapyPlayer 会主动请求这条）不因 404 报错；恢复时改一处即可。
- **不加开关**：这是产品取向，不是给用户的配置项。
- **算「该看哪一集」的实现原样留着、暂不调用**：`nextEpisodeItem` / `episodeExists` /
  `firstEpisodeItem`（`service.js`）与 `db.listRecentBySeries` 保留，供恢复用。
- **鉴权口径不变**：无 token → 401 纯文本 `Access token is invalid or expired.`；
  有效 token + 错配 / 不存在的 `UserId` 仍回 200（见 [0048](0048-emby-userid-not-identity.md)）。

## 理由

- 首页只留「继续观看」一行，数据仍由 `Resume` 提供，用户不再看到重复。
- 保留端点对客户端**无感**（它照常收到 200，只是列表为空），改动面最小、可逆。
- 从「找真机复刻官方那一格重叠」这件事上退出来：已验的四台真机全是聚合类，测不出标准
  `Resume` / `NextUp` 语义（见 [15-shows-nextup](../emby-realdevice/15-shows-nextup.md)）；
  与其对齐一个验不了、对齐了也仍重复的语义，不如直接不重复。

## 备选

- **删端点（连同路由）**：客户端可能因 404 报错，且恢复要改多处。否决。
- **改算「序列上的上一集 / 下一集」完全对齐官方**：只在「倒回去半看更早一集」这种场景能少一次
  重叠，**动不了重复的主因**（常规顺序观看下官方本来也会重叠），且要真机样本佐证，成本高收益低。否决。
- **加配置开关**（让用户选显不显示「接下来看」）：多一个配置项，收益不明，且面板后端并没有这类
  "按客户端行为开关端点"的先例。否决。

## 后果

- **只依赖 `Shows/NextUp` 渲染那一行的客户端将不再显示该行**；`Resume` 不受影响，「继续观看」照常。
- `service.js` 里那段计算实现变成**暂未被调用的死代码** —— **有意保留**以便恢复；若要清理，
  删 `nextEpisodeItem` / `episodeExists` / `firstEpisodeItem` 与 `db.listRecentBySeries` 即可。
- [0023](0023-playback-progress.md) 中「`Shows/NextUp` 出真数据」那一格作废；其余部分
  （上报落库、`Resume`、`Items?Filters=IsPlayed`、`HideFromResume` / `PlayedItems` 写端点）
  **不变**。
