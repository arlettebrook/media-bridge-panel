# #2 `POST /api/emby/Users/AuthenticateByName`（登录）

> 索引：[emby-compat.md「十、真机对照记录」](../emby-compat.md)


**真机样本**（OkEmby 4.9.1.90，200 成功体，节选关键结构）

```jsonc
{
  "User": {
    "Name": "…", "ServerId": "…", "Prefix": "d", "Id": "…",
    "HasPassword": true, "HasConfiguredPassword": true,
    "HasConfiguredEasyPassword": false, "EnableAutoLogin": false,
    "LastLoginDate": "…", "LastActivityDate": "…",
    "PrimaryImageTag": "…", "PrimaryImageAspectRatio": 1,
    "DateCreated": "…",
    "Configuration": { /* 含 SubtitleMode:"Smart"、HidePlayedInMoreLikeThis、HidePlayedInSuggestions、ResumeRewindSeconds、IntroSkipMode 等 */ },
    "Policy": { /* 44 键：IsAdministrator:false、IsHidden:true、EnableContentDownloading:false、EnableAudioPlaybackTranscoding:false、EnableVideoPlaybackTranscoding:false、EnablePlaybackRemuxing:false … */ }
  },
  "SessionInfo": { /* 20 键：含 PlayState/AdditionalUsers/RemoteEndPoint/Protocol/PlayableMediaTypes/PlaylistIndex/PlaylistLength/ServerId/UserPrimaryImageTag/InternalDeviceId/SupportedCommands/SupportsRemoteControl … */ },
  "AccessToken": "…",
  "ServerId": "…"
}
```

**登录失败 / 缺头**

```text
// 密码错：401，Body 为纯文本
无效用户名或密码。请重试。
// 缺 X-Emby-Authorization：400，Body 为纯文本
Value cannot be null. (Parameter 'appName')
```

**请求体字段名（大小写不敏感）**

| 字段 | 含义 / 客户端用途 | 真机 | 面板 | 处理 |
|---|---|---|---|---|
| `Username` / `Pw` | 登录账号与密码，客户端按自身拼写发（Rex 发 `Username`/`Pw`；**HamHub Android `1.0.17+29` 发全小写 `username`/`pw`**） | **大小写都认**（实测 OkEmby / itsmygo：同一口令发 `Pw` 与 `pw` 均 **200** 登录成功） | 曾**只认固定拼写**（`Username`/`username`、`Pw`/`Password`/`password`）→ 收到 `pw` 取到空密码 → 401；现 **不区分大小写** | **已改**（`pickBodyField` 大小写不敏感取值；**已实测**） |

**授权头（appName 来源）**

| 头 | 含义 / 客户端用途 | 真机 | 面板 | 处理 |
|---|---|---|---|---|
| `X-Emby-Authorization` / `Authorization` | 客户端在此声明 `Client="…"`（即 appName），真机据此识别客户端；两个头**任一**都行 | **两头都认**（实测 OkEmby / nyamedia / 予初Emby：只发任一 → **200** 登录成功；**两头都不发 → 400** `Value cannot be null. (Parameter 'appName')`，**登不上** —— 但**不含 `Client=` 时见下节，真机会去 query 找**） | 曾**只读** `x-emby-authorization` → 客户端把 appName 发在 `Authorization`（官方文档口径）时被误判「缺 appName」→ 400；现**两头都读** | **已改**（`x-emby-authorization` 缺失时回退 `authorization`；**已实测**） |

**appName 的第三种来源：query `X-Emby-Client`（Filmly / 网易爆米花）**

抓包（`hh.dlushu.dpdns.org`，Filmly/2.12.11-439 发往面板）：授权头**没有 `Client=`**，客户端名放在 **query** 里：

```http
POST /emby/Users/AuthenticateByName?X-Emby-Client=%E7%BD%91%E6%98%93%E7%88%86%E7%B1%B3%E8%8A%B1%20Android
X-Emby-Authorization: Emby Device="PLC110", DeviceId="58558ce063a423b0", Version="2.12.11"
User-Agent: Filmly/2.12.11-439
{"Username":"emby","Pw":"123456"}
```

