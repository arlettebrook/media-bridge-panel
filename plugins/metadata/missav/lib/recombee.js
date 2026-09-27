'use strict';
/**
 * MissAV 的「相似推荐」取数 —— 走站点自己的推荐服务，**不解析页面**。
 *
 * **为什么不能从影片页 HTML 里拿**：页面上那几十个格子是**空占位**
 * （`window.placeHolderRelatedItems` 是一串空对象，只有 `relatedItemsQuantity` 这个条数是真的），
 * 真数据由页面脚本在浏览器里异步问第三方推荐服务要。想拿到同一份，只能在服务端照它那套
 * 签名规则自己发一次 POST。
 *
 * 凭证（库名 / 公开令牌 / 服务地址）是**站点前端包里的公开值** —— 网页端每个访客都用它，
 * 不是私密凭据。站点改版换掉它时，这里会如实失败、调用方照实留空（不编占位数据），
 * 改一处常量即可恢复。
 *
 * 签名口径照前端 SDK 的 `_signUrl`：把「库名 + 路径 + `frontend_timestamp`」拼成一串，
 * 用公开令牌做 HMAC-SHA1 当 `frontend_sign`；少了它上游回 401 `HMAC required`。
 * `count` / `scenario` 这类参数必须放**请求体**（放 query 上游会说没给 `count`）。
 */
const crypto = require('crypto');
const parse = require('./parse');

/** 站点前端的公开凭据与推荐服务地址（没有 `/api` 前缀，带上会 405） */
const DATABASE_ID = 'missav-default';
const PUBLIC_TOKEN = 'Ikkg568nlM51RHvldlPvc2GzZPE9R4XGzaH9Qj4zK9npbbbTly1gj9K4mgRn0QlV';
const BASE_URI = 'https://client-rapi-missav.missav.fans';

/**
 * 求推荐时的「用户」：本站这套推荐是**按条目**算的，用户只是个必填占位；
 * 用固定值 + `cascadeCreate`（上游没有这个用户就顺手建一个），不必自己存一份 id。
 */
const USER_ID = 'catpaw-panel';
/** 站点自己那一栏的场景名（「接下来看这个」）—— 换场景会换出一批不同的推荐 */
const SCENARIO = 'desktop-watch-next-bottom';
/** 一次要几条：面板按客户端给的上限裁剪，这里多要一点免得被裁空 */
const COUNT = 20;
/** 每个条目固定要的属性（都是实测存在的） */
const BASE_PROPS = ['title', 'duration', 'genres'];
const TIMEOUT_MS = 8000;

/**
 * 语言段对应的标题属性：`title_<语言段>`。
 * 站点只给一部分语言做了翻译（cn / zh / en / ko / th / vi / id / ms / pt / fr / de），
 * 别的语言段（如 ja）没有这个属性，上游会直接 404 说不存在 —— 那就退回 `title`（原始日文题）。
 * 不预置一份会过期的语言清单：**问一次、记一次**，问不到的语言段下次直接跳过它。
 */
const missingTitleProps = new Set();
const titleProp = (language) => 'title_' + String(language || '').toLowerCase();

function propsFor(language) {
  const t = titleProp(language);
  return missingTitleProps.has(t) ? BASE_PROPS.slice() : [t].concat(BASE_PROPS);
}

/** 带签名的地址：`<服务地址>/<库名>/recomms/items/<条目>/items/?frontend_timestamp=…&frontend_sign=…` */
function signedUrl(slug) {
  const unsigned = `/${DATABASE_ID}/recomms/items/${encodeURIComponent(slug)}/items/?frontend_timestamp=${Math.floor(
    Date.now() / 1000
  )}`;
  const sign = crypto.createHmac('sha1', PUBLIC_TOKEN).update(unsigned).digest('hex');
  return BASE_URI + unsigned + '&frontend_sign=' + sign;
}

/** 发一次求推荐的 POST，**原样回** `{ status, text }`；网络类失败抛带 `code` 的错 */
async function ask(slug, props) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(signedUrl(slug), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: USER_ID,
        cascadeCreate: true,
        count: COUNT,
        scenario: SCENARIO,
        returnProperties: true,
        includedProperties: props,
      }),
      signal: ctrl.signal,
    });
    return { status: res.status, text: await res.text() };
  } catch (e) {
    const timeout = e && (e.name === 'AbortError' || /abort/i.test(e.message || ''));
    const err = new Error(timeout ? `请求超时（${TIMEOUT_MS}ms）` : '连不上站点推荐服务');
    err.code = timeout ? 'TIMEOUT' : 'NETWORK';
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 上游说不认识的那个属性名（`Property "x" does not exist`）—— 用来把它从请求里摘掉 */
function missingPropOf(text) {
  const m = String(text || '').match(/Property\s*\\*"?([A-Za-z_][A-Za-z0-9_]*)/);
  return m ? m[1] : '';
}

/**
 * 上游的推荐 → 面板认的那份（契约第六节「相似推荐」）。
 * 每条只给**上游确实有**的东西：编号 / 名字 / 类型 / 时长 / 封面。
 * 年份、简介、评分这些本站这套推荐没给，如实留空（不编）。
 */
function normalize(json, language, imageBase) {
  const want = titleProp(language);
  const out = [];
  for (const rec of (json && json.recomms) || []) {
    const id = String((rec && rec.id) || '').trim();
    if (!id) continue;
    const v = (rec && rec.values) || {};
    const title = String(v[want] || v.title || '').trim();
    const sec = Number(v.duration);
    out.push({
      entryId: id,
      type: 'movie',
      /* 名字与列表页同一口径：补上番号，免得客户端只看到一串片名分不出是哪一部 */
      title: parse.formatTitle(parse.videoCode(id), title),
      genres: Array.isArray(v.genres) ? v.genres : [],
      runtimeMinutes: sec > 0 ? Math.floor(sec / 60) : 0,
      posterPath: parse.imageUrlOf(imageBase, id),
    });
  }
  return out;
}

/**
 * 取一个条目的相似推荐：回一个数组（上游确实没有就给空数组）。
 * **网络层与上游失败一律抛错** —— 由调用方决定是记日志还是留空，这一层不替它拿主意。
 */
async function related({ slug, language, imageBase }) {
  const id = parse.canonicalSlug(slug);
  if (!id) return [];
  const want = titleProp(language);
  let res = await ask(id, propsFor(language));
  if (res.status === 404 && missingPropOf(res.text) === want) {
    missingTitleProps.add(want);
    res = await ask(id, propsFor(language));
  }
  if (res.status !== 200) {
    const e = new Error(`站点推荐服务返回 HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  let json;
  try {
    json = JSON.parse(res.text);
  } catch {
    throw new Error('站点推荐服务的响应不是 JSON');
  }
  return normalize(json, language, imageBase);
}

module.exports = { related, titleProp, missingPropOf, DATABASE_ID, BASE_URI, SCENARIO, COUNT, TIMEOUT_MS };