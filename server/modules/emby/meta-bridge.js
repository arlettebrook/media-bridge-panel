'use strict';
/**
 * **emby 层与元数据插件打交道的那一层**（面板中立：本文件不认识某个具体域）
 *
 * 四件事：
 *   ① `itemId` / `parseItemId` —— Emby 条目 Id 的派生与解析（形状由 `core/providers.js` 统一规定）；
 *   ② `httpStatusOf` —— 失败原因 → 该回给客户端的 HTTP 状态码；
 *   ③ **图片地址**：拼串、拆成"无头相对路径"、按当前基地址拼回来（图片的代取与签名在面板这边，
 *      见 docs/adr/0013）。图片基地址来自**元数据插件的域声明**（同步快照，见 `meta.declSync`）；
 *   ④ **取数转发**：取元数据 / 取一季分集 / 按名字搜索 → 交给插件（面板不解析上游字段）。
 *
 * 插件回的就是**面板的中立字段**（`entryId` / `type` / `personId`…，形状由插件契约第六节规定）
 * —— 本层**不做任何改名**：`service.js` 直接消费这份中立形状，拼 DTO 时才翻成 Emby 的字段
 * （`Id` / `Type` / `People[]`…）。即「插件负责上游 → 面板形状，emby 层负责面板形状 → Emby DTO」。
 *
 * **域是参数，没有"默认域"**：`itemId()` / `imageUrlOf()` / `providerIdKey()` 都按域取数，
 * 域由 `parseItemId` 从条目 Id 的前缀带出来（`p.domain`）。确实没传域时，由 `defaultDomain()`
 * **按当前实例配置 / 已启用插件现算**（不再写死 tmdb）——装哪个域就用哪个域。
 * 条目编号在这一层统一叫 `entryId`（与 `core/providers.js`、插件契约同一份词汇）——
 * TMDB 时它是数字（`550`）、MissAV 时它是 slug（`ssis-001`），条目 Id 只透传这个编号，不解释它
 * （见 `core/providers.js` 与 docs/adr/0031）。
 */
const providers = require('../../core/providers');
const meta = require('./meta');
const instance = require('./instance');

/**
 * TMDB 这个域的 id —— **只用于「本来就是 TMDB 专属」的那几处**，不是"全局默认域"：
 *   · `themoviedb.org` 外链（只有 TMDB 的条目编号拼得出的才是真链）；
 *   · 官方图床兜底 + 「用相对路径存图」这套约定（只有 TMDB 这条链用，别的域给整串 URL）。
 * 除此之外没有任何地方该假设 tmdb 存在（见 `defaultDomain()`）。
 */
const TMDB_DOMAIN = 'tmdb';
/** TMDB 官方图床：插件没声明 `imageBase` 时给 tmdb 域兜底用 */
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';
const stripSlash = (s) => String(s || '').replace(/\/+$/, '');

/**
 * 没显式给域时的兜底域 —— **现算，不写死**。
 *
 * 顺序：
 *   ① 当前 Emby 实例限定的域里的第一个（`metaDomains[0]`）—— 实例自己选了搜哪些域，
 *      那就是这台实例的"默认"；`metaDomains` 是空数组（显式不搜任何域）时如实回空；
 *   ② 没实例上下文 → 取第一个**已装且启用**的元数据域；
 *   ③ 一个都没有 → 空串（调用方据此如实报"没有可用的元数据域"，别硬编一个域去问）。
 */
function defaultDomain() {
  const cur = instance.current();
  if (cur && Array.isArray(cur.metaDomains)) return String(cur.metaDomains[0] || '');
  const on = providers.list().find((p) => p.enabled);
  return on ? on.prefix : '';
}

/** 「没有可用的元数据域」的统一错误（503：这台服务器现在给不出元数据，不是客户端要的东西有问题） */
function noDomainError() {
  return { code: 'NO_PLUGIN', status: 503, message: '没有可用的元数据域（没装或没启用元数据插件）' };
}

/**
 * 失败原因 → 该回给客户端的 HTTP 状态码。
 *
 * 上游给过状态码就**照搬**（401/403/404/429/5xx…）—— 让客户端看到的就是真实失败原因；
 * 上游没给（网络层）才由本层归类：超时 504、连不上 502。
 * 插件这一层的四种（没装 / 没启用 / 没在跑 / 没这个动作）一律 503 ——
 * 那是"这台服务器现在给不出元数据"，不是客户端要的东西有问题。
 */
