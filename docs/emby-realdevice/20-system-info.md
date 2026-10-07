# #20 `GET /api/emby/System/Info`（带 token 的完整服务器信息）

> 索引：[emby-compat.md「十、真机对照记录」](../emby-compat.md)


新客户端 **Filmly/2.12.11-439** 打的（日志 `✘ emby 未实现#1 GET /api/emby/System/Info [Filmly/2.12.11-439]`，落到 501）。此前 **VidHub 3.0.6** 登录后也打过（记录在「七」的现状表，它**容忍了** 501、照常往下走）。

**真机样本**（OkEmby / nyamedia / itsmygo 实测；予初Emby 多次重试**不可达**，待补测。地址 / MAC 已用占位符替代，见「十」的探针约定）

```json
// OkEmby   4.9.1.90（28 字段）
{"SystemUpdateLevel":"Release","OperatingSystemDisplayName":"Unix","HasPendingRestart":false,"IsShuttingDown":false,
 "HasImageEnhancers":false,"OperatingSystem":"Linux","SupportsLibraryMonitor":true,"SupportsLocalPortConfiguration":true,
 "SupportsWakeServer":false,"WebSocketPortNumber":8096,"CompletedInstallations":[],"CanSelfRestart":true,
 "CanSelfUpdate":false,"CanLaunchWebBrowser":false,"HttpServerPortNumber":8096,"SupportsHttps":true,"HttpsPortNumber":8920,
 "HasUpdateAvailable":true,"SupportsAutoRunAtStartup":false,"HardwareAccelerationRequiresPremiere":true,
 "WakeOnLanInfo":[{"MacAddress":"<mac>","BroadcastAddress":"<bcast>","Port":9}],"IsInMaintenanceMode":false,
 "LocalAddress":"<内网地址>","LocalAddresses":["<内网地址>"],"WanAddress":"<外网地址>","RemoteAddresses":["<外网地址>"],
 "ServerName":"OkEmby","Version":"4.9.1.90","Id":"…"}

// nyamedia 4.8.0.62（25 字段；= 上面减去 4 个字段，见判读）
{"SystemUpdateLevel":"Beta","OperatingSystemDisplayName":"Unix","HasPendingRestart":true,"IsShuttingDown":false,
 "OperatingSystem":"Linux","SupportsLibraryMonitor":true,"SupportsLocalPortConfiguration":true,
 "WebSocketPortNumber":8096,"CompletedInstallations":[],"CanSelfRestart":true,"CanSelfUpdate":false,
 "CanLaunchWebBrowser":false,"HttpServerPortNumber":8096,"SupportsHttps":true,"HttpsPortNumber":443,
 "HasUpdateAvailable":true,"SupportsAutoRunAtStartup":false,"HardwareAccelerationRequiresPremiere":true,
 "LocalAddress":"<内网地址>","LocalAddresses":["<内网地址>"],"WanAddress":"<外网地址>","RemoteAddresses":["<外网地址>"],
 "ServerName":"nyamedia","Version":"4.8.0.62","Id":"…"}

// itsmygo（仿 Emby，7 字段）
{"Id":"…","LocalAddress":"<地址>","OperatingSystem":"Linux","ProductName":"<自定义>",
 "ServerName":"<自定义>","StartupWizardCompleted":true,"Version":"<自定义版本>"}
```

**判读**

- 两台主流（**OkEmby 4.9 / nyamedia 4.8**）字段**同构**：nyamedia 只少 4 个 **4.9 新增**字段 —— `HasImageEnhancers` / `SupportsWakeServer` / `WakeOnLanInfo` / `IsInMaintenanceMode`。即**字段集随 Emby 版本演进**。
- itsmygo 是**极简仿制**（只 7 字段，`ProductName` / `StartupWizardCompleted` 是它自加的），非 Emby 惯例，**对齐多数时不作准**（同 #19 对 itsmygo 的口径）。
- 面板自称 `Version=4.8.0.0`，与 nyamedia(4.8) 同代 → **目标形状 = 4.8 的 25 字段**（按「对齐多数 + 版本匹配」，与 #19 / #18 的「对齐多数」一脉）。
- 该端点**带 token**（三台用有效 token 均 200；**免 token 行为未测**）；这里字段大多是**本项目没有的能力**（转码 / 本地媒体库路径 / 自更新 / 唤醒等），需要按「照实、不编造」逐项给诚实值 —— **这就是本条的核心取舍**。

**差异与处理**（口径：**诚实子集**，见 [ADR-0057](../adr/0057-emby-system-info-honest-subset.md)）

- **认领端点**：这是客户端要的、且"服务器自述信息"属面板该给的表面（界内，见 [ADR-0056](../adr/0056-emby-compat-scope.md)），故实现它、不再落 501。
- **字段只给面板真有的**（回 **17** 个，比真机 4.8 的 25 个少 8 个）：
  - 身份：`ServerName` / `Version`（`4.8.0.0`）/ `Id`（实例 serverId）。
  - 运行环境：`OperatingSystem`（面板运行所在 OS，按 Emby 写法给 `Linux` / `OSX` / `Windows` …）。
  - 地址：`LocalAddress`（请求 `Host` 去端口）/ `LocalAddresses:[]` / `RemoteAddresses:[]`（数组照握手 `System/Info/Public` 回空）。
  - 能力位**一律如实 `false`**（面板没有这些能力）：`HasPendingRestart` / `IsShuttingDown` / `SupportsLibraryMonitor` / `CanSelfRestart` / `CanSelfUpdate` / `CanLaunchWebBrowser` / `SupportsHttps` / `HasUpdateAvailable` / `SupportsAutoRunAtStartup`。
  - `CompletedInstallations:[]`。
- **不回**（面板无对应物，不编造数值）：`SystemUpdateLevel` / `OperatingSystemDisplayName` / `SupportsLocalPortConfiguration` / `WebSocketPortNumber` / `HttpServerPortNumber` / `HttpsPortNumber` / `HardwareAccelerationRequiresPremiere` / `WanAddress`。
- **鉴权**：与 `Studios`（#14）/ `Items/Counts`（#16）同口径 —— `authorize(req)` **只验 token、不比对 `UserId`**（服务器级信息、与具体用户无关）。无 / 无效 token → **401 纯文本**。**免 token 行为在真机上未测**，按读取类既定例外对齐「只验 token」。

**不能模拟**：转码 / 本地媒体库扫描 / 自更新 / 自重启 / Wake-on-LAN（本项目没有这些能力）—— 只能给 `false` / 空，不可能真做。

**状态：已落码（未复测）。** 予初Emby 因网络不可达**待补测**；鉴权的「免 token 行为」真机未测，按读取类既定例外对齐「只验 token」。
