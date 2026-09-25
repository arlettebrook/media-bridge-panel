'use strict';
/**
 * 元数据提供者注册表：**条目 Id 的前缀 → 提供者**。
 *
 * 面板与元数据之间只有这一处耦合。条目 Id 的形状
 * `{前缀}_{提供者的条目 id}_{tv|movie}[_s{n}][_e{m}]` 由**面板统一规定** ——
 * 它与客户端、进度库的键、首页插件的条目契约绑在一起，不能让每个来源自定义一套语法。
 * 提供者只负责两件事：给出"它自己的条目 id"，以及声明自己是**剧集式**还是**电影式**。
 *
 * 于是这张表只管一件事：**认哪个前缀**。认不出就如实返回 null（调用方照 404 处理），
 * 不回退到别的提供者、不猜、不静默。
 *
 * **谁往里填**：元数据插件（`server/modules/emby/meta.js` 按插件清单与开关重建这张表）。
 * 面板这一层不认识任何具体的域 —— 加第二个元数据来源不必改这里，也不必改 emby 层。
 * 决策见 docs/adr/0031，契约见 docs/plugin-contract.md 第六节。
 */
const byPrefix = new Map(); // 前缀（小写）→ 提供者
const byId = new Map(); // 提供者 id → 提供者

const PREFIX_RE = /^[a-z][a-z0-9]*$/i;

/**
 * 重建整张表（**不是**逐个追加）—— 它描述的是"现在装了哪些元数据插件、哪个开着"，
 * 而这件事会随装/卸/启/停变。整张重建比"记得删掉旧的那条"可靠。
 *
 * 每条：`{ id, prefix, series, label, plugin: { type, id }, enabled }`
 *   · `id` 与 `prefix` 都是唯一的；这一版里两者相同（域 id 就是前缀）
 *   · `series` —— 剧集式（有序条目 → 季 → 集的层级）还是电影式（只有条目一层）
 *   · `plugin` —— 这个域由哪个插件提供（面板要据此去发动作）
 *   · `label` —— 面板与日志里显示的名字，缺省用 `id`
 *
 * 非法项**跳过并回原因**（不抛）：插件清单在安装时已经校验过，这里兜的是"两个插件申报了
 * 同一个域"这类跨插件冲突。调用方把 `skipped` 如实写进日志 —— 不静默、也不因此拦住面板启动。
 */
function sync(entries) {
  byPrefix.clear();
  byId.clear();
  const skipped = [];
  for (const raw of entries || []) {
    const id = String((raw && raw.id) || '').trim();
    const prefix = String((raw && raw.prefix) || id).trim();
    if (!id) {
      skipped.push({ id: '', reason: '缺少 id' });
      continue;
    }
    if (!PREFIX_RE.test(prefix)) {
      skipped.push({ id, reason: `前缀不合法：${prefix || '(空)'}（只允许字母数字，且首字符为字母）` });
      continue;
    }
    if (byId.has(id) || byPrefix.has(prefix.toLowerCase())) {
      skipped.push({ id, reason: `域 ${prefix} 重复申报` });
      continue;
    }
    const one = {
      id,
      prefix,
      series: raw.series !== false,
      label: raw.label || id,
      plugin: raw.plugin && raw.plugin.type ? { type: String(raw.plugin.type), id: String(raw.plugin.id || '') } : null,
      enabled: raw.enabled !== false,
    };
    byId.set(id, one);
    byPrefix.set(prefix.toLowerCase(), one);
  }
  return { registered: byId.size, skipped };
}

function get(id) {
  return byId.get(String(id || '').trim()) || null;
}

/** 按前缀找提供者（大小写不敏感） */
function byPrefixOf(prefix) {
  return byPrefix.get(String(prefix || '').trim().toLowerCase()) || null;
}

function list() {
  return Array.from(byId.values());
}

/**
 * 拼条目 Id。**与 `parseItemId` 必须互逆**，所以挨着放。
 *
 * 传了 season 就是季（只有剧集式提供者才有季）：`{前缀}_{条目 id}_tv_s1`；
 * 再传 episode 就是集：`{前缀}_{条目 id}_tv_s1_e3`。
 * 电影式提供者只到 `{前缀}_{条目 id}_movie`（季集层级对它无意义，传了也不拼）。
 *
 * 这里**不做数值校验**：与既有实现一致，非数字会原样拼进 Id（由 `parseItemId` 那一侧把关）。
 */
function itemId(prefix, entryId, type, season, episode) {
  const kind = type === 'movie' ? 'movie' : 'tv';
  const base = `${prefix}_${Number(entryId)}_${kind}`;
  if (kind !== 'tv' || season === undefined || season === null) return base;
  const s = `${base}_s${Number(season)}`;
  if (episode === undefined || episode === null) return s;
  return `${s}_e${Number(episode)}`;
}

/**
 * `itemId()` 的逆 —— 必须与它互逆。
 * `{前缀}_{条目 id}_{tv|movie}[_s{n}][_e{m}]` → { prefix, provider, entryId, type, season, episode }。
 *
 * 认不出来就给 null，包括这几种：前缀没有注册、电影带季号、有集号却没有季号、号不是数字。
 */
function parseItemId(id) {
  const m = /^([a-z][a-z0-9]*)_(\d+)_(movie|tv)(?:_s(\d+))?(?:_e(\d+))?$/i.exec(String(id || '').trim());
  if (!m) return null;
  const provider = byPrefixOf(m[1]);
  if (!provider) return null;
  const type = m[3].toLowerCase();
  if (m[4] !== undefined && type !== 'tv') return null;
  if (m[5] !== undefined && m[4] === undefined) return null; // 集号必须挂在季号下
  const season = m[4] === undefined ? null : Number(m[4]);
  const episode = m[5] === undefined ? null : Number(m[5]);
  if (season !== null && !Number.isFinite(season)) return null;
  if (episode !== null && !Number.isFinite(episode)) return null;
  return { prefix: provider.prefix, provider, entryId: Number(m[2]), type, season, episode };
}

module.exports = { sync, get, byPrefixOf, list, itemId, parseItemId };
