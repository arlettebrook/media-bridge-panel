'use strict';
/**
 * 元数据的**归一化层**（原来住在面板的 `server/modules/emby/tmdb.js`）——
 * 面板要哪些字段、这些字段怎么从 TMDB 的响应里取出来，都在这里；面板不再解析上游。
 *
 * 字段名一律是**域中立的**（契约第六节那份清单）：条目编号叫 `entryId`、类型叫 `type`，
 * 不叫 `tmdbId`。面板侧只把它翻成 Emby 的 DTO（那一层在面板那边，见 [ADR-0007]）。
 *
 * 不抛异常：`{ ok: true, item }` 或 `{ ok: false, error: { code, status?, message } }`
 * —— 与面板原来那份同一个取向（"取不到就如实说，不编占位数据"）。
 */
const client = require('./tmdb');

const TIMEOUT_MS = client.TIMEOUT_MS;
const OVERVIEW_LIMIT = 400; // 列表/占位用：短一点够画卡片
const OVERVIEW_LIMIT_RICH = 2000; // 详情页用：简介本来就该放全

/**
 * `rich` 时一次带回来的子资源（TMDB 的 `append_to_response`）—— **一次请求全拿到，不多打**。
 * `release_dates`（电影分级）与 `content_ratings`（剧分级）是**分开的两个接口**，传错会 400，所以按类型给。
 */
const RICH_APPEND = {
  movie: 'credits,external_ids,keywords,videos,images,recommendations,release_dates',
  tv: 'credits,external_ids,keywords,videos,images,recommendations,content_ratings',
};

/** 分级：电影在 release_dates、剧在 content_ratings；优先美国，没有就取第一个有值的 */
function certificationOf(kind, j) {
  const rows = kind === 'movie' ? ((j.release_dates || {}).results || []) : ((j.content_ratings || {}).results || []);
  const pick = (row) => (kind === 'movie' ? ((row.release_dates || [])[0] || {}).certification : row.rating);
  const us = rows.find((row) => row && row.iso_3166_1 === 'US' && pick(row));
  const any = rows.find((row) => row && pick(row));
  return String(pick(us || any || {}) || '');
}

/** 关键词：电影是 `keywords.keywords[]`，剧是 `keywords.results[]`（TMDB 两处字段形状不一致） */
function keywordsOf(kind, j) {
  const k = j.keywords || {};
  const rows = kind === 'movie' ? k.keywords || [] : k.results || [];
  return rows.map((x) => x && x.name).filter(Boolean);
}

/** 图片列表里挑一张：优先语言匹配，其次"无语言"（多数背景图没标语言），再退第一张 */
function pickImage(rows, lang) {
  const list = (rows || []).filter((x) => x && x.file_path);
  const base = String(lang || '').split('-')[0].toLowerCase();
  return (
    (list.find((x) => String(x.iso_639_1 || '').toLowerCase() === base) || list.find((x) => !x.iso_639_1) || list[0] || {}).file_path || ''
  );
}

const ISO_SUFFIX = 'T00:00:00.0000000Z';