`X-Emby-Client` 解码即 `网易爆米花 Android`。真机对**同一形状**的请求实测（nyamedia 4.8.0.62，脚本复刻）：

| 请求形状 | 真机 | 面板 |
|---|---|---|
| 头**无** `Client=` + query 带 `X-Emby-Client`（复刻 Filmly） | **200** 登录成功 | **400** `Value cannot be null. (Parameter 'appName')` |
| 头无 `Client=` + 无 query | 400 同上 | 400 |
| 头有 `Client=`（对照） | 200 | 200 |

→ 真机取 appName 的顺序是「头里 `Client=` **没有就去 query 找 `X-Emby-Client`**」；面板只看头、不读 query，故 Filmly 在真机能登、在面板被判 400。**这是 Filmly 登不上的真正原因**（与引号无关）。
**面板处理：已改**（`authenticate` 在头里取不到 `Client=` 时回退读 query `X-Emby-Client`；**已实测真机口径**，Filmly 侧**未复测**）。

**授权头值格式（引号 / 前缀）**

| 写法 | 真机 | 面板 | 处理 |
|---|---|---|---|
| `Emby Client="Filmly", …`（带前缀 + 引号） | **200**（标准写法） | 认 | — |
| `Emby Client=Filmly, …`（带前缀、**省引号**） | **200**（实测 nyamedia 4.8.0.62） | 曾**只认带引号** → 取不到 appName → 400 | **已改**（引号可选；`pickHeaderValue`） |
| `Client=Filmly, …`（**缺 `Emby `/`MediaBrowser ` 前缀**） | **400** `Value cannot be null. (Parameter 'appName')` | 认（面板不校验前缀） | 保留（面板更宽、不收紧，避免误伤在用客户端） |
| 空值 / 仅 UA（无 appName） | **400** 同上 | 400 | 一致 |

> 真机：**引号可选**、**值需以 `Emby ` / `MediaBrowser ` 开头**；面板原先**要引号、不要前缀**，方向相反 —— 不带引号的客户端在真机能登、在面板被误判 400。本次按「引号可选」对齐（前缀仍不校验）。
> 同一口径还放宽了从授权头取 `Token=`（`tokenFrom`）：不写引号也认（该路径服务的是后续受保护端点，非登录本身）。

**差异与处理**（每字段含「含义 / 客户端用途」）

顶层结构

| 字段 | 含义 / 客户端用途 | 真机 | 面板 | 处理 |
|---|---|---|---|---|
| `User` | 登录用户对象（UserDto），客户端缓存的"当前登录身份" | 有 | 有 | 一致，保留 |
| `SessionInfo` | 本次会话对象，客户端登记自身会话/遥控能力 | 有（20 键） | 有（8 键）→ **20 键** | **已改**（补全至真机 20 键，见下 2-1；**未复测**） |
| `AccessToken` | 后续请求的会话凭据 | 32 hex | 32 hex | 一致，保留 |
| `ServerId` | 服务器唯一标识 | 32 hex | 16 hex | 保留（与 #1 同源，不透明标识） |

`User`（UserDto）字段

| 字段 | 含义 / 客户端用途 | 真机 | 面板 | 处理 |
|---|---|---|---|---|
| `Prefix` | 用户名首字母，用于无头像时的占位/排序 | 有（`D`） | 缺 → **有** | **已补**（`prefixOf`，首字母大写；**未复测**） |
| `DateCreated` | 账号创建时间，客户端"加入日期"展示 | 有 | 缺 → **有** | **已补**（取账号 `created_at`，缺省 now；**未复测**） |
| `PrimaryImageTag` | 头像图片版本戳；**有值客户端才会去拉** `/Users/{id}/Images/Primary` | 有 | 曾补（`cpyav.<userId>`）→ 撤 → **已换品牌图标 tag 接回** | **已给**（= `assets/default-avatar.png` 内容 md5，32 位 hex；**未复测**；见下 2-5） |
| `PrimaryImageAspectRatio` | 头像宽高比，客户端排版占位用 | 有 | 曾补（`1`）→ 撤 → **已接回** | **已给**（`1`，图标为正方形；**未复测**；见 2-5） |
| `HasConfiguredEasyPassword` | 是否设置过"简易密码/PIN" | 无 | 有（`false`） | **已删**（真机无此键） |
| `EnableAutoLogin` | 是否允许客户端免密自动登录 | 无 | 有（`false`） | **已删**（真机无此键） |

