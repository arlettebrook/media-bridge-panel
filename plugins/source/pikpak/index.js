'use strict';
/**
 * PikPak 磁力 · 片源插件入口（动作层）
 *
 * 契约见 docs/plugin-contract.md 第五节。这个插件把「磁力站 + 网盘」拼成一个站接进来：
 *
 *   sites   站点清单     —                        这个插件现在有哪些站点（一个）
 *   search  候选         {source,key,wd,page}      磁力站搜索页 → macCMS 形状的列表
 *   detail  取播放项     {source,key,id,season,episode,pick}
 *                                                  下载磁力站的 `.torrent`、解出里面的文件清单
 *                                                  （**不碰网盘、不落盘** —— 保存推迟到播放那一刻）
 *   play    解析地址     {ref,clientHost}          一个 ref → 带签名的直连地址 + 请求头
 *   probe   站点测速     {source,key,wd}           体检口径的一发（不重试、不看内容）
 *   http    webui 后端   {method,path,query,body}  插件自己设置页的后端
 *
 * 取数动作的返回形状刻意与面板原来那份上游响应逐字段对齐（`{status,ok,text,json}` 或
 * `{error:{code,message}}`），面板那套「搜不到怎么算、超时怎么报」的判据一个字都不用改。
 * `detail` 另带 `detail:{lines,…}` 与 `detailNote`，`play` 另带 `urls/header/parse`。
 *
 * 站点只有一个、实例 id 也就是 `pikpak`，所以不做实例清单那一层。
 *
 * ⚠️ 两条如实交代的限制：
 *   · 面板转接播放只做 302，**不会**把 `header` 带给客户端 —— 这里照实把 header 报上去；
 *   · 离线下载要时间。保存推迟到**播放那一刻**：面板一次调用总预算 60 秒，
 *     `play` 最多等这么久，等不到就**如实说「还没下完、稍后再点一次」**，不编地址。
 */
const settings = require('./lib/settings');
const cache = require('./lib/cache');
const fetcher = require('./lib/fetch');
const magnet = require('./lib/magnet');
const torrent = require('./lib/torrent');
const pikpak = require('./lib/pikpak');
const video = require('./lib/video');
const { encodeCandidate, decodeCandidate, encodeRef, decodeRef } = require('./lib/ref');
const { CHROME_UA } = require('./lib/fetch');
const pkg = require('./plugin.json');

const PLUGIN_ID = pkg.id;
/** 站点 key（也叫实例 id）：面板侧站点身份按「插件 + 站点 key」记 */
const SITE_KEY = 'pikpak';
const SITE_NAME = 'PikPak 磁力';
/** 线路名：一次 detail 出来的正片都在这一路上 */
const LINE_FLAG = 'PikPak';
/** 各动作的兜底超时（面板都会带上自己的值，这几个只是没带时的口径） */
const SEARCH_TIMEOUT_MS = 15000;
const DETAIL_TIMEOUT_MS = 55000;
const PLAY_TIMEOUT_MS = 20000;
/** 单次搜索最多回多少条候选（面板还要打分，不必全给） */
const MAX_ROWS = 50;
/** 自检默认的搜索词（设置页上可改） */
const TEST_WD = 'SSIS-001';

/** 每次动作进来先登记数据目录（缓存、设置与凭据都按它定位） */
function useCtx(ctx) {
  if (ctx && ctx.dataDir) settings.setDataDir(ctx.dataDir);
}

/** 超时让面板认出是超时（它与面板约定的判据是 `AbortError`） */
function failFrom(e) {
  if (e && e.name === 'AbortError') return { code: 'TIMEOUT', message: '请求超时' };
  /* fetch 的「fetch failed」本身看不出原因，把底层那层（DNS / TLS / 连接）的码带上，诊断才有据可查 */
  const cause = e && e.cause && (e.cause.code || e.cause.message);
  const msg = (e && e.message) || String(e);
  return { code: (e && e.code) || 'UPSTREAM', message: cause ? `${msg}（${cause}）` : msg };
}

function httpErr(status) {
  const e = new Error(`磁力站回 HTTP ${status}`);
  e.code = 'UPSTREAM_HTTP';
  e.status = status;
  return e;
}