/** TMDB 只给 YYYY-MM-DD，Emby 的 PremiereDate 要完整时间 */
function isoDate(d) {
  const s = String(d || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s + ISO_SUFFIX : '';
}

/** 汉字（含扩展 A 区与兼容区）—— 用来判"这个标题到底是不是中文的" */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/**
 * **给源侧搜索用的标题**：主标题没有中文时，回退到中文别名。
 *
 * 起因（实测 tv/95396 = 人生切割术）：TMDB 的 `zh-CN` **主标题就是英文 "Severance"**，
 * 中文只登记在 `alternative_titles` 里（`人生切割术(CN)`）。而源侧是拿这个名字去搜的 ——
 * 英文名搜出来的中文名条目在**名字硬闸**那关就被拒（中英文没有公共主干），
 * 于是命中源里的空壳条目、客户端一个版本都拿不到。
 *
 * 规则：
 *   ① 语言设置不是中文系 → 不折腾，用主标题；
 *   ② 主标题里已经有汉字 → 那就是中文的，用主标题；
 *   ③ 否则问一次 `/alternative_titles`，取**带汉字**的那条：优先简体地区（CN/SG），再港澳台；
 *   ④ 别名也全是英文（或取不到）→ 保持主标题。
 *
 * 只影响"拿什么名字去搜源"，**不影响显示给客户端的名字**（客户端仍旧看主标题）。
 * 那次别名请求走缓存（`/alternative_titles` 在 META_PATH_RE 里），不会每次详情都打 TMDB。
 */
async function searchTitleOf({ kind, id, c, headers, main }) {
  const title = String(main || '');
  if (!/^zh/i.test(String(c.language || ''))) return title;
  if (CJK_RE.test(title)) return title;
  try {
    const r = await client.requestCached(c.apiBase, `/${kind}/${id}/alternative_titles`, { headers, timeout: TIMEOUT_MS });
    const rows = (r.ok && r.json && r.json.results) || [];
    const zh = rows
      .filter((x) => x && CJK_RE.test(String(x.title || '')))
      .map((x) => ({ title: String(x.title).trim(), region: String(x.iso_3166_1 || '').toUpperCase() }))
      .filter((x) => x.title);
    if (!zh.length) return title;
    /* 简体地区优先（源里的条目名绝大多数是简体），再港澳台，最后其余地区 */
    const rank = (region) => (region === 'CN' || region === 'SG' ? 0 : region === 'TW' || region === 'HK' ? 1 : 2);
    zh.sort((a, b) => rank(a.region) - rank(b.region));
    return zh[0].title;
  } catch {
    /* 别名取不到就当没有 —— 这条路只是"名字更容易对上"，失败不该影响详情本身 */
    return title;
  }
}

/**
 * 反查一个条目 —— 面板的「取元数据」动作就是它。
 *
 * `withSeasons`：把剧的 seasons[] 一并归一化挂到 `item.seasons`（季列表端点用）。
 * 默认关 —— 否则整包季数组会跟着条目一起回给面板，纯噪声。
 * `rich`：详情页要的那一批（标语/时长/分级/演职/公司/关键词/预告/图集/相似），
 * 全部来自**同一次请求**的 append 结果，不额外打 TMDB。
 */
async function lookup({ type = 'tv', tmdbId, rich = false, withSeasons = false } = {}) {
  const c = client.current();
  const kind = type === 'movie' ? 'movie' : 'tv';
  const id = Number.parseInt(tmdbId, 10);
  if (!c.token) return { ok: false, error: { code: 'NO_TOKEN', message: '插件还没填 v4 API Read Access Token' } };
  if (!id) return { ok: false, error: { code: 'BAD_ID', message: '条目 id 不合法：' + tmdbId } };

  const headers = { Authorization: 'Bearer ' + c.token, Accept: 'application/json' };
  const qs = [`language=${encodeURIComponent(c.language)}`];
  if (rich) {
    qs.push(`append_to_response=${RICH_APPEND[kind]}`);
    /* TMDB 的坑：一旦同时给了 `language` 和 `images`，它会把 images **按语言过滤** ——
     * logo 一定带语言标记、背景图大多不带，结果**两边都空**。必须显式把"无语言"那批要回来。
     * （依据：TMDB 文档里 `include_image_language: ["null","en"]` 的例子，不给就 0 张背景。） */
    qs.push(`include_image_language=${encodeURIComponent('null,' + String(c.language).split('-')[0])}`);
  }

  let r;
  try {
    r = await client.requestCached(c.apiBase, `/${kind}/${id}?${qs.join('&')}`, { headers, timeout: TIMEOUT_MS });
  } catch (e) {
    return { ok: false, error: client.classify(e) };
  }
  if (r.status === 401 || r.status === 403) {
    return { ok: false, error: { code: 'INVALID_TOKEN', status: r.status, message: `Token 无效或无权限（HTTP ${r.status}）` } };
  }
  if (r.status === 404) {
    return { ok: false, error: { code: 'NOT_FOUND', status: 404, message: `TMDB 里没有这个 ${kind} id=${id}` } };
  }
  if (!r.ok) {
    return { ok: false, error: { code: 'UPSTREAM_HTTP', status: r.status, message: 'TMDB 返回 HTTP ' + r.status } };
  }

  const j = r.json || {};
  const date = j.first_air_date || j.release_date || '';
  const item = {
    entryId: j.id || id,
    type: kind,
    title: j.name || j.title || '',
    originalTitle: j.original_name || j.original_title || '',
    year: date ? String(date).slice(0, 4) : '',
    premiereDate: isoDate(date),
    overview: String(j.overview || '').slice(0, rich ? OVERVIEW_LIMIT_RICH : OVERVIEW_LIMIT),
    posterPath: j.poster_path || '',
    backdropPath: j.backdrop_path || '',
    genres: (j.genres || []).map((g) => g && g.name).filter(Boolean),
    /* 类型带 TMDB 的 id：给客户端做 `GenreItems` 用（能进入该类型）—— 早期只返回名字，因此点不进去 */
    genreItems: (j.genres || []).filter(Boolean).map((g) => ({ id: String(g.id), name: g.name })),
    seasonCount: Number(j.number_of_seasons) || 0,
    communityRating: Number(j.vote_average) || 0,
  };

  /* 拿什么名字去源里搜：主标题没中文时回退中文别名（规则与原因见 searchTitleOf）。
   * 它与 `title`（显示给客户端的名字）**分开**：客户端还是看主标题。 */
  item.searchTitle = await searchTitleOf({ kind, id, c, headers, main: item.title });

  if (rich) {
    const imgs = j.images || {};
    const vids = (j.videos || {}).results || [];
    const credits = j.credits || {};
    const ext = j.external_ids || {};

    item.tagline = String(j.tagline || '');
    item.status = String(j.status || '');
    item.homepage = String(j.homepage || '');
    item.runtimeMinutes = kind === 'movie' ? Number(j.runtime) || 0 : Number((j.episode_run_time || [])[0]) || 0;
    item.certification = certificationOf(kind, j);
    /* 公司 **id 必须留着**：真机的 `Studios[]` 是 `NameLongIdPair`（`{Id, Name}`，Id 是**数字**）；
     * 早期实现只留 name、把 id 丢了 —— 客户端模型里 `Id` 若是非可选，缺键会让**整个响应解码失败**。 */
    item.productionCompanies = (j.production_companies || [])
      .map((x) => x && { id: Number(x.id) || 0, name: String(x.name || '') })
      .filter((x) => x && x.name);
    item.productionCountries = (j.production_countries || []).map((x) => x && x.name).filter(Boolean);
    item.keywords = keywordsOf(kind, j);
    item.externalIds = { imdb: ext.imdb_id || '', tvdb: ext.tvdb_id ? String(ext.tvdb_id) : '', wikidata: ext.wikidata_id || '' };

    /* 演职人员：演员取前 20（按 order），幕后只要导演/编剧 —— 客户端的那条横滑就靠它 */
    item.cast = (credits.cast || [])
      .slice()
      .sort((a, b) => (Number(a && a.order) || 0) - (Number(b && b.order) || 0))
      .slice(0, 20)
      .map((p) => ({ personId: p && p.id, name: (p && p.name) || '', role: (p && p.character) || '', profilePath: (p && p.profile_path) || '' }))
      .filter((p) => p.name);
    item.crew = (credits.crew || [])
      .filter((p) => p && ['Director', 'Writer', 'Screenplay', 'Story'].includes(p.job))
      .slice(0, 20)
      .map((p) => ({ personId: p.id, name: p.name || '', job: p.job || '', profilePath: p.profile_path || '' }))
      .filter((p) => p.name);

    item.trailers = vids
      .filter((v) => v && v.site === 'YouTube' && v.key && /Trailer|Teaser/i.test(String(v.type || '')))
      .slice(0, 5)
      .map((v) => ({ name: v.name || '预告片', url: 'https://www.youtube.com/watch?v=' + v.key }));

    item.logoPath = pickImage(imgs.logos, c.language);
    item.backdropPaths = (imgs.backdrops || []).map((b) => b && b.file_path).filter(Boolean).slice(0, 8);

    /* 相似推荐：`/Similar` 端点直接用这一份（同一个接口就有，不用再打一次） */
    item.recommendations = (((j.recommendations || {}).results) || [])
      .slice(0, 20)
      .map((x) => {
        const d = String(x.release_date || x.first_air_date || '');
        return {
          entryId: x.id,
          type: kind,
          title: x.title || x.name || '',
          year: d ? d.slice(0, 4) : '',
          overview: String(x.overview || '').slice(0, OVERVIEW_LIMIT),
          posterPath: x.poster_path || '',
          backdropPath: x.backdrop_path || '',
          communityRating: Number(x.vote_average) || 0,
        };
      })
      .filter((x) => x.entryId && x.title);
  }

  /* TMDB 的 seasons[]：air_date / episode_count / id / name / overview / poster_path / season_number / vote_average
   * 注意 name 是本地化文案（zh-CN 下特别篇叫「特别篇」）→ 判特别篇只能看 season_number，不能认 name。 */
  if (withSeasons) {
    item.seasons = (j.seasons || []).map((s) => {
      const air = String(s.air_date || '');
      const num = Number(s.season_number);
      return {
        seasonNumber: Number.isFinite(num) ? num : null,
        name: s.name || '',
        overview: String(s.overview || '').slice(0, OVERVIEW_LIMIT),
        posterPath: s.poster_path || '',
        episodeCount: Number(s.episode_count) || 0,
        year: air ? air.slice(0, 4) : '',
        premiereDate: isoDate(air),
        rating: Number(s.vote_average) || 0,
      };
    });
  }

  return { ok: true, item };
}

/**
 * 反查某一季的分集 —— `GET /tv/{id}/season/{n}`（season 端点，与条目接口是两个不同接口）。
 * 取分集**只能走这个接口**：剧的 `/tv/{id}` 只给 seasons[] 汇总，没有 episodes[]。
 * 与 lookup() 同一取向：不抛异常。
 */
async function lookupSeason({ tmdbId, season } = {}) {
  const c = client.current();
  const id = Number.parseInt(tmdbId, 10);
  const n = Number.parseInt(season, 10);
  if (!c.token) return { ok: false, error: { code: 'NO_TOKEN', message: '插件还没填 v4 API Read Access Token' } };
  if (!id) return { ok: false, error: { code: 'BAD_ID', message: '条目 id 不合法：' + tmdbId } };
  if (!Number.isFinite(n) || n < 0) return { ok: false, error: { code: 'BAD_ID', message: '季号不合法：' + season } };

  const headers = { Authorization: 'Bearer ' + c.token, Accept: 'application/json' };
  let r;
  try {
    r = await client.requestCached(c.apiBase, `/tv/${id}/season/${n}?language=${encodeURIComponent(c.language)}`, {
      headers,
      timeout: TIMEOUT_MS,
    });
  } catch (e) {
    return { ok: false, error: client.classify(e) };
  }
  if (r.status === 401 || r.status === 403) {
    return { ok: false, error: { code: 'INVALID_TOKEN', status: r.status, message: `Token 无效或无权限（HTTP ${r.status}）` } };
  }
  if (r.status === 404) {
    return { ok: false, error: { code: 'NOT_FOUND', status: 404, message: `TMDB 里没有这一季：tv ${id} S${n}` } };
  }
  if (!r.ok) {
    return { ok: false, error: { code: 'UPSTREAM_HTTP', status: r.status, message: 'TMDB 返回 HTTP ' + r.status } };
  }

  const j = r.json || {};
  /* TMDB 的 episode：air_date / episode_number / name / overview / runtime / still_path / vote_average
   * runtime 可能是 null（未定档），此时不编时长。 */
  const episodes = (j.episodes || []).map((e) => {
    const air = String(e.air_date || '');
    const num = Number(e.episode_number);
    const runtime = Number(e.runtime);
    return {
      episodeNumber: Number.isFinite(num) ? num : null,
      name: e.name || '',
      overview: String(e.overview || '').slice(0, OVERVIEW_LIMIT),
      year: air ? air.slice(0, 4) : '',
      premiereDate: isoDate(air),
      stillPath: e.still_path || '',
      rating: Number(e.vote_average) || 0,
      runtimeMinutes: Number.isFinite(runtime) && runtime > 0 ? runtime : 0,
    };
  });

  const seasonNumber = Number(j.season_number);
  return {
    ok: true,
    item: {
      entryId: Number(j.id) || id,
      seasonNumber: Number.isFinite(seasonNumber) ? seasonNumber : n,
      name: j.name || '',
      overview: String(j.overview || '').slice(0, OVERVIEW_LIMIT),
      posterPath: j.poster_path || '',
      episodes,
    },
  };
}

/**
 * 按名字搜索 —— `search/tv` 或 `search/movie`，归一成候选列表（每项带 `entryId`）。
 * 查不到回空数组；失败**照实抛**（调用方决定是否降级）。走 `lib/tmdb.js` 的 `search()`，
 * 那里有「名字 → 结果」的落盘缓存，负结果不存。
 */
async function search(type, name, page) {
  const kind = type === 'movie' ? 'movie' : 'tv';
  const rows = await client.search(kind, name, { page });
  return (rows || [])
    .map((x) => {
      const d = String(x.release_date || x.first_air_date || '');
      return {
        entryId: x.id,
        type: kind,
        title: x.title || x.name || '',
        originalTitle: x.original_title || x.original_name || '',
        year: d ? d.slice(0, 4) : '',
        overview: String(x.overview || '').slice(0, OVERVIEW_LIMIT),
        posterPath: x.poster_path || '',
        backdropPath: x.backdrop_path || '',
        communityRating: Number(x.vote_average) || 0,
      };
    })
    .filter((x) => x.entryId && x.title);
}

module.exports = {
  TIMEOUT_MS,
  DEFAULT_PROBE: client.DEFAULT_PROBE,
  OVERVIEW_LIMIT,
  OVERVIEW_LIMIT_RICH,
  RICH_APPEND,
  certificationOf,
  keywordsOf,
  pickImage,
  isoDate,
  searchTitleOf,
  lookup,
  lookupSeason,
  search,
};
