'use strict';
/**
 * MissAV 片源插件 · 入口（动作层）
 *
 * 契约见 docs/plugin-contract.md 第五节。这个插件把 MissAV 当成一个站接进来：
 * 搜索走站内搜索页，详情走影片页，播放地址是影片页里的 m3u8。
 *
 *   sites   站点清单     —                        这个插件现在有哪些站点（一个）
 *   search  候选         {source,key,wd,page}      站内搜索页 → macCMS 形状的列表
 *   detail  取播放项     {source,key,id,season,episode,pick}
 *   play    解析地址     {ref,clientHost}          一个 ref → 真实 m3u8 + 请求头
 *   probe   站点测速     {source,key,wd}           体检口径的一发（不重试、不看内容）
 *   http    webui 后端   {method,path,query,body}  插件自己设置页的后端
 *
 * 取数动作的返回形状刻意与面板原来那份上游响应**逐字段对齐**（`{status,ok,text,json}` 或
 * `{error:{code,message}}`），面板那套"搜不到怎么算、超时怎么报"的判据一个字都不用改
 * （见 agg/source-bridge.js）。`detail` 另带 `detail:{lines,…}` 与 `detailNote`，
 * `play` 另带 `urls/header/parse`。
 *
 * 站点只有一个、实例 id 也就是 `missav`（面板把 `source` 覆盖成「插件 id / 实例 id」，
 * 这里照约定填 `missav`）——所以不做实例清单那一层。
 *
 * ⚠️ 已知限制：面板转接播放只做 302，**不会**把 `header` 带给客户端；这里照实把 header 报上去。
 */
const settings = require('./lib/settings');
const cache = require('./lib/cache');
const fetcher = require('./lib/fetch');
const parse = require('./lib/parse');
const { encodeRef, decodeRef } = require('./lib/ref');
const pkg = require('./plugin.json');

const PLUGIN_ID = pkg.id;
/** 站点 key（也叫实例 id）：面板侧站点身份按「插件 + 站点 key」记 */
const SITE_KEY = 'missav';
const SITE_NAME = 'MissAV';
/** 线路名：一部片只有这一路 m3u8 */
const LINE_FLAG = 'MissAV';
/** 各动作的兜底超时（面板都会带上自己的值，这几个只是没带时的口径） */
const SEARCH_TIMEOUT_MS = 10000;
const DETAIL_TIMEOUT_MS = 15000;
const PLAY_TIMEOUT_MS = 15000;
/** 自检默认的搜索词（设置页上可改） */
const TEST_WD = 'SSIS-001';

/** 每次动作进来先登记数据目录（缓存与设置都按它定位） */
function useCtx(ctx) {
  if (ctx && ctx.dataDir) settings.setDataDir(ctx.dataDir);
}

/** 超时让面板认出是超时（它与面板约定的判据是 `AbortError`） */
function failFrom(e) {
  if (e && e.name === 'AbortError') return { code: 'TIMEOUT', message: '请求超时' };
  /* fetch 的"fetch failed"本身看不出原因，把底层那层（DNS / TLS / 连接）的码带上，诊断才有据可查 */
  const cause = e && e.cause && (e.cause.code || e.cause.message);
  const msg = (e && e.message) || String(e);
  return { code: (e && e.code) || 'UPSTREAM', message: cause ? `${msg}（${cause}）` : msg };
}

/** macCMS 形状的一条（面板只读 vod_id / vod_name / vod_pic / vod_remarks） */
function toMacRow(x) {
  return { vod_id: x.slug, vod_name: x.name, vod_pic: x.pic, vod_remarks: '' };
}

/**
 * 详情 → 面板要的「线路 → 选集」结构。
 *
 * 一部片一份 m3u8，所以**一条线路、一个播放项**；该项的 `ref` 由插件自己编（面板原样存、播放时原样交回）。
 * `pick = 'items'` 是电影取法（播放项放进 `line.items[]`），否则是剧集取法（放进 `line.target`）。
 * 拿不到 m3u8 时线路为空并在 `note` 里如实说明，不编地址、不编线路。
 */