/** macCMS 形状的一条（面板只读 vod_id / vod_name / vod_pic / vod_remarks） */
function toMacRow(x) {
  const marks = [x.sizeText || magnet.sizeText(x.size), x.seeders ? `S:${x.seeders}` : '']
    .filter(Boolean)
    .join(' · ');
  return {
    /* `v` 是种子编号（`/view/<id>` 里那个数字）—— 取详情时靠它去拉 `.torrent` 解文件清单。
     * 没有它（解析时站点没给标题链接）就退到「交给 PikPak 离线下载」那条老路。 */
    vod_id: encodeCandidate({ m: x.magnet, t: x.title, s: x.size, d: x.seeders, v: x.torrentId }),
    vod_name: x.title,
    vod_pic: '',
    vod_remarks: marks,
  };
}

/** 磁力链接里的种子名（`dn=` 参数）—— 候选标题缺失时的兜底 */
function magnetTitle(link) {
  const m = /[?&]dn=([^&]+)/i.exec(String(link || ''));
  if (!m) return '';
  try {
    return decodeURIComponent(m[1].replace(/\+/g, ' '));
  } catch {
    return m[1];
  }
}

/**
 * 离线下载建的**目录名**：番号（或种子根目录名）+ 种子指纹。
 *
 * 为什么不能只用番号：一个番号下常常挂着好几条不同清晰度的种子，而它们**种子内的根目录名一模一样**
 * （实测 1080p 与 720p 那两个种子的根目录都叫 `DLDSS-559`）。只用番号当键，后一条就会命中前一条
 * 建好的文件夹、直接播了前一条的文件 —— 「点 720p 播出来的其实是 1080p」就是这么来的。
 * 带上磁力的 info hash 之后，一条磁力一个目录：不同清晰度不串台，同一条磁力重复播放仍能复用。
 */
function folderNameOf(o, title) {
  const base = String((o && o.r) || title || '').trim() || '磁力链接';
  const btih = magnet.btihOf(o && o.m);
  return btih ? `${base} [${btih.slice(0, 8)}]` : base;
}

/** 新命名（尾缀 `[8 位指纹]`）—— 用来区分"改版后建的目录"与"改版前留下的老目录" */
const NEW_DIR_RE = /\[[0-9a-f]{8}\]$/i;

/**
 * 比对用的目录名归一：先摘掉 PikPak 自动加的同名后缀 `(1)` `(2)`…
 * （不然第一次提交建的目录，下一轮就认不出自己了 —— `DLDSS-555` 与 `DLDSS-555(1)` 曾经并存了四份）。
 */
const folderKey = (name) => video.nameKey(String(name || '').replace(/\s*\(\d+\)\s*$/, ''));

/** 保存目录里按名字找已有的那个文件夹（有就不重复下载 —— 省时间也省风控） */
async function existingFolderId(saveDirId, wantName, opts) {
  const want = folderKey(wantName);
  if (!want) return '';
  const files = await pikpak.listFiles(saveDirId, opts);
  const hit = files.find((f) => f.kind === 'drive#folder' && folderKey(f.name) === want);
  return hit ? hit.id || hit.id_ || '' : '';
}

/** 老目录最多查几个（逐个要列一次目录，多了就慢） */
const LEGACY_DIR_MAX = 3;

/**
 * 改版前留下的老目录（名字只有番号、没有指纹）—— **必须按内容确认**才复用。
 *
 * 一个番号下可能有老目录好几个（`DLDSS-555`、`DLDSS-555(1)`…），而且里面躺着哪条清晰度是不知道的：
 * 只看名字就复用，正是这次要修的那个串台。所以列进去、按**要播的那个文件名**（`o.n`）对一下，
 * 里面有它才认；没有就当这条磁力还没下载过，走后面的提交。
 */
async function legacyFolderWithFile(saveDirId, o, title, opts) {
  const wantFolder = video.nameKey(String((o && o.r) || title || '').trim());
  const wantFile = video.nameKey(o && o.n);
  if (!wantFolder || !wantFile) return '';
  let files = [];
  try {
    files = await pikpak.listFiles(saveDirId, opts);
  } catch {
    return '';
  }
  const cands = files
    .filter((f) => f.kind === 'drive#folder' && !NEW_DIR_RE.test(String(f.name || '').trim()) && folderKey(f.name) === wantFolder)
    .slice(0, LEGACY_DIR_MAX);
  for (const f of cands) {
    const id = f.id || f.id_ || '';
    if (!id) continue;
    let inner = [];
    try {
      // eslint-disable-next-line no-await-in-loop
      inner = await pikpak.listFiles(id, opts);
    } catch {
      continue;
    }
    if (inner.some((x) => x.kind !== 'drive#folder' && video.nameKey(x.name) === wantFile)) return id;
  }
  return '';
}

