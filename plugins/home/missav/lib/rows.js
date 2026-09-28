'use strict';
/**
 * MissAV 首页插件 · 行清单与行处理器。
 *
 * 一行 = 客户端上的一个媒体库。第三方 Widget 脚本里的二十多个模块（热门榜、新作、
 * 中文字幕、无码分类、亚洲专区、质量分类……）在这里收敛成十行：榜单类各占一行，
 * 那几个"先选一个分类再进"的模块用枚举参数承载分类清单，再加一行自由输入的入口、
 * 一行随机推荐 —— 于是剩下的模块改一个参数就能用，不必给每个分类各开一个库。
 *
 * 每个模块的入口路径里都带一段会变的 `dm<数字>` 前缀（第三方脚本自己也把它写死在代码里）。
 * 这里一律做成行的 `path` 参数**并给内置默认值**：站点换前缀时在设置页改，不用改代码。
 *
 * 「随机推荐」那一行额外声明了 `feed: 'random'` —— 客户端首页那条"只要推荐"的查询会路由到它，
 * 轮播图因此有素材（同 TMDB 示例插件的做法，见 `plugins/home/example/lib/rows.js`）。
 *
 * 翻页：站点自己每页 12 条，客户端把 `startIndex` / `limit` 原样透传进来，换算见 `listPage`。
 */
const settings = require('./settings');
const { getHtml } = require('./fetch');
const { parseVideoList, parseTotalPages } = require('./parse');

/** 站点自己的每页条数（线上实测 12 条一页；改了它 `pageOf` 与 `total` 就跟着准） */
const SITE_PAGE = 12;

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/* ─────────────────────────── 参数声明 ─────────────────────────── */

/** 入口路径：自由输入，默认值是线上那个真实模块 */
function pathParam(value) {
  return {
    name: 'path',
    title: '入口路径',
    type: 'input',
    value: value,
    description: '站点里的模块路径（可带查询串），留空这一行就没有内容',
  };
}

/** 入口路径：从模块自带的分类清单里选一个 */
function pathEnum(value, pairs) {
  return {
    name: 'path',
    title: '入口路径',
    type: 'enumeration',
    value: value,
    enumOptions: pairs.map((p) => ({ title: p[0], value: p[1] })),
  };
}

/** 排序方式：站点接受的那几个值（搜索页与部分榜单支持） */
const SORT_OPTIONS = [
  ['发行日期', 'released_at'],
  ['最近更新', 'published_at'],
  ['收藏数', 'saved'],
  ['今日浏览数', 'today_views'],
  ['本周浏览数', 'weekly_views'],
  ['本月浏览数', 'monthly_views'],
  ['总浏览数', 'views'],
];

const UNCENSORED_OPTIONS = [
  ['无码流出', '/dm621/cn/uncensored-leak'],
  ['FC2', '/dm99/cn/fc2'],
  ['HEYZO', '/dm319995/cn/heyzo'],
  ['东京热', '/dm29/cn/tokyohot'],
  ['Caribbeancom', '/dm1271239/cn/caribbeancom'],
  ['Gachinco', '/dm135/cn/gachinco'],
  ['XXX-AV', '/dm29/cn/xxxav'],
  ['人妻斩', '/dm24/cn/marriedslash'],
  ['顽皮 4610', '/dm19/cn/naughty4610'],
  ['顽皮 0930', '/dm22/cn/naughty0930'],
];

const ASIAN_OPTIONS = [
  ['麻豆传媒', '/dm34/cn/madou'],
  ['韩国直播', '/cn/klive'],
  ['中国直播', '/cn/clive'],
];

