# ADR-0061 缺值字段的表示：DateTime / 标量一律省略键，不写空串

- 状态：已采纳（细化 [0008](0008-no-fabricated-data.md) 的「不知道就空字段」）
- 相关：[0008](0008-no-fabricated-data.md)（不编数据）· [0007](0007-emby-dto-shape.md)（对齐真机 DTO 形状）·
  [emby-compat.md](../emby-compat.md) · [06-items-latest](../emby-realdevice/06-users-userid-items-latest.md) ·
  [service.js](../../server/modules/emby/service.js)（`baseItem`）

## 背景

[0008](0008-no-fabricated-data.md) 定了大方向「不知道就空字段，没有数据就如实回空」。落地时
`baseItem()` 把这条读成了「**兜底成空串**」：`PremiereDate: f.premiereDate || ''`、
`Overview: f.overview || ''` —— 插件没给首播日期时，条目上就出现 `"PremiereDate": ""`。

真机不给这个键。实测（Hills 1.9.1 客户端 + 双 HAR 对照）暴露了后果：客户端对该字段做
`DateTime.parse(value)`，`parse('')` 直接抛 `FormatException: Invalid date format`，
**整条响应解码失败** —— 一个空串就能让整个列表打不开。

“空字段”在本项目里其实是**两种**东西，之前没分清：

- **数组**：`Genres` / `People` / `ImageTags` 等，客户端解码器常声明成**非可选** —— 键缺失会让
  整条响应失败，所以必须**先铺 `[]`**（见 [service.js](../../server/modules/emby/service.js) 的注释，SenPlayer 实证）。
- **DateTime / 标量**：`PremiereDate` 之类，客户端会拿去做类型转换（`DateTime.parse`）——
  给空串等于给一个**解析不了的合法键**，比省略更糟。

## 决定

拿不到值的字段，按类型分别处理：

- **DateTime 类**（`PremiereDate` 等）：**拿不到就不给这个键**，**绝不写空串**。
- **标量字符串**（`Overview` 等）：**拿不到就不给键**（空简介对客户端无意义，省略即"没有"）。
- **数组类**：维持**先铺 `[]`**（[0007](0007-emby-dto-shape.md) 的既定口径，不动）。

落码：`baseItem()` 里删掉 `PremiereDate` / `Overview` 的空串兜底，改为
`if (f.premiereDate) item.PremiereDate = f.premiereDate;`（`Overview` 同款）——
与函数末尾 `DateCreated` / `DateModified` 的「拿不到就不给」完全一致。

## 理由

- **对齐真机**：真机拿不到就不含该键（JsonSerializer 省略 null），从不回空串。
- **消除崩溃**：空串是**非法 DateTime**，省略键则客户端走"字段缺失"路径，不触发解析。
- **统一口径**：与同函数 `DateCreated` / `DateModified`、与 [0008](0008-no-fabricated-data.md) 一致，
  不再有"有的字段省略、有的字段给空串"的分裂。

## 备选

- **给零值日期**（`0001-01-01T00:00:00.0000000Z`）：真机确实给这个零值且客户端能解析，但那是
  **有文件库的服务器**才有的语义；本项目没有文件，等于凭空造一个日期。且与 `DateCreated` 的
  "拿不到就不给"自相矛盾。否决。
- **维持空串、让客户端自己容错**：崩的是客户端、不是面板；但一个空串能崩掉整个列表，
  代价与收益完全不成比例。否决。

## 后果

- **`PremiereDate` / `Overview` 由"恒在（可能为空串）"变为"可能缺失"**：只关心字段存在的客户端
  不受影响，对空串做类型转换的客户端不再崩。
- **`Etag` 不变**：哈希里含 `item.Overview` / `item.PremiereDate`，但 `Array.join` 对
  `undefined` 与 `''` 同化 → 哈希值不变，**无缓存键抖动**。
- **详情路径自然一致**：`applyRich` 本就是 `if (got.overview) item.Overview = got.overview;`，
  与本次口径同款，无需改动。
- 逐条契约与真机登记见 [emby-compat.md](../emby-compat.md)「契约变更记录」与
  [06-items-latest](../emby-realdevice/06-users-userid-items-latest.md)。
