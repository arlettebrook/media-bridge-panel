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
 * 为什么要有它：加第二个元数据来源时不必再改 emby 层 —— 由提供者自己注册。
 * 目标形态见 docs/plugin-contract.md（元数据插件注册域 id），决策见 docs/adr/0031。
 */
const byPrefix = new Map(); // 前缀（小写）→ 提供者
const byId = new Map(); // 提供者 id → 提供者

const PREFIX_RE = /^[a-z][a-z0-9]*$/i;

/**
 * 注册一个提供者。`id` 与 `prefix` 都是唯一的（`prefix` 按小写比对）。
 *   { id, prefix, series, label }
 *   · `series` —— 剧集式（有条目 → 季 → 集的层级）还是电影式（只有条目一层）。
 *     电影式的提供者仍可被拼出季集 Id，但面板不会向它要分集。
 *   · `label` —— 面板与日志里显示的名字，缺省用 `id`。
 * 重复注册会抛错（与 core/registry.js 同口径：配置错误要当场炸，不要静默覆盖）。
 */
function register(p) {
  const id = String((p && p.id) || '').trim();
  const prefix = String((p && p.prefix) || '').trim();
  if (!id) throw new Error('元数据提供者缺少 id');
  if (!prefix) throw new Error(`元数据提供者 ${id} 缺少 prefix`);
  if (!PREFIX_RE.test(prefix)) throw new Error(`元数据提供者的 prefix 不合法：${prefix}（只允许字母数字，且首字符为字母）`);
  if (byId.has(id)) throw new Error('元数据提供者重复注册：' + id);
  if (byPrefix.has(prefix.toLowerCase())) throw new Error('元数据提供者的 prefix 重复：' + prefix);
  const one = { id, prefix, series: p.series !== false, label: p.label || id };
  byId.set(id, one);
  byPrefix.set(prefix.toLowerCase(), one);
  return one;
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
 * ⚠️ 这里**不做数值校验**：与既有实现一致，非数字会原样拼进 Id（由 `parseItemId` 那一侧把关）。
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

module.exports = { register, get, byPrefixOf, list, itemId, parseItemId };
