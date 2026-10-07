# ADR-0057 `System/Info` 取诚实子集：认领端点，但不编造面板没有的能力

- 状态：已采纳
- 相关：[0008](0008-no-fabricated-data.md)（不编数据）、[0007](0007-emby-dto-shape.md)（DTO 形状对齐真机）、[0056](0056-emby-compat-scope.md)（界内/界外）、[0048](0048-emby-userid-not-identity.md)（读取类只验 token）

## 背景

新客户端 Filmly/2.12.11-439 登录后打 `GET /api/emby/System/Info`（`System/Info/Public` 的加强版），落到 501 通配。此前 VidHub 3.0.6 也打过，它容忍了 501。

真机三台取样本：OkEmby(4.9) 28 字段 / nyamedia(4.8) 25 字段（同构，前者多 4 个 4.9 新增字段）/ itsmygo 极简 7 字段（仿 Emby，不作准）。面板自称 `Version=4.8.0.0`，与 nyamedia 同代。

难点在这条端点字段的性质：**大半是 Emby 服务端自身能力的自述** —— `WebSocketPortNumber` / `HttpServerPortNumber` / `HttpsPortNumber` / `SupportsLocalPortConfiguration` / `WanAddress`（网络监听地址）、`SystemUpdateLevel` / `CanSelfUpdate` / `CanSelfRestart` / `HasUpdateAvailable` / `HasPendingRestart`（自更新 / 自重启）、`SupportsLibraryMonitor`（本地媒体库监控）、`OperatingSystemDisplayName` / `HardwareAccelerationRequiresPremiere`（转码加速）。面板**没有**这些对应的东西。

于是出现一个抵牾：端点本身属面板该给的表面（服务器自述信息，界内，见 [0056](0056-emby-compat-scope.md)），但它要的字段大多是面板没有的能力。若为"形状与真机一致"把这些字段填上最接近真机的值，就等于**替面板编造它不具备的能力**，与 [0008](0008-no-fabricated-data.md) 冲突。

## 决定

**认领端点、实现它，但字段只给面板真有的 —— 诚实子集。**

回 17 个字段（真机 4.8 为 25 个）：

- 身份：`ServerName` / `Version`(`4.8.0.0`) / `Id`。
- 运行环境：`OperatingSystem`（面板运行所在 OS，按 Emby 写法给 `Linux` / `OSX` / `Windows` …）。
- 地址：`LocalAddress`（请求 `Host` 去端口）/ `LocalAddresses:[]` / `RemoteAddresses:[]`。
- 能力位**一律如实 `false`**：`HasPendingRestart` / `IsShuttingDown` / `SupportsLibraryMonitor` / `CanSelfRestart` / `CanSelfUpdate` / `CanLaunchWebBrowser` / `SupportsHttps` / `HasUpdateAvailable` / `SupportsAutoRunAtStartup`。
- `CompletedInstallations:[]`。

**不回**（面板无对应物、不编造数值）：`SystemUpdateLevel` / `OperatingSystemDisplayName` / `SupportsLocalPortConfiguration` / `WebSocketPortNumber` / `HttpServerPortNumber` / `HttpsPortNumber` / `HardwareAccelerationRequiresPremiere` / `WanAddress`。

鉴权与 `Studios`（#14）/ `Items/Counts`（#16）同口径：`authorize(req)` **只验 token、不比对 `UserId`**（服务器级信息、与用户无关）。

## 理由

- **能力位给 `false` 是"如实"，不是"降级"**：面板确实没有自更新 / 自重启 / 本地库扫描这些能力，`false` 就是事实；这与 [0008](0008-no-fabricated-data.md) 一致，不是妥协。
- **数值类字段无法"如实"**：端口 / 广播地址是面板根本没有的东西，编一个接近真机的数只是"看起来像 Emby"，对客户端无用、对排查有害。字段**缺席**比**假值**更诚实 —— 客户端按缺席走"该能力不可用"，与 `false` 的语义一致。
- **字段集小于真机是已知代价、可接受**：真机字段集本身**随版本演进**（4.9 比 4.8 多 4 个），客户端对"少字段"本就容忍（VidHub 对整条端点缺失都容忍）。少几个面板没有的字段，好过为对齐形状而编造。

## 备选

- **对齐真机 4.8 全 25 字段（能力位 / 数值位给最接近真机的诚实值）**：字段集与真机同构，客户端拿到的对象形状一致。但对 `WebSocketPortNumber` / `HttpsPortNumber` / `WanAddress` / `SystemUpdateLevel` 这些面板**确无对应物**的字段只能给近似值 —— 属编造，与 [0008](0008-no-fabricated-data.md) 冲突。没选。
- **继续 501、不认领**：端点属界内（服务器自述信息，面板该给），且客户端实际在要（Filmly 打到 501）。不认领等于把界内端点当界外处理。没选。
- **只实现 `System/Info/Public` 的 5 字段（最小化）**：能过客户端，但"运行环境 / 能力位"这些**面板能给诚实值**的字段也一并省掉，诚实子集还能更大。没选（没必要省到 5 个）。

## 后果

- `GET /api/emby/System/Info` 不再落 501；字段集为真机 4.8 的**真子集**（17 ⊂ 25），逐字段清单见 [emby-realdevice/20-system-info.md](../emby-realdevice/20-system-info.md)。
- 对客户端是**新可见端点**：此前 501、客户端容忍（VidHub）或受影响（Filmly）；现按诚实子集作答。客户端无需改动。
- 若将来某能力真落到面板（例如面板实现了受控自重启），届时补上对应字段、把 `false` 改真值即可 —— 本决策只约束"不编造"，不约束"以后不许有"。
- 同款取舍可推广到其它"字段多为服务端自身能力自述"的端点：**认领端点 + 只给真有的字段**，优于"为形状对齐而填近似值"。
