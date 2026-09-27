'use strict';
/**
 * MissAV 首页插件 · 行清单与行处理器。
 *
 * 一行 = 客户端上的一个媒体库。第三方 Widget 脚本里的二十多个模块（热门榜、新作、
 * 中文字幕、无码分类、亚洲专区、质量分类……）在这里收敛成九行：榜单类各占一行，
 * 那几个"先选一个分类再进"的模块用枚举参数承载分类清单，再加一行自由输入的入口 ——
 * 于是剩下的模块改一个参数就能用，不必给每个分类各开一个库。
 *
 * 每个模块的入口路径里都带一段会变的 `dm<数字>` 前缀（第三方脚本自己也把它写死在代码里）。
 * 这里一律做成行的 `path` 参数**并给内置默认值**：站点换前缀时在设置页改，不用改代码。
 *
 * 翻页：站点自己每页 12 条，客户端把 `startIndex` / `limit` 原样透传进来，换算见 `pageOf` / `windowOf`。
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
  { id: 'uncensored', title: 'MissAV 无码影片库', functionName: 'listPage', cacheDuration: 3600,
    params: [pathEnum('/dm621/cn/uncensored-leak', UNCENSORED_OPTIONS)] },
  { id: 'asian', title: 'MissAV 亚洲专区', functionName: 'listPage', cacheDuration: 3600,
    params: [pathEnum('/dm34/cn/madou', ASIAN_OPTIONS)] },
  { id: 'quality', title: 'MissAV 影片质量', functionName: 'listPage', cacheDuration: 3600,
    params: [pathEnum('/dm95/cn/genres/%E9%AB%98%E6%B8%85', QUALITY_OPTIONS)] },
  { id: 'custom', title: 'MissAV 自定义入口', functionName: 'listPage', cacheDuration: 1800,
    params: [pathParam('/dm291/cn/today-hot?sort=today_views')] },
];

/* ─────────────────────────── 换算 ─────────────────────────── */

/** 客户端窗口 → 站点页码 */
function pageOf(ctx) {
  return Math.floor((ctx.startIndex || 0) / SITE_PAGE) + 1;
}

/**
 * 客户端窗口在站点**一页**里怎么切。
 *
 * 只取站点一页：窗口跨页时可能凑不满 `limit`（站点是 12 条一页，客户端要 20 条就只给 12 条，
 * 下一页补上）。`total` 是准的，客户端按**实际拿到的条数**往后推进，不影响翻页。
 * 想一次凑满就自己连着取几页 —— 那是插件自己的取舍（代价是多打上游）。
 */
function windowOf(items, ctx) {
  const start = ctx.startIndex || 0;
  const size = ctx.limit > 0 ? ctx.limit : SITE_PAGE;
  const offset = start % SITE_PAGE;
  return items.slice(offset, offset + size);
}

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
 * 跑一行：取站点一页 → 解析成 HomeItem[] → 按客户端窗口切一刀。
 *
 * 失败一律**照实抛**（面板记日志、客户端拿到失败码）—— 不编空数据冒充"库里没内容"。
 * `total` 取分页条上的总页数 × 每页条数；分页条没解析出来就按本页条数如实报。
 */
async function listPage(ctx) {
  const cfg = settings.read();
  const page = pageOf(ctx);
  let url = buildUrl(cfg.siteBase, ctx.params.path, page);
  if (ctx.params.sort) url = applySort(url, ctx.params.sort);

  const html = await getHtml(url, { siteBase: cfg.siteBase, signal: ctx.signal });
  const items = parseVideoList(html, { imageBase: cfg.imageBase });
  const totalPages = parseTotalPages(html);
  const total = totalPages > 0 ? totalPages * SITE_PAGE : items.length;

  return { items: windowOf(items, ctx), total };
}

/** 键 = 行声明的 `functionName`；`ctx = { params, startIndex, limit, signal }` */
const handlers = { listPage };

module.exports = { ROWS, handlers, SITE_PAGE, buildUrl, pageOf };