const QUALITY_OPTIONS = [
  ['高清', '/dm95/cn/genres/%E9%AB%98%E6%B8%85'],
  ['独家', '/dm136/cn/genres/%E7%8B%AC%E5%AE%B6'],
  ['单体作品', '/dm118/cn/genres/%E5%8D%95%E4%BD%93%E4%BD%9C%E5%93%81'],
  ['薄格', '/dm95/cn/genres/%E8%96%84%E6%A0%BC'],
  ['全高清 (FHD)', '/cn/genres/%E5%85%A8%E9%AB%98%E6%B8%85%20(FHD)'],
  ['低成本影片', '/cn/genres/%E4%BD%8E%E6%88%90%E6%9C%AC%E5%BD%B1%E7%89%87'],
  ['套装商品', '/cn/genres/%E5%A5%97%E8%A3%85%E5%95%86%E5%93%81'],
  ['限时特卖', '/cn/genres/%E9%99%90%E6%97%B6%E7%89%B9%E5%8D%96'],
];

/**
 * 行清单。`collectionType` 一律写 `movies`：站上每个条目都是单本影片，没有剧集式的内容，
 * 库类型不随参数变（不像 TMDB 那些有"类型"参数的行）。
 *
 * `cacheDuration` 取第三方脚本里同一模块的 3600 秒。
 */
const ROWS = [
  { id: 'today_hot', title: 'MissAV 今日热门', functionName: 'listPage', cacheDuration: 3600,
    params: [pathParam('/dm291/cn/today-hot?sort=today_views')] },
  { id: 'weekly_hot', title: 'MissAV 本周热门', functionName: 'listPage', cacheDuration: 3600,
    params: [pathParam('/dm169/cn/weekly-hot?sort=weekly_views')] },
  { id: 'monthly_hot', title: 'MissAV 本月热门', functionName: 'listPage', cacheDuration: 3600,
    params: [pathParam('/dm257/cn/monthly-hot?sort=monthly_views')] },
  { id: 'new_release', title: 'MissAV 新作上市', functionName: 'listPage', cacheDuration: 3600,
    params: [pathParam('/dm588/cn/release?sort=released_at')] },
  { id: 'chinese_subtitle', title: 'MissAV 中文字幕', functionName: 'listPage', cacheDuration: 3600,
    params: [pathParam('/dm265/cn/chinese-subtitle?sort=released_at'), {
      name: 'sort', title: '排序', type: 'enumeration', value: 'released_at',
      enumOptions: SORT_OPTIONS.map((p) => ({ title: p[0], value: p[1] })),
    }] },
  { id: 'fc2', title: 'MissAV FC2 系列', functionName: 'listPage', cacheDuration: 3600,
    params: [pathParam('/dm99/cn/fc2?sort=released_at'), {
      name: 'sort', title: '排序', type: 'enumeration', value: 'released_at',
      enumOptions: SORT_OPTIONS.map((p) => ({ title: p[0], value: p[1] })),
    }] },
  { id: 'uncensored', title: 'MissAV 无码影片库', functionName: 'listPage', cacheDuration: 3600,
    params: [pathEnum('/dm621/cn/uncensored-leak', UNCENSORED_OPTIONS)] },
  { id: 'asian', title: 'MissAV 亚洲专区', functionName: 'listPage', cacheDuration: 3600,
    params: [pathEnum('/dm34/cn/madou', ASIAN_OPTIONS)] },
  { id: 'quality', title: 'MissAV 影片质量', functionName: 'listPage', cacheDuration: 3600,
    params: [pathEnum('/dm95/cn/genres/%E9%AB%98%E6%B8%85', QUALITY_OPTIONS)] },
  { id: 'custom', title: 'MissAV 自定义入口', functionName: 'listPage', cacheDuration: 1800,
    params: [pathParam('/dm291/cn/today-hot?sort=today_views')] },
  {
    /* 「随机推荐」—— 这一行**同时给客户端首页的轮播图供图**。
     *
     * 声明 `feed: 'random'`：客户端那条"不要库 Id、只要推荐"的查询会被路由到这一行；
     * **不声明 `feed` 的行，那条查询继续回空** → 轮播图没素材。
     * 它同时也是一行普通的库行（客户端里会多出一个「随机推荐」的库）。
     *
     * 半小时：轮播图"每次进来略有不同"就够；一次刷新 = 2 次上游请求（探页数 + 取随机页），
     * 缓存把这个数压到每半小时 2 次。 */
    id: 'random_picks',
    title: 'MissAV 随机推荐',
    functionName: 'randomPicks',
    feed: 'random',
    cacheDuration: 1800,
    /* 这一行要打两次上游（探页数 + 随机页），把行超时抬到 30 秒，别让慢网络把它掐掉 */
    timeoutMs: 30000,
  },
];

