'use strict';
/**
 * TMDB · **emby 专有那一层**（取数已经搬进元数据插件，这里只留 emby 才关心的东西）
 *
 * 三件事：
 *   ① `itemId` / `parseItemId` —— Emby 条目 Id 的派生与解析（形状由 `core/providers.js` 统一规定）；
 *   ② `httpStatusOf` —— 失败原因 → 该回给客户端的 HTTP 状态码；
 *   ③ **图片地址**：拼串、拆成"无头相对路径"、按当前基地址拼回来（图片的代取与签名在面板这边，
 *      见 docs/adr/0013）。图片基地址来自**元数据插件的域声明**（同步快照，见 `meta.declSync`），
 *      插件没在跑时用官方地址兜住。
 *
 * 取数三件事（取元数据 / 取一季分集 / 任意路径）转发给插件，并把插件那份**域中立的字段名**
 * 翻回这一层与 `service.js` 一直用的叫法（`entryId` → `tmdbId`、`type` → `mediaType`、
 * `personId` → `tmdbPersonId`）—— 这样 emby 层的 DTO 拼装一个字都不用改（本批的口径是"对外一致"）。
 *
 * ⚠️ **这一层目前只服务 `tmdb` 这一个域**：`itemId()` 写死 tmdb 前缀、`ProviderIds` 写死 `Tmdb`、
 * 字段名也叫 `tmdbId`。接第二个元数据域时，这些地方与 `service.js` 的字段名要一起改
 * （域已经从 `parseItemId` 带出来了：`p.domain`，转发那一侧是现成的）。现在不提前改 ——
 * 那会把这一批变成"到处改名"的大改，而它本来该是一次纯重构。
 */
const providers = require('../../core/providers');
const meta = require('./meta');

/** 这一层服务的域（= 条目 Id 的前缀）。多域之后由 `parseItemId` 的 `domain` 决定 */
const DOMAIN = 'tmdb';

const DEFAULT_IMAGE_BASE = 'https://image.tmdb.org/t/p';
const stripSlash = (s) => String(s || '').replace(/\/+$/, '');

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
 * 带 type 是因为 TMDB 里 tv 95350 与 movie 95350 是两条不同数据。
 *
 * 形状与拼装规则住在 `core/providers.js`（**认哪个前缀**由那张注册表说了算）。
 * 传了 season 就是季：`tmdb_95350_tv_s1`；再传 episode 就是集：`tmdb_95350_tv_s1_e3`
 * （电影分不了季，季分不了集 —— 层级只能一级一级往下走）。
 */
function itemId(type, tmdbId, season, episode) {
  return providers.itemId(DOMAIN, tmdbId, type, season, episode);
}

/**
 * itemId() 的逆 —— 必须与它互逆，所以紧挨着放（改格式时一眼能看到要一起改）。
 * 内部走注册表解析，这里只把结果翻译回 emby 层用的字段名（`tmdbId`），
 * 因此调用点（`emby/service.js` 里那二十来处）不用改。
 *
 * 认不出来 / 前缀没有对应的插件 / 电影带季号 / 有集号却没有季号 / 号不是数字 → null。
 */
function parseItemId(id) {
  const p = providers.parseItemId(id);
  /* `domain` = 这个前缀（条目 Id 的前缀就是元数据域，见 docs/adr/0031）。
   * 聚合层要拿它去解析"该用哪套模板"（见 docs/adr/0033），所以一并带出去。 */
  return p ? { type: p.type, tmdbId: p.entryId, season: p.season, episode: p.episode, domain: p.prefix } : null;
}

/* ---------------------------------------------------------------- 图片 */

/** 当前生效的图片基地址：插件的域声明里那个（拿不到就用官方地址） */
function imageBase() {
  const decl = meta.declSync(DOMAIN);
  return stripSlash((decl && decl.imageBase) || '') || DEFAULT_IMAGE_BASE;
}

/** 拼图片地址（`poster_path` 以 / 开头） */
function imageUrlOf(size, filePath) {
  const p = String(filePath || '');
  return p ? `${imageBase()}/${size}${p}` : '';
}

/**
 * 图片 URL → **无头相对路径**。只有当它确实在「当前图床基地址」或「官方基地址」之下时才拆，
 * 否则回 null（表示这是别处的绝对地址，原样存）。
 *
 * **为什么要拆**：图片索引是落库的。若存完整 URL，用户把图床基地址换成镜像后，库里那批老地址
 * 就全指向旧图床了 —— 要等 TTL 过期才自愈。存相对路径、取时再拼当前基地址，**换镜像立刻生效**。
 * 同时认官方基地址：插件可能把 `https://image.tmdb.org/t/p` 写死在自己代码里，而面板配的是镜像。
 */
