# ADR-0046 插件多类型：一个包一个 id，types 平级

- 状态：已采纳（已实现；数据迁移见 ADR-0047）
- 相关：[0028](0028-plugin-system.md)（插件宿主与目录布局）、0029（webui 按类型挂栏）、0035（插件不随面板发行）

## 背景

契约里插件身份是 `(type, id)`，`type ∈ metadata/source/home/output` 单值，目录按类型分层：

```
data/plugins/<type>/<id>/        包本体
data/plugins/<type>/<id>/data/  插件数据
```

这让"同一个包同时提供两类能力"无法表达：装两次就是两个目录、两个进程、两份数据（实例清单/缓存/Cookie 各一份，常驻端口还会互抢），只装一个类型另一类能力整个消失。

实测现状里还有另一面：`missav` 这个 id 在 `home/`、`metadata/`、`source/` 下各有一个**完全不同的包**（入口 md5 互不相同），旧模型下合法共存。新模型必须同时容纳"一包多类型"与"三包同 id"两件事——后者属于旧契约产物，由迁移任务处置（见 0047），不进入新模型的长期语义。

## 决定

### 1. 身份与目录：id 全局唯一，类型层从目录里消失

```
data/plugins/<id>/        包本体
data/plugins/<id>/data/  唯一数据目录
```

- 一个包 = 一个 id（全局唯一）= 一个目录 = **一个常驻子进程** = 一个 `enabled` 开关 = 一份数据。
- 类型是包的**平级能力集合** `types: string[]`，没有主类型、没有兼任主次。
- 清单（plugin.json）：多类型包写 `"types": ["source", "home"]`；旧包的单值 `"type": "source"` 继续接受，等价于 `"types": ["source"]`。
- `types` 必须是 TYPES 子集、去重、非空；**types 含 metadata 时 `domain` 必填，且 domain 全局唯一**（安装期拦截重复）；一个包最多注册一个 metadata 域。
- 安装期同时拦截：同 id 已存在且新包 types 与已装包 types 有交集 = 身份冲突，拒绝（由更新流程而非并列安装处理）。

### 2. 路由里的 :type 只是角色参数

`/api/plugins/:type/:id/...` 形状不变，但语义变为：校验 `:type ∈ 该包 types`，然后**按 id 定位唯一的包、目录、进程**。`(type,id) → 物理记录` 的解析收敛到 store 一处。ingress 公共/token 名单是**包级**的，按 id 查，同样先校验角色合法。

### 3. 动作分发：IPC 消息带 role

metadata 与 source 都有 `search` 动作，扁平 action 表会撞名。因此：

- 单类型包：入口照旧扁平导出 `actions: { sites, search, ... }`，消息形状不变。
- 多类型包：按角色分组 `actions: { source: { sites, search, ... }, home: { rows, run } }`；宿主调用消息带 `role: { id, role, action, args }`，runner 走 `actions[role][action]`，找不到回 `NO_ACTION`。
- 宿主侧 `host.call(type, id, action, args)` 签名不变（type 就是 role），内部按 id 找进程并带上 role；消费层（agg / emby / home）调用点零改。
- `states()` 对每个包按 types **展开成多行**（每行带同样的运行态），现有 `states().filter(x => x.type === ...)` 全部零改。
- runner 注入：`ctx.types`、env `MBP_PLUGIN_TYPES=a,b`；旧 `MBP_PLUGIN_TYPE` 保留（= types[0]），过渡期后移除。

### 4. webui：一个类型一个 UI

- 单类型包：`"webui": "ui/index.html"`（现状不动）。
- 多类型包：按角色给文件 `"webui": { "source": "ui/index.html", "home": "ui/home.html" }`；map 的 key 必须 ∈ types、文件必须存在；允许两个角色指向同一文件；某个角色不写 = 那一栏不挂行。
- 多类型包给单 string 直接拒（逼它显式声明每个角色的 UI）。
- 侧栏：包在它**每个声明了 webui 的类型栏**下各占一行，页 id `pui-<role>-<id>` 天然不撞，通用渲染器零改；各栏是独立 iframe，切页重建，需保活的状态由插件落共享 `data/`。
- ingress 转发给插件 `http` 动作时 args 带 `role`；iframe src 带 `?role=<type>`，插件前端知道自己被挂在哪栏。

### 5. 其余口径

- 自更新：更新包与已装包 **id 相同且 types 集合完全相同**，否则拒绝（防换包）。
- `clearCaches`：记录的 types 含 `home` 才清 `data/storage.json`；`data/cache` 照旧。
- Emby 实例选首页插件：选择器查 `types.includes('home')`，存的仍是插件 id，零改。
- hostCall 反向调用白名单不变（`home.*` / `agg.*`）。
- 前端管理页/插件库：一包一张卡，类型显示为多个徽章；侧栏四个类型分组与动态子项机制不变。
- 日志展示可用 `source/catpaw` 这种角色串方便排查，但**仅展示**，不进存储与 URL。

## 备选（已否决）

- **主类型 + types 兼任**（记录保留单值 type 作主类型，目录仍按 type 分层）：类型不平级，"加一种能力"要解释主次语义，且 `(type,id)` 反查规则隐晦。用户否决。
- **路径式 id**（id 写成 `home/missav`，sid 即路径）：与 agg 已有的源引用 `插件id/实例id`（catpaw/s1，存于模板、site-stats、MediaSourceId）撞分隔符，要做三段式数据迁移；全部存量包要改 id 重打，ingress 路由要支持多段贪婪匹配并防目录穿越，外部已存的 ingress URL / MediaSourceId 失效；且它并不能省掉 types 机制（多类型包仍要角色反查与按 role 分发）。收益只是 sid 单值更干净，不值。
- **单 webui + webuiRole 只挂一栏**：用户明确要"一个类型一个 UI"，每个角色的设置应在自己的栏目下独立可达。
- **同 id 多包双轨保留**（旧包留在类型目录、新包走 id 目录）：两套寻址永久并存，否决；旧同 id 包由迁移任务统一处置。
