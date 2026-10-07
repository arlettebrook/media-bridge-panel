# ADR-0049 Emby 实例级「下载」开关：默认开的产品能力

- 状态：已采纳
- 相关：[0006](0006-redirect-for-playback.md)（播放 302）· [0007](0007-emby-dto-shape.md)（DTO 按真机对齐）·
  [0008](0008-no-fabricated-data.md)（不编数据）· [0048](0048-emby-userid-not-identity.md)（鉴权口径）·
  [emby-compat.md](../emby-compat.md)（契约变更记录）·
  [emby-realdevice/10-items-itemid-detail.md](../emby-realdevice/10-items-itemid-detail.md)（真机对照 #10）·
  [instance.js](../../server/modules/emby/instance.js)（`allowDownload`）·
  [service.js](../../server/modules/emby/service.js)（`allowDownload` / `baseItem` / `buildUser`）

## 背景

Emby 客户端判断"能否下载"看**三处**，且必须一致：握手 `Policy.EnableContentDownloading`、
条目 `CanDownload`、以及真正下载字节的 `Items/{ItemId}/Download` 端点。

真机对照（见 [emby-realdevice/10-items-itemid-detail.md](../emby-realdevice/10-items-itemid-detail.md)）实测三台样本的 `EnableContentDownloading`
与 `CanDownload` **同为 `false`**。面板此前两处**自相矛盾**：`#9` 把 policy 对齐成 `false`，条目
`baseItem()` 却仍给 `CanDownload: true`（注释还写着「与 policy 对齐（true）」，已过期），而下载端点恒放行。

下载是**产品能力**（部署者是否愿意让客户端把内容拉走），不是协议的固定形状。三处取值应随部署者意愿
统一开关，而不是绑死某个真机样本的配置。

## 决定

**新增 Emby 实例级「下载」开关，默认开；它驱动"能否下载"的三处同一口径。**

- 存储：`instances.json` 的 `allowDownload`（与 `enabled` 同类的实例布尔字段）；**字段缺席 = 开**，
  老实例升级后行为不变。
- 取值：`service.allowDownload()` 一处读当前实例，供握手 `Policy.EnableContentDownloading`、
  条目 `CanDownload`、下载端点门禁共用。
- 关掉时：policy 回 `false`、条目 `CanDownload: false`、`Items/{ItemId}/Download` 回
  **403 纯文本** `Downloading is disabled on this server.`。
- 面板「Emby → 实例」编辑弹窗提供勾选项（默认勾选）。

## 理由

- **三处一致是硬要求**：任一处不一致，客户端要么"照 policy 去试、又按条目不提供下载入口"，要么
  "显示入口却被端点拒绝"。三处同源一处取值，杜绝再次漂移（#10 之前正是漂移状态）。
- **默认开 = 零行为变更**：开关关闭是部署者的**显式动作**；默认值保持既有"能下载"的行为，客户端与
  升级路径都不受影响。
- **下载与否是部署粒度**：同一台面板上不同实例面向不同人群，下载意愿可能不同 —— 放实例级，与
  `enabled` / `homePlugin` / `metaDomains` 同一层，语义自然。
- **偏离真机样本属有意**：真机样本的 `false` 是**那台服务器的配置**，不是协议形状；把配置固化成常量
  才是失真。故本条不按"对齐真机"走，而是把真机里可配的那一项还原成可配。

## 备选方案

- **照真机样本写死 `false`（三处一起 false）**：最贴合样本，但等于永久禁掉已实现且有客户端需求的下载
  能力（`Items/{ItemId}/Download` 白做），**否决**。
- **写死 `true`（三处一起 true）**：保留下载能力，但部署者无从关闭，且与样本相左又不可解释，**否决**。
- **放到面板级（全局一个开关）**：无法区分实例，与"每实例一套账号/库/端口"的多实例模型不匹配，**否决**。

## 后果

- 新增"三处一致"的维护点：凡改动 `EnableContentDownloading` / `CanDownload` / 下载端点的任一处，
  必须同步另两处，取值统一走 `service.allowDownload()`。
- 与真机样本存在**已知差异**（默认开后 policy 与 `CanDownload` 回 `true`），登记在
  [emby-realdevice/10-items-itemid-detail.md](../emby-realdevice/10-items-itemid-detail.md) 的 10-3，
  **不复刻样本、不视为缺陷**。
- 下载端点在开关关闭时新增 **403** 分支（此前只有 401 与 302）；契约变更已记入 emby-compat.md。
