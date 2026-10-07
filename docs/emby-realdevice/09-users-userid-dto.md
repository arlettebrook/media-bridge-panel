# #9 `GET /api/emby/Users/{UserId}`（取用户资料 / `UserDto` 本体）

> 索引：[emby-compat.md「十、真机对照记录」](../emby-compat.md)


**真机样本**（OkEmby 4.9.1.90；予初Emby 待补测）

- 登录同 #8（`POST /Users/AuthenticateByName`）；样本 UserId 见本机 `data/真机环境.md`。

**错误分支**

| 场景 | 含义 / 客户端用途 | 真机 | 面板 | 处理 |
|---|---|---|---|---|
| 无 token / 无效 token | 全局守卫，客户端回登录页 | **401 纯文本** `Access token is invalid or expired.` | 401 纯文本（`authorize`） | 一致 |
| 有效 token + **合法 Guid 但不存在的 UserId** | 真机按路径里的 UserId 解析用户 | **404 纯文本** `找不到请求的用户。最近可能已从服务器中删除了。` | **401 纯文本**（`authorize` 先比对 UserId 拦下） | **差异**（见下 9-1） |
| 有效 token + **非 Guid 格式的 UserId**（如 `WRONGID`） | 真机把 UserId 当 Guid 解析 | **500 纯文本** `Unrecognized Guid format.` | 401 纯文本 | **差异**（见下 9-1；不单独模拟） |
| 有效 token + **存在的别人的 UserId** | 客户端拿旧 / 别的 UserId 来取资料 | **推断 200**（真机按 Id 解析、token 只判「已登录」；**未验证** —— 服务器只有一个账号，无法取到第二人的 Id） | 401 纯文本 | **差异（涉跨账号可见性）**，见下 9-1 |

**`UserDto` 逐字段**（真机 vs 面板）

| 部分 | 真机 | 面板 | 含义 / 客户端用途 | 处理 |
|---|---|---|---|---|
| 顶层（13 键） | `Name`/`ServerId`/`Prefix`/`DateCreated`/`Id`/`PrimaryImageTag`/`HasPassword`/`HasConfiguredPassword`/`LastLoginDate`/`LastActivityDate`/`Configuration`/`Policy`/`PrimaryImageAspectRatio` | 同 13 键（`PrimaryImageTag`/`PrimaryImageAspectRatio` **随头像文件有无**） | 用户名 / 服务器 / 前缀 / 建号时间 / Id / 头像 + 比例 / 密码状态 / 登录与活跃时间 / 配置 / 权限策略 | 一致（无头像时真机同样省这两键） |
| `Configuration`（15 键） | 15 键（`PlayDefaultAudioTrack` … `EnableLocalPassword`） | 15 键，**逐键一致** | 播放 / 字幕 / 首页等偏好 | 一致 |
| `Policy`（44 键） | 44 键（`IsAdministrator` … `AllowSharingPersonalItems`） | 44 键，**逐键一致** | 权限策略（隐藏 / 转码 / 下载 / 频道 / 设备…） | 一致 |

**差异处理（能补的就补 + 回退原则）**

- 9-1 **UserId 校验 → 判定「维持现状」，不放开跨账号**：真机 `Users/{UserId}` **不是**「只验 token」的端点 —— 它**按路径里的 UserId 解析用户**（存在 → 200，合法 Guid 但不存在 → 404，非 Guid → 500），**与 token 属于谁无关**。**完全对齐 = 允许任一有效 token 读任意存在账号的资料**（`Name` / `Policy` / `Configuration`，**非媒体内容**），**属跨账号可见性**，故**不跟**（本条有意收紧：不跨账号）。口径与判据见 [ADR-0048](../adr/0048-emby-userid-not-identity.md)。
  - 面板维持：有效 token 但 `UserId` 与 token 不是同一人 → **401**（比真机更严）。**不影响正常客户端**：客户端只请求**自己**的 `UserId`（登录时由 `AuthenticateByName` 下发），不取别人的。
  - 不匹配回 **401 而非 404**：404 会**泄露某个 `UserId` 在不在**（账号枚举），401 不泄露。故真机「不存在 → 404」亦**不复刻**；「非 Guid → 500」同理不单独模拟。
  - 面板特有分支：**一个账号都没有时回 401**「面板还没有 Emby 账号」（真机服务器必有账号，无对应分支）。
- 9-2 **`UserDto` 字段结构 → 不改**：顶层 13 键、`Configuration` 15 键、`Policy` 44 键**逐键与真机一致**。头像两键（`PrimaryImageTag`/`PrimaryImageAspectRatio`）面板**按头像文件有无挂载**，与真机「无头像则省」同构，无需改。

**不能模拟**：真机 `Id` 是真实 Guid（面板 Id 是 `md5(serverId|账号名)` 派生）；「存在的别人的 UserId → 200」需服务器有第二账号才能实测（本条只有一台单账号样本）。

**状态：9-1 判定「维持现状」（不放开跨账号，见 ADR-0048，**未改代码**）；9-2 判定不改。本条无待办差异。** 予初Emby 待补测本条。