function buildDetail(p, { pick, pageLink, slug }) {
  const item = () => ({
    flag: LINE_FLAG,
    name: p.name,
    id: slug,
    index: 0,
    matchedBy: 'item',
    ref: encodeRef(PLUGIN_ID, { u: pageLink, c: slug }),
  });

  const lines = [];
  if (p.m3u8) {
    const one = item();
    const line = { flag: LINE_FLAG, episodes: [{ name: p.name, id: slug, index: 0 }], episodeCount: 1 };
    if (pick === 'items') {
      line.items = [one];
      line.target = one;
    } else {
      line.target = one;
    }
    lines.push(line);
  }

  const detail = {
    vodId: slug,
    name: p.name,
    pic: p.pic,
    content: '',
    remarks: '',
    lines,
    lineCount: lines.length,
    target: (lines.find((l) => l.target) || {}).target || null,
  };
  if (pick === 'items') detail.pick = 'items';

  const json = {
    list: [
      {
        vod_id: slug,
        vod_name: p.name,
        vod_pic: p.pic,
        vod_content: '',
        vod_remarks: '',
        vod_play_from: p.m3u8 ? LINE_FLAG : '',
        vod_play_url: p.m3u8 ? `${p.name}$${slug}` : '',
      },
    ],
    page: 1,
    total: 1,
  };

  const note = p.m3u8 ? '' : '影片页里没找到 m3u8（可能该片没有可播地址，或页面结构变了）';
  return { detail, json, note };
}