/* ─────────────────────────── 换算 ─────────────────────────── */

/** 客户端窗口 → 站点页码（`startIndex` 落在站点哪一页） */
function pageOf(ctx) {
  return Math.floor((ctx.startIndex || 0) / SITE_PAGE) + 1;
}

/** 一次请求**最多**连取几页站点来填窗口 —— 防呆，别让 `Limit=1000` 把站点打穿 */
const MAX_UPSTREAM_PAGES = 10;

/**
 * 把行的入口路径拼成完整地址。`siteBase` 与路径都可能带查询串，
 * 所以统一走 URL 对象：页码只加在 `page > 1` 时（与第三方脚本一致）。
 */
function buildUrl(siteBase, path, page) {
  const base = settings.stripSlash(siteBase);
  const rel = String(path || '').trim();
  if (!rel) throw fail('BAD_PARAM', '这一行的入口路径是空的，没有可取的列表');
  const u = new URL(base + (rel.startsWith('/') ? rel : '/' + rel));
  if (page > 1) u.searchParams.set('page', String(page));
  return u.toString();
}

/** 中文字幕那行额外有个排序参数：把它并进查询串（行参数优先于路径里原有的） */
function applySort(url, sort) {
  const s = String(sort || '').trim();
  if (!s) return url;
  const u = new URL(url);
  u.searchParams.set('sort', s);
  return u.toString();
}

/* ─────────────────────────── 处理器 ─────────────────────────── */

/**
 * 跑一行：按客户端窗口**连续取站点页** → 解析成 HomeItem[] → 切出这一页。
 *
 * ⚠️ **窗口必须填满**：站点一页只有 `SITE_PAGE`（12）条，只取一页时客户端要 20 条就只拿到 12 条，
 * 而 Emby 客户端见到 `Items.Count < Limit` 就把这页当最后一页、**再也不翻页**（SenPlayer 6.2.1
 * 实测如此；Rex 按实际条数推进才没暴露）。所以这里连着取，直到（去重后）攒够窗口或站点到底：
 * `offset = start % SITE_PAGE` 是窗口在首批页里的落点，站点条目与去重后的次序基本一致，够用。
 *
 * 失败一律**照实抛**（面板记日志、客户端拿到失败码）—— 不编空数据冒充"库里没内容"。
 * `total` 取分页条上的总页数 × 每页条数；分页条没解析出来就按手里条目数如实报。
 */
async function listPage(ctx) {
  const cfg = settings.read();
  const start = Math.max(0, ctx.startIndex || 0);
  const size = ctx.limit > 0 ? ctx.limit : SITE_PAGE;
  const offset = start % SITE_PAGE;
  const first = pageOf(ctx);
  const want = offset + size; // 去重后攒够这些才够切出这一页
  const all = [];
  const seen = new Set();
  let totalPages = 0;
  for (let page = first; page < first + MAX_UPSTREAM_PAGES; page++) {
    let url = buildUrl(cfg.siteBase, ctx.params.path, page);
    if (ctx.params.sort) url = applySort(url, ctx.params.sort);
    // eslint-disable-next-line no-await-in-loop
    const html = await getHtml(url, { siteBase: cfg.siteBase, signal: ctx.signal });
    const items = parseVideoList(html, { imageBase: cfg.imageBase });
    totalPages = parseTotalPages(html) || totalPages;
    for (const it of items) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      all.push(it);
    }
    if (items.length < SITE_PAGE) break; // 站点这一页没满 ⇒ 到底了
    if (all.length >= want) break; // 攒够窗口
  }
  const total = totalPages > 0 ? totalPages * SITE_PAGE : all.length;
  return { items: all.slice(offset, offset + size), total };
}

