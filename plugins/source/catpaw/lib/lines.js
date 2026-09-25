'use strict';
/**
 * 线路与选集的解析：把站源 `/detail` 里那两串文本（`vod_play_from` / `vod_play_url`）拆成
 * 「线路 → 选集」，并在里面定位某一集。
 *
 *   线路之间用 `$$$` 分；一集里「集名 $ 集ID」；一集与一集之间用 `#`。
 *
 * **为什么这一份归插件**（原在面板的 `agg/service.js` 里）：`$$$` / `#` / `$` 是**猫爪源自己的约定**，
 * 不是面板层的约定 —— 直查那类源插件（给关键词就出地址）根本没有线路，将来别的源插件也可能
 * 用完全不同的形状。面板只该看到"有哪些线路、每条线路有哪些可播项"。
 *
 * ⚠️ 定位规则（`locateEpisode` 那三条路）是从面板原样搬过来的，注释里的实测案例一并留着 ——
 * 那是"为什么这么写"的唯一记录，别删。
 */

/**
 * 拆 `vod_play_from` / `vod_play_url`：
 *   vod_play_from 用 `$$$` 分线路名；vod_play_url 用 `$$$` 分线路、`#` 分集、`$` 分「集名 / 集ID」。
 * 返回 [{ flag, episodes:[{name,id,index}], episodeCount }]；没有 id 的段不算一集（脏数据过滤）。
 */
function parseLines(vodPlayFrom, vodPlayUrl) {
  const flags = String(vodPlayFrom || '').split('$$$');
  const groups = String(vodPlayUrl || '').split('$$$');
  const out = [];
  flags.forEach((rawFlag, i) => {
    const flag = rawFlag.trim();
    if (!flag) return;
    const episodes = String(groups[i] || '')
      .split('#')
      .map((seg, idx) => {
        const pos = seg.indexOf('$');
        const name = (pos >= 0 ? seg.slice(0, pos) : seg).trim();
        const id = (pos >= 0 ? seg.slice(pos + 1) : '').trim();
        return { name: name || `第${idx + 1}集`, id, index: idx + 1 };
      })
      .filter((e) => e.id);
    out.push({ flag, episodes, episodeCount: episodes.length });
  });
  return out;
}

/**
 * 从集名解析季/集号 —— **只认明确写法**，解析不出就是解析不出（不猜）：
 *   「第2季第3集」「S01E03」→ {season, episode}
 *   「第3集」「03集」「3」    → {season:null, episode}
 */
function parseEpisodeTitle(raw) {
  const s = String(raw || '');
  let m = /第\s*(\d+)\s*季\s*第?\s*(\d+)\s*[集话期章]?/.exec(s) || /S(\d{1,2})\s*E(\d{1,3})/i.exec(s);
  if (m) return { season: Number(m[1]), episode: Number(m[2]) };
  m = /第?\s*(\d+)\s*[集话期章]/.exec(s);
  if (m) return { season: null, episode: Number(m[1]) };
  m = /^\s*(\d+)\s*$/.exec(s);
  if (m) return { season: null, episode: Number(m[1]) };
  /* 前缀式纯集号：`211 4K.mp4` / `180x.mp4` —— 常见于「年番」这类扁平编号条目。
   * 先剥掉 `[1.2GB]` 方括号段与【】段（体积/站点标注不是集号），再取第一个独立数字；
   * 后面必须跟空白/结尾/`x` —— 挡掉 `4K`（4 后面是 K）与 `2160p`（2160 后面是 p）这类规格数字。 */
  const clean = s.replace(/\[[^\]]*\]/g, ' ').replace(/【[^】]*】/g, ' ');
  m = /(?:^|\s)(\d{1,4})(?=\s|$|x)/i.exec(clean);
  if (m) return { season: null, episode: Number(m[1]) };
  return null;
}

/**
 * 「数字兜底」用的清洗：剔掉**带 S 的规范段**与**体积标注**后，
 * 取剩下部分里的**第一个数字**。
 *   · 带 S 的数字不算集号：`S05`、`S01E210`、`第5季`（「不匹配带 s 的数字」）；
 *   · 体积不算：`1.2GB` / `394.0MB`（「不匹配后面带 GB 的数字」）。
 * 例：`玩偶|4K · [1.2GB]208 4K.mp4【D 斗破】` → `玩偶|4K · 208 4K.mp4` → 208
 *     `玩偶|4K · [1.2GB]S01E210.mkv【豆粕苍穹】` → `玩偶|4K · .mkv` → null（刻意不把 210 当集号）
 * 规格数字与扩展名数字同样排除：`4K`、`1080p`、`1080i`、`2160p`，
 * 以及 `.mp4` 里的 4、`x264` 里的 264 —— 数字两侧紧邻字母的都不算集号，唯一例外是后缀 `x`。
 *     例：`玩偶|4K · [1.2GB]S01E210.mkv` 清洗后剩 `玩偶|4K · .mkv` → 4 后面是 K → 跳过 → null；
 *         `4K.mp4` → 4 后是 K、mp4 的 4 前是 p → 全跳过 → null（实测已知的错配）。
 * 小数规格也排除：`AAC5.1` / `DD5.1` 里的 5、1 都不算集号（实测已知的第二类错配）。
 */
