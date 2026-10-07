# 设计决策记录（ADR）

本目录记录**会影响系统形态的决策**：为什么这样分层、为什么采用某个判据或失败语义、
否决了哪些方案。每条决策一个文件，只写背景、决定、理由、备选与后果，不复述实现细节
（实现细节见 [develop.md](../develop.md) 与各模块文档）。

状态取值：**已采纳** / **已否决** / **已被取代**（被取代时注明后继条目）。

| 编号 | 决策 | 状态 |
|---|---|---|
| [0001](0001-module-layering.md) | 模块分层与依赖方向 | 已采纳 |
| [0002](0002-in-process-emby-to-agg.md) | emby 层进程内直调聚合层 | 已采纳 |
| [0003](0003-local-title-scoring.md) | 挑片判据：本地打分，不做 TMDB 反查 | 已采纳（取代精确同名 + 别名回退） |
| [0004](0004-no-same-site-dedup.md) | 同一站点内不做同名去重 | 已采纳 |
| [0005](0005-continuation-fetch.md) | 接续补打：最多试 N+K 条，凑够 N 条即止 | 已采纳（触发/停止口径被 0027 取代） |
| [0006](0006-redirect-for-playback.md) | 播放一律 302，不代理流量 | 已采纳（取代代理/跳转双模式；HLS 清单这一跳的例外见 0040） |
| [0007](0007-emby-dto-shape.md) | Emby 响应按真机 DTO 形状对齐 | 已采纳 |
| [0008](0008-no-fabricated-data.md) | 不编数据：不知道就空字段，没有数据就如实回空 | 已采纳 |
| [0009](0009-unauthenticated-empty-responses.md) | 回空的端点不校验账号 | 已采纳 |
| [0010](0010-tmdb-config-in-panel.md) | TMDB 配置归面板层 | 已采纳（配置归属被 0031 取代） |
| [0011](0011-cache-split-by-consumer.md) | 缓存按消费方分库 | 已采纳 |
| [0012](0012-deployed-sources-auto-aggregate.md) | 本地托管的源自动参与聚合 | 已采纳 |
| [0013](0013-image-endpoint-signing.md) | 图片端点：签名 tag + 本地索引 | 已采纳 |
| [0014](0014-frontend-no-build.md) | 前端零构建 | 已采纳 |
| [0015](0015-source-bundle-integrity.md) | 源包的两道 md5 校验 | 已采纳 |
| [0016](0016-source-auto-update-default-off.md) | 源自动更新默认关闭 | 已采纳 |
| [0017](0017-panel-auth-single-password.md) | 面板门禁：单密码，不是用户体系 | 已采纳 |
| [0018](0018-branding-single-source.md) | 产品名只在一处定义 | 已采纳 |
| [0019](0019-self-update-from-release.md) | 自身更新：应用装在数据卷、按 Release 资产安装、进程重启生效 | 已采纳（重启的非托管口径被 0038 局部取代） |
| [0020](0020-detail-snapshot.md) | 详情快照 + 剧集详情提前返回（同一次点播被算三遍的那一步存下来） | 已采纳（缓存归属与有效期被 0032 取代） |
| [0021](0021-update-replaces-app-dir.md) | 更新即完整替换：只保留当前版本，不留本地旧版本 | 已采纳 |
| [0023](0023-playback-progress.md) | 观看进度：客户端 `Sessions/Playing*` 上报落库，「继续观看 / 接下来看 / 已看」出真数据 | 已采纳 |
| [0022](0022-movie-all-play-items.md) | 电影取法：每条线路列出全部播放项（剧集仍按集号定位） | 已采纳（版本 Id 的载荷形状描述随 0039 作废） |
| [0024](0024-site-speed-test.md) | 站点测速：服务端任务、打 `/search`、随机片名、只留最近一次 | 已采纳 |
| [0025](0025-line-filter-in-usable-judgement.md) | 线路过滤参与"有没有用"的判据（并进快照 key） | 已采纳（局部取代 0020；转发口径被 0043 局部取代） |
| [0026](0026-seconds-and-detail-timeout.md) | 聚合超时：搜索与取详情分开，时间单位统一为秒 | 已采纳 |
| [0027](0027-extra-fetch-only-when-zero.md) | 补打只在"一条能用的都没有"时触发（并发批、拿到即停） | 已采纳（局部取代 0005） |
| [0028](0028-plugin-system.md) | 插件体系：包安装、不沙箱、每个插件一个常驻子进程 | 已采纳（崩溃重启部分被 0037 取代） |
| [0029](0029-plugin-channel-and-actions.md) | 插件契约：走管道、用动作名、由插件申报能力 | 已采纳 |
| [0030](0030-play-address-handoff.md) | 播放地址转交：伪地址的 host 是面板，`ref` 由插件解析 | 已采纳（延伸 0006） |
| [0031](0031-metadata-by-domain.md) | 元数据按域分离：插件注册域 id，面板按前缀分派 | 已采纳（局部取代 0010） |
| [0032](0032-cache-two-levels.md) | 缓存分两级：插件侧管"下次点开也快"，面板侧只管线路结果 | 已采纳（局部取代 0020） |
| [0033](0033-template-and-domain.md) | 模板与域：模板是配置数据文件，每个域最多一套 | 已采纳 |
| [0034](0034-fresh-install-no-migration.md) | 本版当作全新安装：不做数据迁移 | 已采纳 |
| [0035](0035-plugin-library.md) | 插件不随面板发行，改从独立的插件仓库安装 | 已采纳 |
| [0036](0036-image-endpoint-redirect.md) | 图片端点一律 302：面板不再代取字节 | 已采纳 |
| [0037](0037-no-plugin-auto-restart.md) | 插件进程崩了不自动重启 | 已采纳 |
| [0038](0038-self-relaunch-when-unmanaged.md) | 面板重启：非托管运行方式下自拉起进程 | 已采纳（局部取代 0019） |
| [0039](0039-compressed-source-id.md) | 版本 Id：编码前先 deflate（客户端 URL 有硬上限） | 已采纳（局部取代 0022 的载荷形状描述） |
| [0040](0040-hls-playlist-relay.md) | HLS 清单由面板中继一次：把相对地址补成绝对 | 已采纳（0006 的局部例外） |
| [0041](0041-any-provider-id-multi-value.md) | `AnyProviderIdEquals` 支持多值：逐条试、认不出的跳过 | 已采纳 |
| [0042](0042-auth-line-byte-relay.md) | `proxy` 线路：面板代持鉴权头中继（字节转发） | 已采纳（0006 针对要鉴权头线路的局部例外；Emby 层那一格由 0044 补上） |
| [0043](0043-line-filter-at-aggregate-output.md) | 线路过滤下沉到聚合层产出处：客户端拿到的就是滤过的那份 | 已采纳（局部取代 0025 的转发口径） |
| [0044](0044-emby-stream-playvia-relay.md) | Emby 层也接 `proxy` 档：`playVia` 编进版本 Id | 已采纳（延伸 0042） |
| [0045](0045-relay-chunked-concurrent.md) | 字节中继改分块并发：把开放式 Range 换成有界 Range | 已采纳（改 0042 第 3 条约束的实现） |
| [0046](0046-plugin-multiple-types.md) | 插件多类型：一个包一个 id，types 平级 | 已采纳（已实现；迁移见 0047） |
| [0047](0047-data-migration-gate.md) | 数据迁移框架：版本门禁 + 冲突处置向导 + 提交点续跑 | 已采纳（已实现；交互口径 2026-10-04 修订：无冲突静默迁移、有冲突才铺向导） |
| [0048](0048-emby-userid-not-identity.md) | Emby 端点鉴权口径：token 是身份，`UserId` 只是参数 | 已采纳（读取类只验 token；`Users/{UserId}` 保持账号校验、不放开跨账号） |
| [0049](0049-emby-instance-download-switch.md) | Emby 实例级「下载」开关：默认开的产品能力 | 已采纳（驱动 policy / `CanDownload` / 下载端点三处同一口径；偏离真机样本属有意） |
| [0050](0050-relay-chunk-policy-aligned-with-worker.md) | 中继取块策略对齐 media-bridge-relay：慢判死 / 头部对冲 / 重试口径 | 已采纳（细化 0045） |
| [0051](0051-home-row-declared-total.md) | 首页插件行可申报「库总数」，喂给客户端 `Views.ChildCount` | 已采纳（「不改 `ItemCounts`」一条被 0052 取代） |
| [0052](0052-items-counts-library-total.md) | `Items/Counts` 的 `MovieCount`/`SeriesCount` 取首页插件申报的库总数 | 已采纳（复用 0051 的同一条契约；取代 0051「不改 `ItemCounts`」） |
| [0053](0053-home-row-declared-episodes.md) | `Items/Counts` 的 `EpisodeCount` 取首页插件行申报的「剧库集数」 | 已采纳（延伸 0052 的同一条路子） |
| [0054](0054-bare-items-query-uses-random-feed.md) | 无 `ParentId` 的裸列表查询复用 `feed: 'random'` | 已被取代（被 [0055](0055-bare-items-query-returns-views.md) 取代） |
| [0055](0055-bare-items-query-returns-views.md) | 无 `ParentId` 的裸 `Items` 查询回顶层库列表 | 已采纳（取代 0054） |
| [0056](0056-emby-compat-scope.md) | Emby 兼容层的范围界定：只照官方 API 的表面 | 已采纳 |
| [0057](0057-emby-system-info-honest-subset.md) | `System/Info` 取诚实子集：认领端点，但不编造面板没有的能力 | 已采纳 |
| [0058](0058-favorite-items.md) | 收藏：收藏时快照元数据落库（用户数据，不随缓存清理），读列表只吃快照 | 已采纳 |

## 新增一条 ADR

1. 复制任一条目作为模板，编号取当前最大值 +1，文件名 `NNNN-短横线短语.md`。
2. 必须写清"备选方案"与"后果" —— 这两节是后来者最需要的部分。
3. 若某条决策取代了既有条目，把旧条目的状态改为"已被取代"并链到新条目，**不要删除旧条目**。