/* ─────────────────────── 随机推荐（接客户端的推荐查询） ─────────────────────── */

/** 随机页抽到第几页为止：站点页数很多，抽得太深容易撞空页，60 页够"随机"了 */
const RANDOM_PAGE_MAX = 60;

/** 1..n 的随机整数 */
function randomInt(n) {
  return 1 + Math.floor(Math.random() * n);
}

/** 洗牌（Fisher–Yates）—— 原数组不动 */
function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

/**
 * 随机行从哪些入口里抽：把**各行当前的入口路径**（用户改过的优先）攒成一个池子。
 * 只收声明了 `path` 参数的行 —— 那些就是站点上的榜单 / 分类模块，正是"随便逛逛"要的内容。
 */
function randomPool() {
  const saved = settings.read().rowParams || {};
  const out = [];
  for (const row of ROWS) {
    const decl = (row.params || []).find((p) => p.name === 'path');
    if (!decl) continue;
    const one = saved[row.id];
    const v = one && Object.prototype.hasOwnProperty.call(one, 'path') ? one.path : decl.value;
    const path = String(v || '').trim();
    if (path && !out.includes(path)) out.push(path);
  }
  return out;
}

/**
 * 随机取站点一页：先打第 1 页拿"共几页"（分页条解析不出来就不猜，只给第 1 页），
 * 再在其中随机挑一页取内容。返回那一页解析出的条目。
 */
async function randomPage(cfg, path) {
  const first = await getHtml(buildUrl(cfg.siteBase, path, 1), { siteBase: cfg.siteBase });
  const totalPages = parseTotalPages(first);
  const cap = totalPages > 1 ? Math.min(totalPages, RANDOM_PAGE_MAX) : 1;
  const page = randomInt(cap);
  const html = page === 1 ? first : await getHtml(buildUrl(cfg.siteBase, path, page), { siteBase: cfg.siteBase });
  return parseVideoList(html, { imageBase: cfg.imageBase });
}

/**
 * 「随机推荐」—— 站点没有随机接口，只能"随机挑一个模块 + 随机挑一页"，再把这一页打乱。
 *
 * 池子里有热门 / 新作 / 分类等入口，每次随机挑一个模块、再随便翻它的一页 —— 换一次刷新就换一批内容。
 * 代价是一次刷新 **2 次**上游请求（第 1 页探总页数 + 随机页取内容），靠行的 `cacheDuration`
 * （本行 1800 秒）压住。
 *
 * ⚠️ **这一行不翻页**：每次请求本来就是一批新的随机结果，翻页只会拿到重复，
 * 所以**忽略 `startIndex`**，只按 `limit` 给。回的也是数组（不带 `total`）——
 * 客户端因此认为这一行翻不动，符合实际。
 */
async function randomPicks(ctx) {
  const cfg = settings.read();
  const pool = randomPool();
  if (!pool.length) throw fail('BAD_PARAM', '没有可抽的入口路径（各行都没配 path）');

  const path = pool[Math.floor(Math.random() * pool.length)];
  const items = shuffle(await randomPage(cfg, path));
  const limit = ctx.limit > 0 ? Math.min(ctx.limit, items.length) : items.length;
  return items.slice(0, limit);
}

/** 键 = 行声明的 `functionName`；`ctx = { params, startIndex, limit, signal }` */
const handlers = { listPage, randomPicks };

module.exports = { ROWS, handlers, SITE_PAGE, buildUrl, pageOf };