function splitImageUrl(url) {
  const u = String(url || '');
  if (!/^https?:\/\//i.test(u)) return null;
  for (const b of new Set([stripSlash(imageBase()), DEFAULT_IMAGE_BASE])) {
    if (b && u.startsWith(b + '/')) return u.slice(b.length + 1);
  }
  return null;
}

/** `splitImageUrl` 的逆：用**当前**图片基地址把相对路径拼回完整 URL */
function joinImageUrl(rel) {
  return imageBase() + '/' + String(rel || '').replace(/^\/+/, '');
}

/* ---------------------------------------------------------------- 取数（转发给元数据插件） */

/**
 * 插件那份**域中立的字段名** → 这一层一直用的叫法。
 * 只翻这几个（面板侧别的代码读的就是它们）：`entryId` / `type` / `personId`。
 */
function toInternal(item) {
  if (!item || typeof item !== 'object') return item;
  const out = Object.assign({}, item, { tmdbId: item.entryId, mediaType: item.type });
  delete out.entryId;
  delete out.type;
  for (const key of ['cast', 'crew']) {
    if (!Array.isArray(out[key])) continue;
    out[key] = out[key].map((p) => {
      const one = Object.assign({}, p, { tmdbPersonId: p.personId });
      delete one.personId;
      return one;
    });
  }
  if (Array.isArray(out.recommendations)) {
    out.recommendations = out.recommendations.map((x) => {
      const one = Object.assign({}, x, { tmdbId: x.entryId });
      delete one.entryId;
      return one;
    });
  }
  return out;
}

/**
 * 反查一个条目 —— 单一实现，Emby 各端点都走这里。
 * 不抛异常：`{ ok: true, item }` 或 `{ ok: false, error: {code,status?,message} }`
 *
 * withSeasons：把剧的 seasons[] 一并归一化挂到 item.seasons（季列表端点用）。
 * 默认关 —— 否则整包季数组会跟着条目一起回给客户端，纯噪声。
 * rich：详情页要的那一批（分级/时长/标语/演职/公司/关键词/预告/图集/相似）。
 */
async function lookup({ type = 'tv', tmdbId, rich = false, withSeasons = false, domain = DOMAIN } = {}) {
  const out = await meta.lookup(domain, { entryId: tmdbId, type, rich, withSeasons });
  if (!out.ok) return { ok: false, error: out.error };
  return { ok: true, item: toInternal(out.item) };
}

/**
 * 反查某一季的分集 —— 面板侧不再认识 `/tv/{id}/season/{n}`，那是插件的事。
 * 与 `lookup()` 同一取向：不抛异常。
 */
async function lookupSeason({ tmdbId, season, domain = DOMAIN } = {}) {
  const out = await meta.season(domain, { entryId: tmdbId, season });
  if (!out.ok) return { ok: false, error: out.error };
  return { ok: true, item: toInternal(out.item) };
}

/**
 * 按名字搜索 —— 给 emby 的搜索端点用。
 *
 * 走每个**已装且启用**的元数据域的「搜索」动作，按域顺序拼接（这一版只有一个域）。
 * 失败**照实抛**（调用方按类型分别 catch，一个域失败不影响别的域）。
 * 每一行都带上是哪个域的（`domain`）—— 条目 Id 将来就是按它拼的。
 * ⚠️ 行里是**归一化字段**（`entryId` / `title` / `posterPath`…），不翻成上游那套叫法：
 * 消费方（`searchRowDto`）读的就是这几个名字 —— 面板不该懂上游的字段形状。
 */
async function search(type, name) {
  const all = providers.list();
  const live = all.filter((p) => p.enabled);
  /* 一个开着的域都没有 ⇒ **如实报错，不回空列表**：客户端搜不到东西时，
   * "元数据插件没启用"与"上游确实没有这部片"是两件事，混成一样就查不下去了。 */
  if (!live.length) {
    const e = new Error(
      all.length
        ? `元数据插件 ${all.map((p) => p.label).join('、')} 没启用（「插件」页可以打开）`
        : '还没有装元数据插件（「插件」页可以装一个）'
    );
    e.code = all.length ? 'PLUGIN_DISABLED' : 'NO_PLUGIN';
    throw e;
  }
  const out = [];
  for (const p of live) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await meta.search(p.prefix, type, name);
    for (const r of rows || []) out.push(Object.assign({}, r, { domain: p.prefix }));
  }
  return out;
}

/**
 * 任意路径的取数 —— 给「首页插件」的 `Catpaw.tmdb.get(api, {params})` 用。
 *
 * 与 `lookup()` / `lookupSeason()` 的区别：那两条是**固定端点 + 归一化输出**；
 * 这条是**任意路径 + 原样返回响应体**（插件自由取榜单用），不解析、不裁剪。
 * 契约：成功 → 响应体本体；失败 → **抛错**（`err.code` / `err.status` / `err.data`）。
 */
function get(api, opts = {}) {
  return meta.get(DOMAIN, api, opts.params || {});
}

module.exports = {
  DEFAULT_IMAGE_BASE,
  httpStatusOf,
  itemId,
  parseItemId,
  lookup,
  lookupSeason,
  search,
  get,
  imageBase,
  imageUrlOf,
  splitImageUrl,
  joinImageUrl,
};
