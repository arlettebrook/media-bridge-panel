# ADR-0063 版本行标题位下沉到聚合层产出：emby 与出口插件读同一份

- 状态：已采纳
- 相关：[0043](0043-line-filter-at-aggregate-output.md)（同一模式的第一次应用，本文是第二次）、
  [0002](0002-in-process-emby-to-agg.md)、[0007](0007-emby-dto-shape.md)、[0008](0008-no-fabricated-data.md)

## 背景

Emby 版本行的**标题位**（`MediaSources[].Name` 与视频流 `DisplayTitle`）是
`[体积] 站点标签 · 线路flag [· 变体标注] [· 项标注]` 这个形状，拼装在 **emby 层** `buildMediaSource` 里
完成 —— 用站点名、线路 `flag`、变体 `label`、播放项的 `sizeBytes` / `width` / `height` 拼出。

出口插件（FW/Rex）也**要把同样的版本名显示出来**，但它们是**独立消费方**：走
`ctx.hostCall('agg','detail', …)` 拿聚合结果，再**自己另拼一份**版本名。于是同一条规则被实现了两遍，
口径迟早会漂（例如"多源要不要前置源名""电影多版本短标签怎么去重"这类细节各自为政）。

这正是 [ADR-0043](0043-line-filter-at-aggregate-output.md) 描述过的同一类问题：**规则在"消费方"各实现了
一遍，接一个客户端 / 出口插件就要再实现一次**。0043 把「线路过滤」落到了聚合层产出处，本条目把
「版本行标题位拼装」也落到同一处。

## 决定

1. **拼装落到产出上**：`aggregateDetail` 返回前调 `fillVersionLabels(out, pick, byId)`，给**每个可播目标**
   写一个 `x.versionLabel`（格式即原标题位：`[体积] 站点标签 · 线路flag [· 变体标注] [· 项标注]`）。
   代表条目 `site.detail` 与同片变体 `site.variants[].detail` **都写**；两条返回路径（快路径与正常路径）**都调**。
2. **消费方不再自己拼**：emby 层 `buildMediaSource` 改为**直接读** `t.versionLabel`，删掉本层的
   `sizeTag` / `itemSpecLabel` / `itemLabelsOf` 三个短标签函数（下沉后成了死代码），
   并**不留旧拼装兜底** —— 能进版本列表的目标都过了聚合层那一趟，字段必然有值。
3. **顺手补 `sourceName`**：详情站条目原先**不带 `sourceName`**（只有搜索条目带），导致"多源时前置源名"
   这一条**实际从未生效**。`fillVersionLabels` 从 `byId` 补齐它，规则才真正落地。
4. **快照 key 换"产出口径版本号"**（`'aggdetail4'` → `'aggdetail5'`）：产出内容口径变了
   （每个可播目标多了一个 `versionLabel`），不换 key 会一直命中旧快照。
5. **出口插件契约声明**：面板在聚合 `detail` 的可播目标上写 `versionLabel`，出口插件直接读
   （剧集 `line.target.versionLabel`、电影 `line.items[].versionLabel`），契约正文记在**插件仓库**
   [media-bridge-plugins](https://github.com/dlushu/media-bridge-plugins) `docs/plugin-contract.md`（本仓库不复制）。

## 理由

- **标题位是"聚合产出长什么样"的一部分，不是某个客户端的显示偏好** —— 在产出处拼一次，
  emby 与出口插件拿到的是同一份，"这条版本叫什么"只有一个实现。与 0043 同一条理由。
- **拼标题位所需的输入聚合层都有**：`sites[].name` / `line.flag` / `variants[].label` 与各 target 的
  `sizeBytes` / `width` / `height` 都在 `out` 里；`multiSource` 由 `out.sites` 的源数判定。下沉**不增加取数**。
- **不留旧拼装兜底**：产出已带 `versionLabel` 之后，emby 层的旧拼装**永远不成立**，是死代码 ——
  留着会让"规则改一份、另一份没改"的漂移重新出现（与 0043 否决"保留 emby 那处 `continue` 当双保险"同理）。
- **去重 `ensureUniqueSourceNames` 不下沉**：那是**列表级**的全局不撞名（同一屏内多版本标题互不相同），
  属 emby DTO 装配的事，不是"单个版本叫什么"，留在 emby 层。

## 备选

- **各消费方自己拼（原状）**：否决。规则实现两遍，口径漂移是时间问题。
- **保留 emby 旧拼装当兜底**（`t.versionLabel || 旧拼装`）：否决。产出必带 `versionLabel`，兜底是死代码，
  且会掩盖"下沉漏了某条路径"这类问题。
- **把 `ensureUniqueSourceNames` 一起下沉**：否决。它是列表级去重、依赖"这一屏列了哪些版本"，
  与"单个版本标题怎么拼"不是一回事；下沉会让聚合层输出依赖消费方的列表装配。
- **只下沉给出口插件、emby 层保持原样**：否决。那样规则仍有两份（emby 一份、聚合一份），
  与"规则只实现一次"相悖。

## 后果

- **emby 与出口插件（FW/Rex）的版本标题口径统一**：两边读同一个 `versionLabel`。
- **多源命中时标题多出源名前缀**（形如 `源名 站点标签 · 线路`）：这是补齐 `sourceName` 后**新生效**的行为，
  此前"多源前置源名"从未落地。属**对外可见文本变化**，已在 [emby-compat.md](../emby-compat.md) 的契约变更记录
  与 [CHANGELOG.md](../../CHANGELOG.md) 声明。单源场景标题不变。
- **出口插件可删掉自拼逻辑**：fwrex `widget-runtime.js` 改为优先读 `versionLabel`，老响应缺字段时退回自拼。
- **换 key 后第一次请求要重算**（一次性）；旧 key 下的快照按 TTL 自然淘汰。
- 后续若再要改"版本行标题怎么拼"，**只改 `agg/service.js` 的 `fillVersionLabels` 一处**，
  两端消费方自动跟上。
