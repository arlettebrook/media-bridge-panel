# ADR-0043 线路过滤下沉到聚合层产出处：客户端拿到的就是滤过的那份

- 状态：已采纳
- 相关：[0025](0025-line-filter-in-usable-judgement.md)（本文是它「谁来滤」那一节的落地）、
  [0033](0033-template-and-domain.md)（规则是模板的一部分）、
  [0002](0002-in-process-emby-to-agg.md)、[0006](0006-redirect-for-playback.md)

## 背景

[ADR-0025](0025-line-filter-in-usable-judgement.md) 把线路过滤接进了**聚合层"这条详情对客户端有没有用"的判据**
（`detailUsable` 带上 `re`）—— 但它只解决了"**账**"（决定补打收不收手、快照存不存），
**产出没滤**：`aggregateDetail` 返回的 `detail.lines` 仍是**全量**。于是规则被消费方各实现一遍：

- **emby 层**在自己拼版本列表时又滤了一遍（`emby/service.js` 里的
  `if (filter.re && !filter.re.test(line.flag)) continue;`），并**经 `agg/api.js` 转发**去读规则
  （`emby/service.js` 的 `lineFilter()` = 一行 `return agg.lineFilter()`）；
- **出口插件**（FW/Rex）走 `POST /api/agg/detail` 拿到的却是**没滤过的** `lines` →
  规则对它们**形同虚设**。实测：模板配了 `夸克原画|^夸克$|百度原画`，出口插件拿到的版本
  却"什么线路都有"（22 条），而 Emby 那边是对的。

根因不是"规则没生效"，是**规则在"消费方"各实现了一遍**：接一个客户端就要再实现一次口径，
同一份模板在不同客户端会有两种结果 —— 出口插件这条路已经漏了。

## 决定

1. **过滤落到产出上**：`aggregateDetail` 返回前调 `applyLineFilter(out, lf)`，把规则不匹配的线路
   直接从 `detail.lines` 里去掉（**代表条目 `site.detail` 与同片变体 `site.variants[].detail` 都要滤**）。
   两条返回路径 —— 快路径（`source+site+vodId`）与正常路径 —— **都做**。
2. **账记进 `out.stats.lineFilter = { raw, invalid, before, kept }`**（过滤前后条数），
   日志与 emby 的诊断字段都读它。
3. **消费方不再自己滤**：emby 层删掉那处 `continue` 与它的 `lineFilter()` 包装，改为**只读** `lfStat`
   写日志 / 诊断字段；`agg/api.js` 删掉转发口（`lineFilter` 不再对外导出）。
4. **快照 key 换"产出口径版本号"**（`'aggdetail'` → `'aggdetail2'`）：产出内容口径变了
   （旧快照按"全量 lines"算的），不换 key 会一直命中旧快照，看起来像"改完没生效"。

## 理由

- **规则属于模板（配置数据），线路是聚合层产出的东西** —— 在产出处滤一次，emby 与出口插件
  拿到的是同一份，"模板配什么就列什么"只有一个实现（见 develop.md 的
  「能力的设计不参照已有插件角色」：面板能力要对**任何**客户端 / 出口插件都成立）。
- **保留 ADR-0025 的判据用途不变**：`detailUsable(d, need, re)` 仍在"账"上判 ——
  它算的是"过滤后还能不能列出至少一条"，这一步跑在**产出过滤之前**（那时 `lines` 还是全量），
  所以它必须自己带 `re`。产出过滤只是把同一套规则**再落到实际返回的数据上**。
- **语义不扩**：只影响"列出来的版本"，不影响播放（`resolveStream` 按版本 Id 回查，不查这个列表）。

## 备选

- **各客户端自己滤（原状）**：否决。接一个客户端就再实现一次口径，事实是出口插件那条路已经漏了。
- **在打分期滤（搜到条目就按线路筛）**：做不到 —— 打分期只有搜索结果的元信息，
  **看不到线路名**（线路名只在 `/detail` 响应里）。与 ADR-0025 同一否决。
- **把规则交给源插件（源侧滤）**：否决。规则是**模板**的配置，源不认识模板；多源下每个源
  都要知道规则，等于把面板的配置泄漏到插件。
- **保留 emby 那处 `continue` 当"双保险"**：否决。产出已滤之后它**永远不成立**，
  是死代码 —— 留着会误导后来者"过滤还在那里"。

## 后果

- **emby 与出口插件（FW/Rex）的版本列表口径统一**：模板配什么就列什么。
- `stats.lineFilter` 成为那笔账的**唯一来源**；emby 的诊断字段
  `CatpawSource.LineFilter = { Pattern, Total(过滤前), Kept(列出), Invalid }` 与日志
  `线路过滤(/…/)(规则非法，已忽略)（聚合层已滤）：源里 N 条 → 到手 M 条` 都读它。
- **换 key 后第一次请求要重算**（一次性）；旧 key 下的快照按 TTL 自然淘汰。
- ADR-0025 的**决定 1**（"emby 层经 `agg/api.js` 转发"）由本条目**局部取代**，
  其余（判据、进 key、补打口径）仍然有效。