/** 新目录 → 老目录，两级都找一遍（老目录那级要按内容确认，见上） */
async function findExistingFolder(saveDirId, o, title, opts) {
  try {
    const hit = await existingFolderId(saveDirId, folderNameOf(o, title), opts);
    if (hit) return hit;
    return await legacyFolderWithFile(saveDirId, o, title, opts);
  } catch {
    /* 查已有资源是提速用的，查不动就当没有 */
    return '';
  }
}

/**
 * 磁力站的 `.torrent` → 文件清单（**不碰网盘**）。
 * 拿候选里那个种子编号去下种子、bencode 解出每个文件，再按「挑正片」的判据选。
 * 这是详情阶段的主路：到这一步为止，PikPak 那边一个文件都没有。
 */
async function itemsFromTorrent(cfg, torrentId, title, opts) {
  const url = torrent.torrentUrl(cfg.sukebeiBase, torrentId);
  const r = await fetcher.request(url, { headers: fetcher.pageHeaders(cfg.sukebeiBase), timeout: opts && opts.timeout });
  if (!r.ok) throw httpErr(r.status);
  const parsed = torrent.filesOf(torrent.bdecode(r.bytes));
  const keywords = video.extractKeywords(title);
  const vids = parsed.files
    .filter((f) => video.isVideoFile(f.name))
    .map((f) => ({ id: f.path, name: f.name, size: f.size, score: video.scoreFileName(f.name, keywords) }));
  const items = video.pickVideos(vids, keywords);
  const note = items.length
    ? `文件清单来自磁力站的种子（没有提交离线下载）：共 ${parsed.files.length} 个文件，其中 ${items.length} 个视频`
    : `磁力站的种子里没有可播的视频文件（共 ${parsed.files.length} 个文件）`;
  return { root: parsed.root, items, note };
}

/**
 * 老路（候选里没有种子编号时的兜底）：交给 PikPak 离线下载、等完成、再从网盘里挑正片。
 * 只在旧候选 / 旧缓存行上走到这里；新候选一律走种子那条。
 */
async function itemsFromDrive(cfg, link, title, opts, budgetMs) {
  await pikpak.ensureLogin(opts);
  const saveDirId = await pikpak.ensureSaveDir(opts);
  /* 留 5 秒给「列目录 + 挑文件」，剩下的才是等下载的时间 */
  const deadlineAt = Date.now() + Math.max(3000, Math.min(cfg.waitSeconds * 1000, budgetMs - 5000));

  let fileId = '';
  let note = '';
  /* 老路这一步还不知道"要播哪个文件"（挑正片是下面 `videosOf` 的事），所以老目录那级
   * 的按内容确认走不了，只按新命名找 —— 找不到就照旧提交一次，不额外冒险复用。 */
  fileId = await findExistingFolder(saveDirId, { m: link, r: title }, title, opts);
  if (fileId) {
    note = '用的是保存目录里已有的同一资源（这次没有重复下载）';
  } else {
    const sub = await pikpak.submitMagnet(link, folderNameOf({ m: link, r: title }, title), saveDirId, opts);
    if (sub.fileId) {
      fileId = sub.fileId;
      note = '这个磁力已在 PikPak 云端，直接取回';
    } else if (sub.taskId) {
      fileId = await pikpak.waitTask(sub.taskId, deadlineAt, opts);
      if (!fileId) note = `磁力已提交（任务 ${sub.taskId}），离线下载还没完成 —— 稍后再点一次即可`;
    } else {
      note = '磁力提交后 PikPak 没回任务，也没有回文件';
    }
  }
  const vids = fileId ? await video.videosOf(fileId, title, opts) : [];
  return { items: vids.map((v) => ({ id: v.id, name: v.name, size: v.size })), note };
}