function httpStatusOf(error) {
  const e = error || {};
  if (e.status) return e.status;
  if (e.code === 'TIMEOUT') return 504;
  if (e.code === 'NO_TOKEN') return 500; // 插件还没配 token，不是客户端的问题
  if (e.code === 'BAD_ID') return 400;
  if (e.code === 'NO_PLUGIN' || e.code === 'PLUGIN_DISABLED' || e.code === 'PLUGIN_DOWN' || e.code === 'NO_ACTION') return 503;
  return 502;
}

/**
 * Emby 条目的 Id：只由「元数据坐标」派生，**不含源信息**。
 *
 * 客户端拿到它当主键回查（详情 / 季集 / 图片 / 播放都只带 Id），所以它必须稳定：
 * 掺进"哪次搜索、哪个站点"就会因为源变动而变 Id，客户端缓存的「已看」会全丢。
 * 带 type 是因为同一个编号在 tv 与 movie 下是两条不同数据。
 *
 * 形状与拼装规则住在 `core/providers.js`（**认哪个前缀**由那张注册表说了算）。
 * 传了 season 就是季：`tmdb_95350_tv_s1`；再传 episode 就是集：`tmdb_95350_tv_s1_e3`
 * （电影分不了季，季分不了集 —— 层级只能一级一级往下走）。
 */
function itemId(domain, type, entryId, season, episode) {
  return providers.itemId(domain, entryId, type, season, episode);
}

/**
 * itemId() 的逆 —— 必须与它互逆，所以紧挨着放（改格式时一眼能看到要一起改）。
 * 内部走注册表解析，字段名沿用 `core/providers.js` 的中立形状（`entryId`），
 * 只额外把 `prefix` 翻成 `domain`（聚合层按它解析"该用哪套模板"）。
 *
 * 认不出来 / 前缀没有对应的插件 / 条目编号为空或含非法字符 / 电影带季号 / 有集号却没有季号 → null。
 */
function parseItemId(id) {
  const p = providers.parseItemId(id);
  return p ? { type: p.type, entryId: p.entryId, season: p.season, episode: p.episode, domain: p.prefix } : null;
}

/* ---------------------------------------------------------------- 图片 */

/**
 * 该域当前生效的图片基地址：插件的域声明里那个。
 * 取不到时分两种：tmdb 域用官方地址兜住；别的域**如实回空** ——
 * 那些域给的是整串 URL（见 `imageUrlOf`），没有"基地址 + 相对路径"这一层可拼。
 */
function imageBase(domain = TMDB_DOMAIN) {
  const decl = meta.declSync(domain);
  const own = stripSlash((decl && decl.imageBase) || '');
  if (own) return own;
  return domain === TMDB_DOMAIN ? TMDB_IMAGE_BASE : '';
}

/**
 * 拼图片地址。
 *   · `filePath` 已是完整 http(s) 地址 → **原样返回**（MissAV 这类来源给的就是整串 URL，
 *     面板不擅自改写）；
 *   · 否则按该域的基地址拼（`poster_path` 以 / 开头）；基地址取不到就如实回空。
 */