`User.Configuration` 字段

| 字段 | 含义 / 客户端用途 | 真机 | 面板 | 处理 |
|---|---|---|---|---|
| `SubtitleMode` | 字幕默认模式（Smart=智能选轨） | `Smart` | `Default` → `Smart` | **已改**（对齐真机；**未复测**） |
| `HidePlayedInMoreLikeThis` | "更多同类"里隐藏已看 | 有 | 缺 → **有** | **已补**（**未复测**） |
| `HidePlayedInSuggestions` | "推荐"里隐藏已看 | 有 | 缺 → **有** | **已补**（**未复测**） |
| `ResumeRewindSeconds` | 「继续播放」回退秒数 | 有 | 缺 → **有** | **已补**（`0`；**未复测**） |
| `IntroSkipMode` | 片头跳过模式 | 有 | 缺 → **有** | **已补**（`ShowButton`；**未复测**） |
| `SubtitleLanguagePreference` | 首选字幕语言 | 无 | 有 | **已删**（真机无） |
| `GroupedFolders` | 文件夹分组展示开关 | 无 | 有 | **已删**（真机无） |
| `DisplayCollectionsView` | 是否显示"合集"视图 | 无 | 有 | **已删**（真机无） |

`User.Policy` 字段（账号权限，客户端据此开关按钮/提示）

| 字段 | 含义 / 客户端用途 | 真机 | 面板 | 处理 |
|---|---|---|---|---|
| （整组） | 共 **44 键**权限位（下载/转码/LiveTV/码率上限/内容分级等） | 44 键 | 13 键 → **44 键** | **已补**（补全至真机 44 键，见下 2-2；**未复测**） |
| `IsAdministrator` | 是否管理员（决定能否进管理页） | `false` | `true` → `false` | **已改**（对齐真机；**未复测**） |
| `IsHidden` | 是否在登录页隐藏该用户 | `true` | `false` → `true` | **已改**（对齐真机；**未复测**） |
| `EnableContentDownloading` | 允许下载 | `false` | `true` → `false` → **跟随实例「下载」开关（默认开）** | **已改**（先对齐真机为 `false`；后由 #10-3 改为跟随实例开关、默认开，见 [ADR-0049](../adr/0049-emby-instance-download-switch.md)；**未复测**） |
| `EnableAudioPlaybackTranscoding` | 允许音频转码 | `false` | `true` → `false` | **已改**（对齐真机；**未复测**） |
| `EnableVideoPlaybackTranscoding` | 允许视频转码 | `false` | `true` → `false` | **已改**（对齐真机；**未复测**） |
| `EnablePlaybackRemuxing` | 允许播放重封装（remux） | `false` | `true` → `false` | **已改**（对齐真机；**未复测**） |

`SessionInfo` 字段（会话对象）

