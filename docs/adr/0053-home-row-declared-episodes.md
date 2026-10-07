# ADR-0053 `Items/Counts` 的 `EpisodeCount` 取首页插件申报的「剧库集数」

- 状态：已采纳
- 相关：[0051](0051-home-row-declared-total.md)（首页行可申报「库总数」）、[0052](0052-items-counts-library-total.md)（`MovieCount`/`SeriesCount` 已取库总数，本条目把同一条路子延伸到 `EpisodeCount`）、[0008](0008-no-fabricated-data.md)（不编数据）、[0029](0029-plugin-channel-and-actions.md)（插件契约：由插件申报能力）

## 背景

[0052](0052-items-counts-library-total.md) 让 `MovieCount` / `SeriesCount` 取首页插件行申报的库总数后，`Items/Counts` 里**电影 / 剧集有真数、集数仍是 0**，同一个"剧库规模"被拆成了半截：客户端首页汇总看到 233180 部剧，却看不到这些剧一共多少集。

真机 `EpisodeCount` 来自它自己的片库索引（OkEmby `82747`、nyamedia `52806`），面板没有索引 —— 但**上游确实有这份数据**：TMDB 官网 About 页的 Stats 里就有 `TV Episodes`（实测 `6,762,023`），与 `Movies` / `TV Shows` 是**同一张页面、同一个口径**（都是"上游全库规模"）。此前没被取用，只是插件的 `parseAbout` 只认 `Movies` / `TV Shows` 两个标签、其余块跳过。

## 决定

- 首页插件契约的 `rows` 行申报新增**可选**字段 **`episodes`**：「这个剧库里的剧一共多少集」（上游库规模，与 `total` 同口径）。见插件仓库 `docs/emby-home-plugin.md`。
- 面板 `home.libraryTotals()` 从 **`tvshows` 行**归并 `episodes`（同类型多行取最大值，不相加；`mixed` 行不参与），`service.getItemCounts()` 用它填 **`EpisodeCount`**。
- 归并规矩与 0052 对 `MovieCount` / `SeriesCount` 的处理**完全一致**：申报才填、`> 0` 才被采用、没来源就回 0（= 数不出来）。

## 理由

- **口径自洽**：`EpisodeCount` 与 `MovieCount` / `SeriesCount` 同源于"上游全库规模"，三项由同一条 `rows` 契约申报，不再一个真数一个 0。
- **不越过 ADR-0008 的线**：填的是**插件自愿申报的上游库集数规模**，不是面板自己数的、也不是拿"这一页有多少集"冒充的。
- **不复刻真机数**：真机数来自它的片库索引，面板取不到；面板回的是**上游全库规模**，两者**数据不同源**（与 0052 同款取向，属有意）。
- **`episodes` 独立于 `total`**：`total` 是"这个库有多少条"、`episodes` 是"这些剧一共多少集"，是两个数；不把它们合并成一个字段，免得消费方猜语义。

## 备选

- **`EpisodeCount` 继续回 0**：0052 时代的状态，但上游已有同口径的数、`total` 这条路也铺好了，继续留 0 站不住。**没选**。
- **把集数塞进 `total`**：`total` 已经是"库有多少条"，再塞集数会毁掉它本来的语义。**没选**。
- **`mixed` 行也申报 `episodes`**：影剧混装说不清"这些条目里多少集"，硬报就是编。**没选**（与 0051/0052 对 `mixed` 的处理一致）。
- **面板自己抓 TMDB / 建集数索引**：越权且代价大，且 0051 已定"面板不为此打上游"。**没选**。
- **新增一个整库级的 `counts` 动作**：为三个数字新开一个通道与动作，代价远大于在 `rows` 上加一个可选字段。**没选**（`total` 的先例已证明可选字段够用）。

## 后果

- 对客户端是**新可见值**：`ItemCounts.EpisodeCount` 由 0 变为插件申报的剧库集数（命中申报时），未申报时仍是 0。属契约变更，已在 `docs/emby-compat.md` 的契约变更记录里声明。
- **0 的语义要记住**：与 0052 同 —— `0` 表示**"数不出来"**，不是"没有集"。
- 插件侧 TMDB 的取数**不新增抓取**：`episodes` 与 `total` 同抓一次 About 页（成功 6 小时 / 失败退避 10 分钟），只是多认了 `TV Episodes` 这个标签。
- 插件契约文档在**另一个仓库**（[media-bridge-plugins](https://github.com/dlushu/media-bridge-plugins) 的 `docs/emby-home-plugin.md`），本仓库只消费、不留副本。