function looseEpisodeNumber(raw) {
  let s = String(raw || '');
  s = s.replace(/\[[^\]]*\]/g, ' ').replace(/【[^】]*】/g, ' ');
  s = s.replace(/S\s*\d{1,2}\s*E\s*\d{1,3}/gi, ' ');
  s = s.replace(/S\s*\d{1,2}(?!\d)/gi, ' ');
  s = s.replace(/第\s*\d+\s*[季部]/g, ' ');
  s = s.replace(/\d+(?:\.\d+)?\s*(?:GB|MB|KB|TB|B)(?![\w])/gi, ' ');
  /* 规格数字与扩展名里的数字都排除：
   * 数字**两侧紧邻字母**的都不算集号 —— 后紧跟的是 `4K`/`1080p`/`1080i`/`2160p`，
   * 前紧邻的是扩展名 `.mp4` 的那个 4、编码 `x264` 的 264。
   * 唯一放行后缀 `x`（源自己的 `180x.mp4` 写法）。 */
  const re = /\d{1,4}/g;
  let m;
  while ((m = re.exec(s))) {
    const prev = m.index > 0 ? s[m.index - 1] : '';
    const next = s[m.index + m[0].length] || '';
    const badPrev = /[A-Za-z]/.test(prev);
    const badNext = /[A-Za-z]/.test(next) && next !== 'x' && next !== 'X';
    /* 小数规格也不算：`AAC5.1` / `DD5.1` 这类声道标注里的数字，
     * 会让 E1 误命中（实测：非夸克线路 `斗破苍穹.S05E044.2160p...AAC5.1.mp4` 被 E1 命中）。
     * 判据：数字与小数点夹着数字（`5.1` 两侧的数字都算）；`01.mp4` 不受影响（点号后是 m，不是数字）。 */
    const inDecimal =
      (next === '.' && /\d/.test(s[m.index + m[0].length + 1] || '')) ||
      (prev === '.' && /\d/.test(s[m.index - 2] || ''));
    if (!badPrev && !badNext && !inDecimal) return Number(m[0]);
  }
  return null;
}

/**
 * 在线路里定位「第 season 季第 episode 集」 —— 命中必须能说出**凭什么命中**（matchedBy）：
 *   title    集名里明确写了「第X季第Y集」/「SxEy」且完全匹配（**季优先**）
 *   episode  季没出结果 → 集名里只写了集号（第3集 / 03 / `211 4K.mp4`），**任何季都认**
 *            （原口径只认第 1 季 —— 「年番」类扁平编号在 TMDB 算第 5 季时整条链路定位不到，
 *             见 S5E211 实测）
 *   number   数字兜底：剔掉带 S 的规范段与体积标注后，第一个数字 === episode
 * 都对不上 → null（调用方如实说明，不猜）。
 */
function locateEpisode(lines, season, episode) {
  const s = Number(season);
  const e = Number(episode);
  const hit = (line, ep, matchedBy) => ({ flag: line.flag, name: ep.name, id: ep.id, index: ep.index, matchedBy });

  /* ① 季优先（取代原来「季集必须同时命中」+「纯集号只认第 1 季」的口径）：
   * 集名里标了显式季号的 → 只在季号 === s 的集里匹配集号。 */
  for (const line of lines) {
    for (const ep of line.episodes) {
      const t = parseEpisodeTitle(ep.name);
      if (t && t.season === s && t.episode === e) return hit(line, ep, 'title');
    }
  }
  /* ② 季没出结果 → 直接匹配集：集名里只写了集号（第3集 / 03 / `211 4K.mp4`），
   * **任何季都认** —— 「斗破苍穹年番」在源里是扁平编号 01~211，在 TMDB 里却是第 5 季，
   * 原来非第 1 季一律定位不到。代价如实记着：扁平编号到底对应哪一季是猜的（按年番=最新季理解）。 */
  for (const line of lines) {
    for (const ep of line.episodes) {
      const t = parseEpisodeTitle(ep.name);
      if (t && t.season === null && t.episode === e) return hit(line, ep, 'episode');
    }
  }
  /* ③ 数字兜底：② 也没中 → 剔掉带 S 的规范段与体积标注后，
   * 集名里第一个数字 === e 就算命中（`[1.2GB]2.mp4` → 2）。
   * **取代原来的「按选集序号（该行第 N 个）兜底」** —— 那个必然错：某行列表从 208 开始时，
   * 请求 E1 会拿到 `208 4K.mp4`、请求 E3 会拿到 `210 4K.mp4`（实测已知的错配）。 */
  for (const line of lines) {
    for (const ep of line.episodes) {
      if (looseEpisodeNumber(ep.name) === e) return hit(line, ep, 'number');
    }
  }
  return null;
}

module.exports = { parseLines, parseEpisodeTitle, looseEpisodeNumber, locateEpisode };