/**
 * 一个「还没落盘」的播放项 → PikPak 文件 id。
 * 到**播放这一刻**才提交离线下载：保存目录里已有同一份就直接用，没有才提交、等完成，
 * 再拿当初那份文件清单里的文件名回网盘里对。等不到就如实抛（不编地址）。
 */
async function ensureDownloaded(o, timeoutMs) {
  const cfg = settings.read();
  const title = String(o.r || o.n || '').trim() || magnetTitle(o.m) || '磁力链接';
  const loginOpts = { timeout: Math.max(5000, timeoutMs - 5000) };
  await pikpak.ensureLogin(loginOpts);
  const saveDirId = await pikpak.ensureSaveDir(loginOpts);

  /* 目录名带种子指纹，**老目录必须按内容对得上才复用**（理由见 `folderNameOf` / `legacyFolderWithFile`） */
  const dirName = folderNameOf(o, title);
  let folderId = await findExistingFolder(saveDirId, o, title, loginOpts);
  if (!folderId) {
    const sub = await pikpak.submitMagnet(o.m, dirName, saveDirId, { timeout: Math.max(10000, timeoutMs - 15000) });
    if (sub.fileId) {
      folderId = sub.fileId;
    } else if (sub.taskId) {
      const deadlineAt = Date.now() + Math.max(5000, timeoutMs - 15000);
      folderId = await pikpak.waitTask(sub.taskId, deadlineAt, loginOpts);
      if (!folderId) {
        const e = new Error('离线下载还没完成 —— 稍后再点一次播放');
        e.code = 'NOT_READY';
        throw e;
      }
    } else {
      const e = new Error('磁力提交后 PikPak 没回任务，也没有回文件');
      e.code = 'NO_TASK';
      throw e;
    }
  }

  const one = await video.findVideoOf(folderId, o.n, title, { timeout: Math.max(5000, timeoutMs - 10000) });
  if (!one) {
    const e = new Error(`网盘里没找到这个视频文件：${String(o.n || '').slice(0, 60)}`);
    e.code = 'NOT_FOUND';
    throw e;
  }
  return one.id;
}

/** 播放请求头：PikPak 的直链要带 Referer 才放行（面板转 302 时不转发，见文件头那条限制） */
function playHeaders() {
  return {
    'User-Agent': CHROME_UA,
    Accept: '*/*',
    Referer: 'https://drive.mypikpak.com/',
    Origin: 'https://drive.mypikpak.com',
  };
}

