# #1 `GET /api/emby/System/Info/Public`（握手）

> 索引：[emby-compat.md「十、真机对照记录」](../emby-compat.md)


**真机样本**（两台实测字段集一致）

```json
// OkEmby    4.9.1.90
{"LocalAddresses":[],"RemoteAddresses":[],"ServerName":"OkEmby","Version":"4.9.1.90","Id":"…"}
// 予初Emby   4.9.5.0
{"LocalAddresses":[],"RemoteAddresses":[],"ServerName":"予初Emby","Version":"4.9.5.0","Id":"…"}
```

**差异与处理**（方案 A：以真机样本为准）

| 字段 | 含义 / 客户端用途 | 真机 | 面板（改前） | 处理 |
|---|---|---|---|---|
| `LocalAddresses` | 局域网直连地址列表 | `[]` | 无 | **补空数组** |
| `RemoteAddresses` | 外网直连地址列表 | `[]` | 无 | **补空数组** |
| `ServerName` | 服务器显示名 | 服务器名 | 实例名（默认「媒体桥 Emby」） | 保留（各实例可配，非差异） |
| `Version` | 版本号，客户端做能力探测 | `4.9.x` | `4.8.0.0`（写死） | 保留（有意报 4.8 兼容；本次未改） |
| `Id` | 服务器唯一标识（须稳定） | 32 位 hex | 16 位 hex | 保留（不透明标识，客户端只当字符串；本次未改） |
| `LocalAddress` | 旧版单数内网地址 | 无 | `http://<Host>` | **删** |
| `ProductName` | 产品名，确认是 Emby | 无 | `Emby Server` | **删** |
| `OperatingSystem` | 服务器操作系统 | 无 | `darwin` | **删** |
| `StartupWizardCompleted` | 是否完成安装向导 | 无 | `true` | **删** |

**状态：未复测**（改动已落码，待批量复测后回填结果）。
**结论**：已按方案 A 修改（[service.js](../../server/modules/emby/service.js) 的 `publicInfo`）—— 补 `LocalAddresses` / `RemoteAddresses`（空数组），删 `LocalAddress` / `ProductName` / `OperatingSystem` / `StartupWizardCompleted`；返回字段集与真机样本一致（5 字段）。`Version` / `Id` 维持现状。
**不能模拟**：无。
**未决**：真机样本比原版 Emby 少了上述 4 个字段（疑似被裁剪的中转/桥），本条取舍即由此而来；若后续确认客户端依赖 `StartupWizardCompleted`，再回补并在此注明。