function imageUrlOf(domain, size, filePath) {
  const p = String(filePath || '');
  if (!p) return '';
  if (/^https?:\/\//i.test(p)) return p;
  const base = imageBase(domain);
  return base ? `${base}/${size}${p}` : '';
}

/**
 * 图片 URL → **无头相对路径**。只有当它确实落在「tmdb 域的图床基地址」或「TMDB 官方基地址」
 * 之下时才拆，否则回 null（表示这是别处的绝对地址，原样存）。
 *
 * **只认 tmdb**：别的域（如 MissAV 的封面站）给的是整串 URL，拆成相对路径之后读回来会按
 * 当前的 tmdb 基地址重拼，而图片缓存里不带域 —— 拼错图床就是错图。那类一律原样存。
 * （这条是「相对路径」这套约定本身的归属，不是"tmdb 是默认域"——见 TMDB_DOMAIN 那段。）
 *
 * **为什么要拆**：图片索引是落库的。若存完整 URL，用户把图床基地址换成镜像后，库里那批老地址
 * 就全指向旧图床了 —— 要等 TTL 过期才自愈。存相对路径、取时再拼当前基地址，**换镜像立刻生效**。
 * 同时认官方基地址：插件可能把 `https://image.tmdb.org/t/p` 写死在自己代码里，而面板配的是镜像。
 */
function splitImageUrl(url) {
  const u = String(url || '');
  if (!/^https?:\/\//i.test(u)) return null;
  for (const b of new Set([stripSlash(imageBase(TMDB_DOMAIN)), TMDB_IMAGE_BASE])) {
    if (b && u.startsWith(b + '/')) return u.slice(b.length + 1);
  }
  return null;
}

/** `splitImageUrl` 的逆：用**当前**图片基地址把相对路径拼回完整 URL（相对路径这套归 tmdb 域） */
function joinImageUrl(rel) {
  return imageBase(TMDB_DOMAIN) + '/' + String(rel || '').replace(/^\/+/, '');
}

/**
 * 域 → `ProviderIds` 里那个键（客户端拿它做外部 id 反查）：tmdb → `Tmdb`、missav → `Missav`。
 * 没登记的域按首字母大写兜一个 —— 多一个域不该因为少一条映射就整条 DTO 拼不出来。
 */
const PROVIDER_KEYS = { tmdb: 'Tmdb', missav: 'Missav' };
function providerIdKey(domain) {
  const d = String(domain || defaultDomain() || '').trim().toLowerCase();
  if (!d) return 'Provider';
  return PROVIDER_KEYS[d] || d.replace(/^[a-z]/, (c) => c.toUpperCase());
}

/**
 * 把客户端发来的**外部 id 引用前缀**认成一个已注册的元数据域（大小写不敏感）。
 *
 * 客户端的 `AnyProviderIdEquals` 是 `{前缀}.{编号}` 形状（Emby 惯例），前缀一般是域 id
 * （`tmdb.550`、`missav.dldss-559`）。**认不出就回 null，不猜** —— 同搜索分派的口径：
 * 认不出的前缀如实回空并点名（见 docs/plugin-contract.md）。
 */
function domainOfRef(prefix) {
  const p = providers.byPrefixOf(prefix);
  return p ? p.prefix : null;
}

/* ---------------------------------------------------------------- 取数（转发给元数据插件） */

/**
 * 当前 Emby 实例的 metaDomains 是否允许这个域。
 *
 * 实例上 `metaDomains` 有三种口径（见 instance.js 的 publicInstance）：
 *   null / undefined —— 字段缺席，**不限域**（默认实例与老实例），放行；
 *   空数组 `[]`      —— 显式"不允许任何域"，拒绝所有；
 *   非空数组         —— 只有列出来的域才放行；
 * 没有实例上下文（面板内部端点直接调本层）→ 也放行（面板自己不做域隔离）。
 *
 * 这条**是硬性契约**：客户端从一个实例里拿到的条目 id 前缀是 A，它就永远
 * 属于 A 域 —— 实例既然选了允许的域，任何端点（搜索/详情/图片/播放）都不能
 * 把不在清单里的域放进来。
 */
function domainAllowed(domain) {
  const inst = instance.current();
  if (!inst) return true; // 没有实例上下文时放行（面板自用端点）
  const only = inst.metaDomains;
  if (only === null || only === undefined) return true; // 字段缺席 = 不限域
  const want = String(domain || '').toLowerCase();
  return Array.isArray(only) && only.some((d) => String(d).toLowerCase() === want);
}

/**
 * 反查一个条目 —— 单一实现，Emby 各端点都走这里。
 * 不抛异常：`{ ok: true, item }` 或 `{ ok: false, error: {code,status?,message} }`
 *
 * `item` 是**插件契约的中立形状，原样返回**（`entryId` / `type` / `cast[].personId`…），
 * 翻译成 Emby DTO 是 service.js 的事，这一层不改名。
 *
 * withSeasons：把剧的 seasons[] 一并归一化挂到 item.seasons（季列表端点用）。
 * 默认关 —— 否则整包季数组会跟着条目一起回给客户端，纯噪声。
 * rich：详情页要的那一批（分级/时长/标语/演职/公司/关键词/预告/图集/相似）。
 */
async function lookup({ type = 'tv', entryId, rich = false, withSeasons = false, domain = defaultDomain() } = {}) {
  if (!domain) return { ok: false, error: noDomainError() };
  if (!domainAllowed(domain)) {
    return { ok: false, error: { code: 'DOMAIN_NOT_ALLOWED', status: 403, message: `实例未允许域 ${domain}` } };
  }
  const out = await meta.lookup(domain, { entryId, type, rich, withSeasons });
  if (!out.ok) return { ok: false, error: out.error };
  return { ok: true, item: out.item };
}

/**
 * 反查某一季的分集 —— 面板侧不再认识 `/tv/{id}/season/{n}`，那是插件的事。
 * 与 `lookup()` 同一取向：不抛异常、返回值保持插件契约的中立形状。
 */
async function lookupSeason({ entryId, season, domain = defaultDomain() } = {}) {
  if (!domain) return { ok: false, error: noDomainError() };
  if (!domainAllowed(domain)) {
    return { ok: false, error: { code: 'DOMAIN_NOT_ALLOWED', status: 403, message: `实例未允许域 ${domain}` } };
  }
  const out = await meta.season(domain, { entryId, season });
  if (!out.ok) return { ok: false, error: out.error };
  return { ok: true, item: out.item };
}

/**
 * 按名字搜索 —— 给 emby 的搜索端点用。
 *
 * 走每个**已装且启用**的元数据域的「搜索」动作，按域顺序拼接。
 * **域还被当前实例限定**：实例上存了「搜索通过的域」（`instance.metaDomains`）时只走那些域；
 * 字段缺席（`null`）= 全部域，空数组 = 一个都不搜（见 `instance.js`）。
 * 失败**照实抛**（调用方按类型分别 catch，一个域失败不影响别的域）。
 * 每一行都带上是哪个域的（`domain`）—— 条目 Id 将来就是按它拼的。
 * ⚠️ 行里是**归一化字段**（`entryId` / `title` / `posterPath`…），不翻成上游那套叫法：
 * 消费方（`searchRowDto`）读的就是这几个名字 —— 面板不该懂上游的字段形状。
 */
async function search(type, name, page) {
  const cur = instance.current();
  /* 实例限定的域（小写，见 instance.normDomains）；null = 不限，即全部域 */
  const only = cur && Array.isArray(cur.metaDomains) ? cur.metaDomains.map((d) => String(d).toLowerCase()) : null;
  const all = providers.list();
  const pool = only ? all.filter((p) => only.includes(String(p.prefix).toLowerCase())) : all;
  const on = pool.filter((p) => p.enabled);
  /* 一个开着的域都没有 ⇒ **如实报错，不回空列表**：客户端搜不到东西时，
   * "元数据插件没启用"与"上游确实没有这部片"是两件事，混成一样就查不下去了。 */
  if (!on.length) {
    const labels = pool.map((p) => p.label);
    const e = new Error(
      labels.length
        ? `元数据插件 ${labels.join('、')} 没启用（「插件」页可以打开）`
        : only && only.length
          ? `这个实例选定的搜索域（${only.join('、')}）都没有对应的元数据插件（「插件」页可以装/启用）`
          : only
            ? '这个实例没有勾选任何搜索域（客户端搜不到内容）'
            : '还没有装元数据插件（「插件」页可以装一个）'
    );
    e.code = labels.length ? 'PLUGIN_DISABLED' : 'NO_PLUGIN';
    throw e;
  }
  /* **电影式的域不接 `tv` 这一趟**：它声明的条目只有条目一层（`series: false`），
   * 拿 `tv` 去问它只会得到一串被标成剧集的行。这一趟如实回空，让 `movie` 那一趟去问它。 */
  const live = on.filter((p) => type === 'movie' || p.series !== false);
  const out = [];
  for (const p of live) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await meta.search(p.prefix, type, name, page);
    for (const r of rows || []) out.push(Object.assign({}, r, { domain: p.prefix }));
  }
  return out;
}

module.exports = {
  TMDB_DOMAIN,
  TMDB_IMAGE_BASE,
  defaultDomain,
  httpStatusOf,
  itemId,
  parseItemId,
  providerIdKey,
  domainOfRef,
  lookup,
  lookupSeason,
  search,
  imageBase,
  imageUrlOf,
  splitImageUrl,
  joinImageUrl,
};