const actions = {
  /**
   * 站点清单 —— 静态声明「这个插件现在有哪些站点」。
   * `sources` 是实例一行一个（面板取 302 地址与做诊断时要用），`sites` 是站点本身。
   */
  async sites(args, ctx) {
    useCtx(ctx);
    const cfg = settings.read();
    const t0 = Date.now();
    if (ctx) ctx.log(`站点清单：${SITE_KEY} → ${cfg.sukebeiBase}`);
    return {
      sources: [
        {
          id: SITE_KEY,
          name: SITE_NAME,
          url: cfg.sukebeiBase,
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
   * 候选 —— 打磁力站的搜索页，解析成 macCMS 形状。
   * 带缓存（键含站点基地址，换镜像后自然作别），命中就不打站点。
   * 搜索词是番号形状时只拿番号那一小段去搜，再按分词全包含过滤（照第三方脚本）。
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

    /* 面板给的常是整条名字（`SSIS-001 女友不在的三天 …`），拿整串去搜一条都搜不到 ⇒
     * 先揪出番号再搜；`-` 换空格是磁力站那边的口味（连字符匹配不佳）。 */
    const term = (magnet.extractCode(wd) || wd).replace(/-/g, ' ');
    const url = magnet.searchUrl(cfg.sukebeiBase, term, page);
    const key = [SITE_KEY, 'search', term, String(page), cfg.sukebeiBase].join('|');
    const hit = cache.get('upstream', key);
    if (hit) {
      if (ctx) ctx.log(`缓存命中：搜索「${term}」第 ${page} 页 —— 不打站点`);
      return Object.assign({}, hit, { source, site, cached: true });
    }

    try {
      const r = await fetcher.getHtml(url, { base: cfg.sukebeiBase, timeout: timeoutMs });
      if (!r.ok) throw httpErr(r.status);
      const rows = magnet
        .rank(magnet.filterByTokens(magnet.parseRows(r.text), term), term)
        .slice(0, MAX_ROWS);
      const json = { list: rows.map(toMacRow), page, total: rows.length };
      const out = { status: r.status, ok: true, text: r.text, json, url, source, site, term };
      cache.put('upstream', key, out, cache.limits().ttlMs);
      if (ctx) ctx.log(`搜索「${term}」：磁力站回 ${rows.length} 条候选`);
      return out;
    } catch (e) {
      if (ctx) ctx.log(`搜索失败：「${term}」— ${(e && e.message) || e}`);
      return { error: failFrom(e), url, source, site, term };
    }
  },

  /**
   * 取播放项 —— 磁力 → **文件清单** → 「线路 → 播放项」。
   *
   * 主路**不碰 PikPak**：拿候选里的种子编号去磁力站拉 `.torrent`，bencode 解出里面的文件，
   * 再按「挑正片」的判据选（不提交离线下载、不占网盘空间）。只有旧候选（没有种子编号）
   * 才退回「交给 PikPak 离线下载、等完成、列目录挑正片」那条老路。
   *
   * 播放项的 `ref` 分两种：种子来的只带**磁力 + 种子内的路径 + 文件名**（网盘里还没有它，
   * 保存推迟到播放那一刻）；老路来的带网盘文件 id。
   */
  async detail(args, ctx) {
    useCtx(ctx);
    const cfg = settings.read();
    const budgetMs = Math.max(5000, Math.min(Number(args.timeoutMs) || DETAIL_TIMEOUT_MS, DETAIL_TIMEOUT_MS));
    const source = SITE_KEY;
    const site = SITE_KEY;
    const item = decodeCandidate(args.id);
    if (!item) {
      return { error: { code: 'BAD_ID', message: `认不出这个条目编号：${String(args.id || '').slice(0, 60)}` }, source, site };
    }
    const title = String(item.t || '').trim() || magnetTitle(item.m) || '磁力链接';
    const pick = args.pick === 'items' ? 'items' : '';
    const opts = { timeout: Math.max(5000, budgetMs - 3000) };

    try {
      let picked = [];
      let note = '';
      if (item.v) {
        const from = await itemsFromTorrent(cfg, item.v, title, {
          timeout: Math.min(15000, Math.max(3000, budgetMs - 2000)),
        });
        note = from.note;
        picked = from.items.map((x, i) =>
          Object.assign(
            {
              flag: LINE_FLAG,
              name: x.name,
              id: x.id,
              index: i,
              matchedBy: 'item',
              /* 这一项**不带网盘文件 id** —— 网盘里还没有它；ref 里放磁力与种子内路径，
               * 播放时才按它去提交、定位、取地址。 */
              ref: encodeRef(PLUGIN_ID, { m: item.m, r: from.root, p: x.id, n: x.name, s: x.size }),
              /* 体积是 bencode 解出来的字节数，准的；分辨率 / 编码 / 动态范围这些从**发布标题**
               * 读 —— 种子里的**文件名**通常不写规格，面板那套"从集名猜"的兜底在这条路上猜不到。
               * 发布标题里没写的项**不出现**，留给面板照旧拿文件名兜底（口径：插件给的优先）。 */
              sizeBytes: Number(x.size) || 0,
            },
            magnet.specOf(title, x.name)
          )
        );
      } else {
        const from = await itemsFromDrive(cfg, item.m, title, opts, budgetMs);
        note = from.note;
        picked = from.items.map((x, i) =>
          Object.assign(
            {
              flag: LINE_FLAG,
              name: x.name,
              id: x.id,
              index: i,
              matchedBy: 'item',
              ref: encodeRef(PLUGIN_ID, { f: x.id, n: x.name }),
              /* 老路同一口径：网盘 files 列表里的字节数是准的；规格同样从**发布标题**读
               * （见上面种子那条的说明）。 */
              sizeBytes: Number(x.size) || 0,
            },
            magnet.specOf(title, x.name)
          )
        );
      }

      const lines = [];
      if (picked.length) {
        const line = {
          flag: LINE_FLAG,
          episodes: picked.map((x) => ({ name: x.name, id: x.id, index: x.index })),
          episodeCount: picked.length,
          target: picked[0],
        };
        if (pick === 'items') line.items = picked;
        lines.push(line);
      }

      const detail = {
        vodId: String(args.id || ''),
        name: title,
        pic: '',
        content: '',
        remarks: '',
        lines,
        lineCount: lines.length,
        target: picked[0] || null,
      };
      if (pick === 'items') detail.pick = 'items';

      const json = {
        list: [
          {
            vod_id: String(args.id || ''),
            vod_name: title,
            vod_pic: '',
            vod_content: '',
            vod_remarks: '',
            vod_play_from: picked.length ? LINE_FLAG : '',
            vod_play_url: picked.map((x) => `${x.name}$${x.id}`).join('#'),
          },
        ],
        page: 1,
        total: 1,
      };

      const detailNote = picked.length ? note : note || '这个资源里没解析出可播的视频文件';
      if (ctx) ctx.log(`取播放项：${title} → ${picked.length} 个视频文件${note ? `（${note}）` : ''}`);
      return { status: 200, ok: true, text: '', json, detail, detailNote, url: magnet.searchUrl(cfg.sukebeiBase, '', 1), source, site, title };
    } catch (e) {
      if (ctx) ctx.log(`取播放项失败：${title} — ${(e && e.message) || e}`);
      return { error: failFrom(e), source, site, title };
    }
  },

  /**
   * 解析地址 —— 拿一个 `ref` 换 PikPak 的直连地址。
   *
   * `ref` 里没有网盘文件 id（种子来的播放项）时，**到这一刻才**提交离线下载：
   * 保存目录已有同一份就直接用，没有才提交、等完成、按文件名定位，再取地址。
   * 地址走**短窗口缓存**（见 `lib/pikpak.js` 的 `PLAY_URL_TTL_MS`）：一次播放里连番的拉流
   * 复用同一条地址，不再每次都重新解析、每次都换 CDN 节点；窗口过了才现取。
   * 并附上播放请求头。
   */
  async play(args, ctx) {
    useCtx(ctx);
    const timeoutMs = Math.max(1000, Number(args.timeoutMs) || PLAY_TIMEOUT_MS);
    const o = decodeRef(PLUGIN_ID, args.ref);
    if (!o) {
      return { error: { code: 'BAD_REF', message: `认不出这个 ref：${String(args.ref || '').slice(0, 80)}` } };
    }
    try {
      if (o.f) await pikpak.ensureLogin({ timeout: Math.max(5000, timeoutMs - 3000) });
      const fileId = o.f || (await ensureDownloaded(o, timeoutMs));
      const one = await pikpak.getPlayUrl(fileId, { timeout: timeoutMs });
      if (!one) {
        const e = new Error('PikPak 没有给出播放地址（文件可能已被删或还在转码）');
        e.code = 'NO_PLAY_URL';
        throw e;
      }
      if (ctx) ctx.log(`解析地址${one.cached ? '（缓存命中）' : ''}：${o.n || fileId} → ${one.url.slice(0, 80)}…`);
      return {
        ok: true,
        status: 200,
        urls: [one.url],
        header: playHeaders(),
        parse: 0,
        name: one.name || o.n || '',
        source: SITE_KEY,
        site: SITE_KEY,
      };
    } catch (e) {
      if (ctx) ctx.log(`解析地址失败：${o.n || o.f} — ${(e && e.message) || e}`);
      return { error: failFrom(e), source: SITE_KEY, site: SITE_KEY };
    }
  },

  /**
   * 站点测速 —— 体检口径的一发：只回答「通不通、多快」，不重试、不解释结果内容。
   * 测的是磁力站这一发（PikPak 那边要登录，不适合放进体检）。
   */
  async probe(args, ctx) {
    useCtx(ctx);
    const cfg = settings.read();
    const timeoutMs = Math.max(1000, Number(args.timeoutMs) || SEARCH_TIMEOUT_MS);
    const source = SITE_KEY;
    const site = SITE_KEY;
    const wd = String(args.wd || '').trim();
    if (!wd) {
      return { error: { code: 'BAD_REQUEST', message: '测速需要一个搜索关键词' }, source, site, name: SITE_NAME };
    }
    const term = (magnet.extractCode(wd) || wd).replace(/-/g, ' ');
    const url = magnet.searchUrl(cfg.sukebeiBase, term, 1);
    try {
      const r = await fetcher.getHtml(url, { base: cfg.sukebeiBase, timeout: timeoutMs });
      if (!r.ok) throw httpErr(r.status);
      const rows = magnet.filterByTokens(magnet.parseRows(r.text), term);
      const json = { list: rows.slice(0, MAX_ROWS).map(toMacRow), page: 1, total: rows.length };
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
      auth: settings.publicAuth(),
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

      /* 凭据只进不出：这里保存，界面读到的永远只是「有没有」 */
      if (p === '/credentials' && method === 'POST') {
        const patch = {};
        for (const k of ['username', 'password', 'refreshToken', 'deviceId']) {
          if (body[k] !== undefined && String(body[k]).trim()) patch[k] = String(body[k]).trim();
        }
        if (!Object.keys(patch).length) return bad(400, '没有要保存的内容');
        settings.patchAuth(patch);
        return ok(state());
      }

      if (p === '/login' && method === 'POST') {
        const login = await pikpak.loginNow({ timeout: 20000 });
        return ok(Object.assign(state(), { login }));
      }

      if (p === '/logout' && method === 'POST') {
        settings.clearSession();
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
        /* 上限调小后立刻淘汰（不然设置页会显示「已用 60MB / 上限 10MB」，看着像坏了） */
        cache.sweep('upstream', { force: true });
        return ok({ cacheSettings: next, cache: cache.stats() });
      }

      if (p === '/test' && method === 'POST') {
        return ok({ result: await selfTest(body) });
      }

      /* 直接试一个磁力：设置页上验「提交 → 等完成 → 取地址」这条链 */
      if (p === '/magnet' && method === 'POST') {
        return ok({ result: await magnetTest(body) });
      }

      /* 保存目录里现在有哪些条目 + 手动清理（都只动**目录里的条目**，不动目录本身） */
      if (p === '/savedir' && method === 'GET') {
        return ok({ result: await saveDirList() });
      }
      if (p === '/cleanup' && method === 'POST') {
        return ok({ result: await cleanSaveDir(body) });
      }

      return bad(404, `插件设置页没有这个接口：${method} ${p}`);
    } catch (e) {
      return bad(400, (e && e.message) || String(e));
    }
  },
};

/**
 * 一键自检：两段各报一次 —— 磁力站那一发（搜索词取自界面，不必先保存）与
 * PikPak 那一发（登录状态 + 保存目录 + 目录里有多少文件）。
 */
async function selfTest(body) {
  const cfg = settings.effective(body, settings.read());
  const wd = String((body && body.wd) || TEST_WD).trim() || TEST_WD;
  const term = (magnet.extractCode(wd) || wd).replace(/-/g, ' ');
  const url = magnet.searchUrl(cfg.sukebeiBase, term, 1);
  const out = { wd, term, url, sukebei: null, pikpak: null };

  const t0 = Date.now();
  try {
    const r = await fetcher.getHtml(url, { base: cfg.sukebeiBase, timeout: 12000 });
    if (!r.ok) throw httpErr(r.status);
    const rows = magnet.filterByTokens(magnet.parseRows(r.text), term);
    out.sukebei = {
      ok: true,
      status: r.status,
      ms: Date.now() - t0,
      count: rows.length,
      top: rows.slice(0, 3).map((x) => x.title),
    };
  } catch (e) {
    out.sukebei = {
      ok: false,
      status: Number(e && e.status) || 0,
      ms: Date.now() - t0,
      error: (e && e.message) || String(e),
    };
  }

  const t1 = Date.now();
  try {
    await pikpak.ensureLogin({ timeout: 15000 });
    const saveDirId = await pikpak.ensureSaveDir({ timeout: 15000 });
    const files = await pikpak.listFiles(saveDirId, { timeout: 15000 });
    out.pikpak = {
      ok: true,
      ms: Date.now() - t1,
      saveDir: cfg.saveDir,
      saveDirId,
      saveDirFiles: files.length,
      folders: files.filter((f) => f.kind === 'drive#folder').length,
    };
  } catch (e) {
    out.pikpak = {
      ok: false,
      ms: Date.now() - t1,
      error: (e && e.message) || String(e),
      code: (e && e.code) || '',
    };
  }
  return out;
}

/** 保存目录里现在有哪些条目（设置页「保存目录」卡片用；只看这一层，不往下翻） */
async function saveDirList() {
  const t0 = Date.now();
  try {
    await pikpak.ensureLogin({ timeout: 15000 });
    const saveDirId = await pikpak.ensureSaveDir({ timeout: 15000 });
    const files = await pikpak.listFiles(saveDirId, { timeout: 15000 });
    const items = files.map((f) => {
      const size = Number(f.size) || 0;
      return {
        id: f.id || f.id_ || '',
        name: f.name || '',
        folder: f.kind === 'drive#folder',
        size,
        sizeText: magnet.sizeText(size),
      };
    });
    return { ok: true, ms: Date.now() - t0, saveDir: settings.read().saveDir, saveDirId, count: items.length, items };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: (e && e.message) || String(e), code: (e && e.code) || '' };
  }
}

/**
 * 手动清理：把保存目录里的条目移进回收站（软删除，可恢复）。
 * 传 `ids` 就清这几条，传 `all: true` 就清空目录里现有的全部；**不动保存目录本身**。
 */
async function cleanSaveDir(body) {
  const t0 = Date.now();
  try {
    await pikpak.ensureLogin({ timeout: 15000 });
    const saveDirId = await pikpak.ensureSaveDir({ timeout: 15000 });
    let ids = Array.isArray(body && body.ids) ? body.ids.map((x) => String(x || '')).filter(Boolean) : [];
    if (!ids.length && body && body.all) {
      const files = await pikpak.listFiles(saveDirId, { timeout: 20000 });
      ids = files.map((f) => f.id || f.id_ || '').filter(Boolean);
    }
    if (!ids.length) return { ok: false, ms: Date.now() - t0, error: '没有要清理的条目' };
    const trashed = await pikpak.trashFiles(ids, { timeout: 30000 });
    return { ok: true, ms: Date.now() - t0, trashed };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: (e && e.message) || String(e), code: (e && e.code) || '' };
  }
}

/** 直接试一个磁力（设置页按钮）：提交 → 等 → 挑文件 → 取地址，各步如实回 */
async function magnetTest(body) {
  const b = body || {};
  const link = String(b.magnet || '').trim();
  if (!/^magnet:/i.test(link)) return { ok: false, error: '磁力链接要以 magnet: 开头' };
  const title = String(b.title || '').trim() || magnetTitle(link) || '磁力链接';
  const waitSeconds = Math.max(0, Math.min(Number(b.waitSeconds) || 40, 300));
  const t0 = Date.now();
  try {
    await pikpak.ensureLogin({ timeout: 20000 });
    const saveDirId = await pikpak.ensureSaveDir({ timeout: 20000 });
    const sub = await pikpak.submitMagnet(link, title, saveDirId, { timeout: 30000 });
    let fileId = sub.fileId;
    let phase = fileId ? '已缓存（云端直接给文件）' : '已提交，等待中';
    let taskId = sub.taskId;
    if (!fileId && taskId && waitSeconds > 0) {
      fileId = await pikpak.waitTask(taskId, Date.now() + waitSeconds * 1000, { timeout: 20000 });
      phase = fileId ? '离线下载完成' : '等待超时（任务还在跑）';
    }
    const vids = fileId ? await video.videosOf(fileId, title, { timeout: 20000 }) : [];
    const out = [];
    for (const v of vids.slice(0, 3)) {
      let url = '';
      let error = '';
      try {
        const one = await pikpak.getPlayUrl(v.id, { timeout: 20000 });
        url = (one && one.url) || '';
        if (!url) error = 'PikPak 没给出地址';
      } catch (e) {
        error = (e && e.message) || String(e);
      }
      out.push({ name: v.name, size: v.size, id: v.id, url, error });
    }
    return {
      ok: out.some((x) => x.url),
      ms: Date.now() - t0,
      title,
      phase,
      taskId,
      fileId,
      videos: out,
    };
  } catch (e) {
    return {
      ok: false,
      ms: Date.now() - t0,
      title,
      error: (e && e.message) || String(e),
      code: (e && e.code) || '',
    };
  }
}

module.exports = { actions };