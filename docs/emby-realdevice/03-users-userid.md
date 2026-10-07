# #3 `GET /api/emby/Users/{UserId}`（取用户资料）

> 索引：[emby-compat.md「十、真机对照记录」](../emby-compat.md)


**真机样本**（OkEmby 4.9.1.90，200）—— 返回 **UserDto 本体**（不包一层），与登录响应里的 `User` **逐字段完全一致**：

```json
{"Name":"…","ServerId":"…","Prefix":"D","DateCreated":"2026-05-12T14:26:01.4121026Z","Id":"…","PrimaryImageTag":"…","HasPassword":true,"HasConfiguredPassword":true,"LastLoginDate":"2026-10-05T15:08:03.7814616Z","LastActivityDate":"2026-10-05T15:08:08.2634278Z","Configuration":{…15 键…},"Policy":{…44 键…},"PrimaryImageAspectRatio":1}
```

**逐字段对照**（面板 `getUser` → `buildUser`，与登录共用同一组装函数）

| 字段 | 含义 / 客户端用途 | 真机 | 面板 | 处理 |
|---|---|---|---|---|
| `Name` | 用户名 | 有 | 有 | 一致 |
| `ServerId` | 服务器标识 | 有 | 有 | 一致 |
| `Prefix` | 用户名首字母（无头像时占位/排序） | 有 | 有 | 一致（#2 已补） |
| `DateCreated` | 账号创建时间，客户端"加入日期"展示 | 有 | 有 | 一致（#2 已补） |
| `Id` | 用户 Id | 有 | 有 | 一致 |
| `PrimaryImageTag` | 头像版本戳；有值客户端才去拉头像 | 有 | **有** | 已给（品牌图标内容 md5，与 `UserDto` 同源；**未复测**；见 #2 的 2-5） |
| `HasPassword` | 是否设了密码 | 有 | 有 | 一致 |
| `HasConfiguredPassword` | 是否配置过密码 | 有 | 有 | 一致 |
| `LastLoginDate` | 上次登录时间 | 有 | 有 | 一致 |
| `LastActivityDate` | 最后活动时间（真机每次请求刷新） | 有 | 有 | 一致 |
| `Configuration` | 用户偏好（15 键） | 有 | 有 | 一致（#2 已对齐） |
| `Policy` | 账号权限（44 键） | 有 | 有 | 一致（#2 已对齐） |
| `PrimaryImageAspectRatio` | 头像宽高比 | 有 | **有** | 已给（`1`，图标为正方形；**未复测**；见 #2 的 2-5） |

> **字段级差异**：本条与登录共用 `buildUser`，#2 对齐后字段自动一致（含接回的头像 2 键）。

**错误分支**

| 场景 | 含义 / 客户端用途 | 真机 | 面板 | 处理 |
|---|---|---|---|---|
| 无 token / token 无效 | 客户端收到 401 即回登录页 | **401 纯文本** `Access token is invalid or expired.` | **401 纯文本**（`authorize` 已改） | **已改**（未复测） |
| UserId 不存在 | 手动拼错 / 用户被删 | **404 纯文本** `找不到请求的用户。最近可能已从服务器中删除了。` | **404 纯文本**（`getUser` 已改） | **已改**（未复测） |
| 账号表为空 | 面板独有（真机是配置库，不存在空态） | — | 401 JSON `{error:'面板还没有 Emby 账号'}` | 保留（面板自造态） |

**不能模拟**：账号表为空时的 401 JSON（真机无此分支）。

**已按用户确认改（2 点）**：
- 3-1 **已改**：`service.authorize` 的 401 由 JSON 改为纯文本 `Access token is invalid or expired.`。`authorize` 是全部受保护端点共用的守卫，真机对任意端点都是这同一句；`routes.js` 新增 `sendResult(res, out)`（`out.text` 有则发 `text/plain`，否则发 JSON），13 处 `authorize` 拒绝发送点已全部改走它；`AuthenticateByName` 发送点也一并收敛到 `sendResult`。
- 3-2 **已改**：`service.getUser` 的 404 由 JSON 改为纯文本 `找不到请求的用户。最近可能已从服务器中删除了。`。

**遗留（本次未改，留待对到 #4+ 端点时一并处理）**：`service.assertUser`（供 Views / Items / Seasons / Episodes / PlaybackInfo / Stream / Download / Similar 等 9 处使用）的同类 404 目前**仍是 JSON** `{error:'用户不存在'}`，与真机不一致；本轮只改 `getUser` 自身这一条，避免一次牵动 9 个 service 函数。

**状态：未复测**（`node --check` 通过；本地直调 `service.authorize` → `401 text`、`service.getUser('nonexistent')` → `404 text` 均符合预期；面板端到端待批量复测）。
