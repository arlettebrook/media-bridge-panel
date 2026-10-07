# ADR-0048 Emby 端点鉴权口径：token 是身份，`UserId` 只是参数

- 状态：已采纳
- 相关：[0007](0007-emby-dto-shape.md)（DTO 形状按真机对齐）· [0008](0008-no-fabricated-data.md)（不编数据）·
  [0009](0009-unauthenticated-empty-responses.md)（回空的端点不校验账号）·
  [emby-compat.md](../emby-compat.md)（契约变更记录）·
  [emby-realdevice/](../emby-realdevice/)（真机对照 #4–#9）·
  [service.js](../../server/modules/emby/service.js)（`authorize` / `accountIdFor` / `getUser`）

## 背景

Emby 客户端请求里普遍带 `UserId`（在路径或 query），但它与 `AccessToken` 是并列出现的：
客户端有时只发 token、有时两个都发。真机对照（OkEmby 4.9.1.90，见 [emby-realdevice/](../emby-realdevice/) #4–#9）实测：

- **读取类**端点（`Views` / `Items` / `Items/Latest` / `Shows/*/Seasons` / `Shows/*/Episodes`）**不校验 `UserId`**：
  有效 token + 不存在 / 不匹配的 `UserId` 仍回 200，用户私有数据按 token 解出的账号算。
- **用户资料**端点 `Users/{UserId}` **反过来**：按路径里的 `UserId` 解析用户（存在 → 200、合法 Guid 但不存在 → 404、
  非 Guid → 500），**与 token 属于谁无关**。

即 `UserId` 在这两类端点上的角色不同 —— 前者是"可有可无的参数"，后者是"要解析的对象"。

## 决定

**`AccessToken` 是唯一的身份来源；`UserId` 只是参数，不是身份。**

- **读取类端点只验 token、不比对 `UserId`**（#4–#8 起对齐真机）：带了 `UserId` 也不要求它属于该 token 账号。
- **用户私有数据一律按 token 解出的账号算**（`accountIdFor`：token 优先，`UserId` 仅在 token 认不出时兜底）。
- **`Users/{UserId}` 保持账号校验，不放开跨账号可见性**：有效 token 但 `UserId` 与 token 不是同一人 → **401**
  （面板比真机更严）。真机此处是"按 Id 解析、可读任意存在账号的资料"，面板**不跟**。

## 理由

- 读取类端点里 `UserId` 只是客户端顺手带上的"当前账号是谁"提示，token 已经能唯一确定账号；照真机不看它，
  客户端换了 / 过期了 `UserId` 也不会被误伤（此前一律 401 会让客户端白吃错误）。
- `Users/{UserId}` 若照真机放开，等于**任一有效 token 可读任意存在账号的资料**（`Name` / `Policy` / `Configuration`）——
  属跨账号可见性。客户端正常只取**自己**的 `UserId`（登录时由 `AuthenticateByName` 下发），不取别人的，
  所以收紧**不影响任何正常客户端**。
- 不匹配时回 **401** 而非 404：404 会**泄露某个 `UserId` 在不在**（账号枚举），401 不泄露。

## 备选方案

- **`Users/{UserId}` 也照真机放开（去掉 UserId 比对）**：行为最贴合真机，但引入跨账号可见性，**否决**。
- **不匹配回 404（贴合真机的"不存在 → 404"）**：会泄露账号是否存在，**否决**，维持 401。
- **所有端点统一只验 token、完全不看 `UserId`**：读取类已是此口径；但用户资料端点按 `UserId` 解析是它的语义，
  统一掉会让"不存在的用户"无从表达，**否决**。

## 后果

- 新增端点时必须先判定：`UserId` 在这条端点上**是参数还是待解析对象**；只有前者才走"只验 token"。
- 客户端若拿过期 / 别人的 `UserId` 请求 `Users/{UserId}`，会吃 401 而非真机的 404 —— 属**有意的收紧**；
  客户端正常流程不触发（只请求自己的 `UserId`）。
- 真机 `Users/{UserId}` 可跨账号读取属**已知差异**，登记在
  [emby-realdevice/09-users-userid-dto.md](../emby-realdevice/09-users-userid-dto.md)，**不复刻**。