| 字段 | 含义 / 客户端用途 | 真机 | 面板 | 处理 |
|---|---|---|---|---|
| `PlayState` | 当前播放态（位置/是否暂停等） | 有 | 缺 → **有** | **已补**（见下 2-1；**未复测**） |
| `AdditionalUsers` | 同会话附加用户 | 有 | 缺 → **有** | **已补**（`[]`；**未复测**） |
| `RemoteEndPoint` | 客户端来源 IP | 有 | 缺 → **有** | **已补**（取 `X-Forwarded-For` 首段，回落 socket 地址；**未复测**） |
| `Protocol` | 连接协议（Http/Https） | 有 | 缺 → **有** | **已补**（`HTTP/<req.httpVersion>`；**未复测**） |
| `PlayableMediaTypes` | 本会话可播媒体类型 | 有 | 缺 → **有** | **已补**（`[]`；**未复测**） |
| `PlaylistIndex` / `PlaylistLength` | 播放列表进度 | 有 | 缺 → **有** | **已补**（`0`/`0`；**未复测**） |
| `ServerId` | 服务器标识（会话内冗余） | 有 | 缺 → **有** | **已补**；**未复测** |
| `UserPrimaryImageTag` | 用户头像版本戳（会话内冗余） | 有 | 曾补（`cpyav.<userId>`）→ 撤 → **已接回** | **已给**（= 品牌图标内容 md5，与 UserDto.PrimaryImageTag 同源；**未复测**；见 2-5） |
| `InternalDeviceId` | 内部设备记录 id | 有 | 缺 → **有** | **已补**（`md5(DeviceId)` 前 4 字节取模 1000000；**未复测**） |
| `SupportedCommands` | 支持的遥控指令集 | 有 | 缺 → **有** | **已补**（`[]`；**未复测**） |
| `SupportsRemoteControl` | 是否支持被遥控 | 有 | 缺 → **有** | **已补**（`false`；**未复测**） |
| `Id` / `UserId` / `UserName` / `Client` / `DeviceName` / `DeviceId` / `ApplicationVersion` / `LastActivityDate` | 会话基础字段 | 有 | 有 | 一致，保留 |

错误分支

| 场景 | 含义 / 客户端用途 | 真机 | 面板 | 处理 |
|---|---|---|---|---|
| 密码错 | 客户端读 Body 弹提示 | **401 纯文本** `无效用户名或密码。请重试。` | **401 JSON** → **401 纯文本** | **已改**（对齐真机文案；**未复测**） |
| 无账号 | 面板独有（真机是配置库，无此态） | — | 401 JSON `面板还没有 Emby 账号…` | 保留（面板自用，可模拟不了） |
| 缺 appName 头（`X-Emby-Authorization` 与 `Authorization` 都缺） | 真机据此取 appName，缺则报错 | **400 纯文本** | 容错放行 → **400 纯文本** | **已改**（`Value cannot be null. (Parameter 'appName')`；**未复测**） |

**状态：未复测**（改动已全部落码，待批量复测后回填结果）。
**例外（已实测）**：请求体字段名**大小写不敏感**、**appName 可来自 `Authorization` 头**、**授权头值引号可选**、**appName 可来自 query `X-Emby-Client`** 四项已对真机实测 —— OkEmby / itsmygo / nyamedia / 予初Emby 四台验证（细节见上方各表）。
**不能模拟**：无账号时的 401 JSON 属面板自造态，真机不存在此分支（不影响真实客户端）。
**已按用户确认改（5 点，全部取推荐项）**：
- 2-1 `SessionInfo` 补齐至真机 **20 键**（含 `PlayState`/`SupportedCommands`/`SupportsRemoteControl` 等）
- 2-2 `Policy` 补全至真机 **44 键**，`IsAdministrator`→`false`、`IsHidden`→`true`、转码/remux→`false`（`EnableContentDownloading` 后由 #10-3 改为**跟随实例「下载」开关、默认开**）
- 2-3 `Configuration` 补 4 键、删 3 键、`SubtitleMode`→`Smart`
- 2-4 登录失败改 **401 纯文本**、缺头改 **400 纯文本**
- 2-5 `User` 补 `Prefix`/`DateCreated`；头像相关（`PrimaryImageTag`/`PrimaryImageAspectRatio` + `Users/{UserId}/Images/{type}` 端点）走过一段弯路：曾随 1.8.3 用**按 userId 派生的纯色 PNG** 补上 → 自动生成的纯色头像不要，先撤掉（整套 PNG 生成代码留 git 61b3d0d）→ 品牌图标**已接回**：所有用户共用 `assets/default-avatar.png`（606×606 透明底），两个 tag 都补上（`PrimaryImageTag` = **文件内容 md5**，形状与真机 32 位 hex 一致，换文件即失效缓存），端点回 **200 `image/png`**（文件缺失才 404）。**未复测**