const actions = {
  /**
   * 站点清单 —— 静态声明"这个插件现在有哪些站点"。
   * `sources` 是实例一行一个（面板取 302 地址与做诊断时要用），`sites` 是站点本身。
   * `api` 只是诊断显示用，面板不再拿它拼请求（请求拼装在插件这边）。
   */
  async sites(args, ctx) {
    useCtx(ctx);
    const cfg = settings.read();
    const t0 = Date.now();
    if (ctx) ctx.log(`站点清单：${SITE_KEY} → ${cfg.siteBase}`);
    return {
      sources: [
        {
          id: SITE_KEY,
          name: SITE_NAME,
          url: cfg.siteBase,
          mode: 'remote',
          enabled: true,
          ok: true,
          ms: Date.now() - t0,
          siteCount: 1,
        },
      ],
      sites: [{ key: SITE_KEY, name: SITE_NAME, api: '/', searchable: true, source: SITE_KEY }],
    };
  },

  /**
   * 候选 —— 打站内搜索页，解析成 macCMS 形状。
   * 带缓存（键含站点基地址，换镜像后自然作别），命中就不打站点。
   * 查询词是番号形状时按番号精确过滤（照第三方脚本，避免搜出一堆近似结果）。
   */
  async search(args, ctx) {
    useCtx(ctx);
    const cfg = settings.read();
    const timeoutMs = Math.max(1000, Number(args.timeoutMs) || SEARCH_TIMEOUT_MS);
    const wd = String(args.wd || '').trim();
    const page = Math.max(1, Number(args.page) || 1);
    const source = SITE_KEY;
    const site = SITE_KEY;
    if (!wd) return { status: 200, ok: true, text: '', json: { list: [], page, total: 0 }, source, site };

    const key = [SITE_KEY, 'search', wd, String(page), cfg.siteBase].join('|');
    const hit = cache.get('upstream', key);
    if (hit) {
      if (ctx) ctx.log(`缓存命中：搜索「${wd}」第 ${page} 页 —— 不打站点`);
      return Object.assign({}, hit, { source, site, cached: true });
    }

    /* 站点的搜索页只认番号那一小段：面板给的却是整条名字（`SSIS-001 女友不在的三天 …`），
     * 拿整串去搜一条都搜不到 ⇒ 先揪出番号再搜，拿到候选后按番号精确过滤。 */
    const code = parse.extractCode(wd);
    const term = code || wd;
    const url = parse.searchUrl(cfg.siteBase, cfg.lang, term, page);
    try {
      const r = await fetcher.getHtml(url, { siteBase: cfg.siteBase, timeout: timeoutMs });
      let rows = parse.parseVideoList(r.text, { siteBase: cfg.siteBase, coverBase: cfg.coverBase });
      if (code) rows = rows.filter((x) => parse.sameCode(x.code, code));
      const json = { list: rows.map(toMacRow), page, total: rows.length };
      const out = { status: r.status, ok: true, text: r.text, json, url, source, site, term };
      cache.put('upstream', key, out, cache.limits().ttlMs);
      return out;
    } catch (e) {
      if (ctx) ctx.log(`搜索失败：「${wd}」— ${(e && e.message) || e}`);
      return { error: failFrom(e), url, source, site };
    }
  },

  /**
   * 取播放项 —— 打影片页，提 m3u8，编成一条线路一个播放项。
   * 缓存的是**页面原文**：命中时不打站点，但照旧重新跑一遍解析（纯函数，结果一致）。
   */
  async detail(args, ctx) {
    useCtx(ctx);
    const cfg = settings.read();
    const timeoutMs = Math.max(1000, Number(args.timeoutMs) || DETAIL_TIMEOUT_MS);
    const pick = args.pick === 'items' ? 'items' : '';
    const source = SITE_KEY;
    const site = SITE_KEY;
    /* `id` 就是搜索回里那个 vod_id（canonical slug），元数据插件与首页插件算出的也是它 */
    const slug = parse.canonicalSlug(args.id);
    if (!slug) return { error: { code: 'BAD_ID', message: `认不出这个影片编号：${String(args.id || '')}` }, source, site };

    const pageLink = parse.pageUrl(cfg.siteBase, cfg.lang, slug);
    const key = [SITE_KEY, 'detail', slug, cfg.siteBase].join('|');
    try {
      let page = cache.get('upstream', key);
      const cached = !!page;
      if (!cached) {
        const r = await fetcher.getHtml(pageLink, { siteBase: cfg.siteBase, timeout: timeoutMs });
        page = { status: r.status, text: r.text };
        cache.put('upstream', key, page, cache.limits().ttlMs);
      } else if (ctx) {
        ctx.log(`缓存命中：详情 ${slug} —— 用缓存里的页面重建 m3u8，不打站点`);
      }
      const p = parse.parseDetail(page.text, { siteBase: cfg.siteBase, coverBase: cfg.coverBase, lang: cfg.lang, slug });
      const built = buildDetail(p, { pick, pageLink, slug });
      const out = {
        status: Number(page.status) || 200,
        ok: true,
        text: page.text,
        json: built.json,
        detail: built.detail,
        detailNote: built.note,
        url: pageLink,
        source,
        site,
      };
      if (cached) out.cached = true;
      return out;
    } catch (e) {
      if (ctx) ctx.log(`取详情失败：${slug} — ${(e && e.message) || e}`);
      return { error: failFrom(e), url: pageLink, source, site };
    }
  },

  /**
   * 解析地址 —— 拿一个 `ref` 换真实的 m3u8。
   * 地址**每次现取**（站点给的 m3u8 带时效），并附上播放请求头（Referer / Origin / UA / Accept）。
   * 面板只负责 302；header 能不能带过去由面板决定（见文件头那条已知限制）。
   */
  async play(args, ctx) {
    useCtx(ctx);
    const cfg = settings.read();
    const timeoutMs = Math.max(1000, Number(args.timeoutMs) || PLAY_TIMEOUT_MS);
    const o = decodeRef(PLUGIN_ID, args.ref);
    if (!o) {
      return { error: { code: 'BAD_REF', message: `认不出这个 ref：${String(args.ref || '').slice(0, 80)}` } };
    }
    const pageLink = String(o.u || '') || parse.pageUrl(cfg.siteBase, cfg.lang, o.c);
    try {
      const r = await fetcher.getHtml(pageLink, { siteBase: cfg.siteBase, timeout: timeoutMs });
      const m3u8 = parse.extractM3u8(r.text);
      if (!m3u8) {
        const e = new Error('影片页里没找到 m3u8');
        e.code = 'NO_PLAY_URL';
        throw e;
      }
      if (ctx) ctx.log(`解析地址：${o.c || pageLink} → ${m3u8}`);
      return {
        ok: true,
        status: 200,
        urls: [m3u8],
        header: parse.buildStreamHeaders(cfg.siteBase, pageLink),
        parse: 0,
        source: SITE_KEY,
        site: SITE_KEY,
      };
    } catch (e) {
      if (ctx) ctx.log(`解析地址失败：${o.c || pageLink} — ${(e && e.message) || e}`);
      return { error: failFrom(e), source: SITE_KEY, site: SITE_KEY };
    }
  },

  /**
   * 站点测速 —— 体检口径的一发：只回答"通不通、多快"，不重试、不解释结果内容。
   * 与「候选」打的是同一个页面，差别在口径：那边是业务取数、这边是量耗时。
   */
  async probe(args, ctx) {
    useCtx(ctx);
    const cfg = settings.read();
    const timeoutMs = Math.max(1000, Number(args.timeoutMs) || SEARCH_TIMEOUT_MS);
    const wd = String(args.wd || '').trim();
    const source = SITE_KEY;
    const site = SITE_KEY;
    if (!wd) return { error: { code: 'BAD_REQUEST', message: '测速需要一个搜索关键词' }, source, site, name: SITE_NAME };
    const url = parse.searchUrl(cfg.siteBase, cfg.lang, wd, 1);
    try {
      const r = await fetcher.getHtml(url, { siteBase: cfg.siteBase, timeout: timeoutMs });
      const rows = parse.parseVideoList(r.text, { siteBase: cfg.siteBase, coverBase: cfg.coverBase });
      const json = { list: rows.map(toMacRow), page: 1, total: rows.length };
      return { status: r.status, ok: true, text: r.text, json, url, source, site, name: SITE_NAME };
    } catch (e) {
      return { error: failFrom(e), url, source, site, name: SITE_NAME };
    }
  },

  /** 插件设置页的后端（面板只转发、不解释，见契约第十一节） */
  async http(args, ctx) {
    useCtx(ctx);
    const method = String(args.method || 'GET').toUpperCase();
    const p = String(args.path || '/').replace(/\/+$/, '') || '/';
    let body = {};
    if (args.body) {
      try {
        body = typeof args.body === 'string' ? JSON.parse(args.body) : args.body;
      } catch {
        return { status: 400, body: { ok: false, error: '请求体不是 JSON' } };
      }
    }
    const ok = (v) => ({ status: 200, body: Object.assign({ ok: true }, v) });
    const bad = (status, message) => ({ status, body: { ok: false, error: message } });
    const state = () => ({
      plugin: { id: pkg.id, name: pkg.name, version: pkg.version },
      settings: settings.read(),
      cacheSettings: settings.cacheCfg(),
      cache: cache.stats(),
      siteKey: SITE_KEY,
    });

    try {
      if (p === '/state' && method === 'GET') return ok(state());

      if (p === '/settings' && method === 'POST') {
        settings.setSite(body);
        return ok(state());
      }

      if (p === '/cache' && method === 'GET') {
        return ok({ cacheSettings: settings.cacheCfg(), cache: cache.stats() });
      }
      if (p === '/cache/clear' && method === 'POST') {
        return ok({ cacheSettings: settings.cacheCfg(), cache: cache.clear(body.table ? String(body.table) : '') });
      }
      if (p === '/cache/settings' && method === 'POST') {
        const next = settings.setCache(body);
        /* 上限调小后立刻淘汰（不然设置页会显示"已用 60MB / 上限 10MB"，看着像坏了） */
        cache.sweep('upstream', { force: true });
        return ok({ cacheSettings: next, cache: cache.stats() });
      }

      if (p === '/test' && method === 'POST') {
        return ok({ result: await selfTest(body) });
      }

      return bad(404, `插件设置页没有这个接口：${method} ${p}`);
    } catch (e) {
      return bad(400, (e && e.message) || String(e));
    }
  },
};

/**
 * 一键自检：按界面上**还没保存**的设置发一发搜索，如实报 `{ok, status, ms, count, 失败原因}`。
 * 只回答"通不通、多快、解析出几条"，不改任何存储。
 */
async function selfTest(body) {
  const cfg = settings.effective(body, settings.read());
  const wd = String((body && body.wd) || TEST_WD).trim() || TEST_WD;
  const url = parse.searchUrl(cfg.siteBase, cfg.lang, wd, 1);
  const t0 = Date.now();
  try {
    const r = await fetcher.getHtml(url, { siteBase: cfg.siteBase, timeout: 12000 });
    const rows = parse.parseVideoList(r.text, { siteBase: cfg.siteBase, coverBase: cfg.coverBase });
    return { ok: true, status: r.status, ms: Date.now() - t0, count: rows.length, wd, url, siteBase: cfg.siteBase };
  } catch (e) {
    return {
      ok: false,
      status: Number(e && e.status) || 0,
      ms: Date.now() - t0,
      wd,
      url,
      siteBase: cfg.siteBase,
      error: (e && e.message) || String(e),
    };
  }
}

module.exports = { actions };