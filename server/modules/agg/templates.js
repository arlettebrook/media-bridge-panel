'use strict';
/**
 * 模板：**一份配置数据文件**，内容 = 选中的站点 + 打分过滤参数 + 超时与并发。
 *
 * 落盘位置：
 *   `templates/<模板 id>.json`   一份模板一个文件（**id 就是这套模板的身份**，随机生成、之后固定）
 *   `templates/domains.json`     域 → 模板 id 的对照
 *
 * 三条既定口径（见 docs/adr/0033）：
 *   ① **一个域最多一条对照**（域与模板是一对一）；**一个模板可被多个域共用**。
 *   ② **站点身份按"源 + 站点 key"记** —— 不用端口、实例名之类会变的东西。
 *   ③ **没配模板的域如实为空**：不猜、不挑一个兜底（调用方据此如实回空并点名）。
 *
 * 已定：本版当作全新安装，不读旧的 `agg.json`（见 docs/adr/0034）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TEMPLATES_DIR } = require('../../core/paths');

const DIR = TEMPLATES_DIR;
const DOMAINS = path.join(DIR, 'domains.json');
const ID_RE = /^tpl_[a-z0-9]{6,32}$/;

/** 进模板的参数（打分、过滤、超时、并发）。留在这里是为了"读一份模板就能拿到全部调优项"。 */
const PARAM_KEYS = ['timeoutSec', 'detailTimeoutSec', 'playTimeoutSec', 'concurrency', 'matchMinScore', 'matchMaxItems', 'matchExtraK', 'matchExtraAll', 'lineFilter', 'skipFailedSites'];
const PARAM_DEFAULTS = {
  timeoutSec: 5,
  detailTimeoutSec: 10,
  /* 取播放地址（`POST /play`）的单站上限。**必须比搜索宽**：网盘类线路（PikPak 那种）取一个地址
   * 要串行打登录 → 查保存目录 → 提交离线下载 → 等完成 → 取直链好几发，5 秒档下会被一律判成超时，
   * 客户端拿到 502 再原样重试，越重试越慢（见 docs/adr/0026 的同款取舍）。 */
  playTimeoutSec: 25,
  concurrency: 8,
  matchMinScore: 0.85,
  matchMaxItems: 8,
  matchExtraK: 0,
  matchExtraAll: false,
  lineFilter: '',
  /* 最近一次测速失败的站，聚合搜索时先跳过（勾选不变，测速成功即自动恢复）。
   * 缺省**开** —— 这是原来一直就有的行为（见 agg/service.js 的 aggregateSearch）；
   * 关掉 = 照打，用来确认"那几个站现在到底行不行"。 */
  skipFailedSites: true,
};

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true });
}

function readJson(file, dflt) {
  try {
    const s = fs.readFileSync(file, 'utf8');
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : dflt;
  } catch {
    return dflt;
  }
}

/** 原子写（与 core/settings.js 同一套做法：临时文件 + rename） */
function writeJson(file, obj) {
  ensureDir();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

const fileOf = (id) => path.join(DIR, String(id) + '.json');
const newId = () => 'tpl_' + crypto.randomBytes(6).toString('hex');

/** 站点项归一化：只认 `{source, key}` 两个字段，按序去重 */
function normSites(list) {
  const out = [];
  const seen = new Set();
  for (const x of Array.isArray(list) ? list : []) {
    const source = String((x && x.source) || '').trim();
    const key = String((x && x.key) || '').trim();
    if (!source || !key) continue;
    const id = source + '\u0001' + key;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ source, key });
  }
  return out;
}

/** 参数归一化：缺失取默认值，数值统一成数字 */
function normParams(raw) {
  const o = raw || {};
  const num = (v, d) => (v === undefined || v === null || v === '' ? d : Number(v));
  return {
    timeoutSec: num(o.timeoutSec, PARAM_DEFAULTS.timeoutSec),
    detailTimeoutSec: num(o.detailTimeoutSec, PARAM_DEFAULTS.detailTimeoutSec),
    playTimeoutSec: num(o.playTimeoutSec, PARAM_DEFAULTS.playTimeoutSec),
    concurrency: num(o.concurrency, PARAM_DEFAULTS.concurrency),
    matchMinScore: num(o.matchMinScore, PARAM_DEFAULTS.matchMinScore),
    matchMaxItems: num(o.matchMaxItems, PARAM_DEFAULTS.matchMaxItems),
    matchExtraK: num(o.matchExtraK, PARAM_DEFAULTS.matchExtraK),
    matchExtraAll: o.matchExtraAll === true,
    lineFilter: String(o.lineFilter == null ? '' : o.lineFilter).trim(),
    /* 缺省 true（= 老模板文件里没有这个字段时也按"跳过"走，行为与从前一致） */
    skipFailedSites: o.skipFailedSites !== false,
  };
}

/**
 * 校验**待保存的原始输入**（还没归一化过）。返回错误文案；没问题返回 null。
 *
 * ⚠️ 站点项在这里**逐条查、不静默丢**：缺 `source`/`key`、或者同一个站点写了两次，
 * 都当成错误挡回去 —— 悄悄丢掉用户勾过的一个站点，比报错难查得多。
 * 参数缺失按默认值补全后再查范围（所以只改一项、其余留空是合法的）。
 */
function validate(raw) {
  const o = raw || {};
  if (o.id !== undefined && String(o.id) !== '' && !ID_RE.test(String(o.id))) {
    return '模板 id 不合法（应为 tpl_ 开头的小写字母数字）';
  }
  if (!String(o.name || '').trim()) return '模板要有个名字';
  if (String(o.name).trim().length > 40) return '模板名字最长 40 个字符';
  if (!Array.isArray(o.sites)) return '站点列表必须是数组';
  const ids = new Set();
  for (const s of o.sites) {
    const source = String((s && s.source) || '').trim();
    const key = String((s && s.key) || '').trim();
    if (!source || !key) return '站点项缺少 source 或 key';
    const one = source + '\u0001' + key;
    if (ids.has(one)) return '同一个站点在模板里出现了两次';
    ids.add(one);
  }
  const p = normParams(o.params);
  if (!(p.timeoutSec >= 1 && p.timeoutSec <= 60)) return '单站超时取值 1~60 秒';
  if (!(p.detailTimeoutSec >= 1 && p.detailTimeoutSec <= 120)) return '取详情超时取值 1~120 秒';
  if (!(p.playTimeoutSec >= 1 && p.playTimeoutSec <= 120)) return '播放超时取值 1~120 秒';
  if (!(p.concurrency >= 1 && p.concurrency <= 32)) return '并发数取值 1~32';
  if (!(p.matchMinScore >= 0 && p.matchMinScore <= 1)) return '打分分数线取值 0~1（0 = 不筛选）';
  if (!(p.matchMaxItems >= 1 && p.matchMaxItems <= 20)) return '最多留几条命中取值 1~20';
  if (!(p.matchExtraK >= 0 && p.matchExtraK <= 10)) return '再往下打几条取值 0~10';
  if (p.lineFilter) {
    try {
      new RegExp(p.lineFilter); // 规则写错不该等到播放时才炸
    } catch {
      return '线路过滤不是合法的正则';
    }
  }
  return null;
}

/** 一份完整模板（含 id 与归一化后的字段） */
function normalize(raw) {
  const id = String((raw && raw.id) || '').trim() || newId();
  return {
    id,
    name: String((raw && raw.name) || '').trim(),
    sites: normSites(raw && raw.sites),
    params: normParams(raw && raw.params),
  };
}

function list() {
  ensureDir();
  const out = [];
  for (const f of fs.readdirSync(DIR)) {
    if (!f.endsWith('.json') || f === 'domains.json' || f.endsWith('.tmp')) continue;
    const t = readJson(path.join(DIR, f), null);
    if (t && t.id) out.push(t);
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));
}

function read(id) {
  if (!ID_RE.test(String(id || ''))) return null;
  const t = readJson(fileOf(id), null);
  return t && typeof t === 'object' && t.id === id ? t : null;
}

/** 新建或覆盖一份模板（`raw.id` 有就是覆盖）。**先校验原始输入、再归一化**。返回写入后的模板。 */
function save(raw) {
  const err = validate(raw);
  if (err) throw new Error(err);
  const t = normalize(raw);
  writeJson(fileOf(t.id), t);
  return t;
}

/** 删一份模板，同时清掉引用它的域对照（否则会留下指向空模板的域） */
function remove(id) {
  const t = read(id);
  if (!t) return false;
  try {
    fs.unlinkSync(fileOf(id));
  } catch {
    return false;
  }
  const map = domains();
  let changed = false;
  for (const [d, tid] of Object.entries(map)) {
    if (tid === id) {
      delete map[d];
      changed = true;
    }
  }
  if (changed) writeJson(DOMAINS, map);
  return true;
}

/** 域 → 模板 id 的对照（一个域最多一条） */
function domains() {
  const raw = readJson(DOMAINS, {});
  const out = {};
  for (const [d, tid] of Object.entries(raw || {})) {
    const domain = String(d || '').trim();
    if (!domain || !ID_RE.test(String(tid || ''))) continue;
    out[domain] = String(tid);
  }
  return out;
}

/** 设/清某个域的模板（`templateId` 传空 = 清掉）。一个域只能指向一份模板。 */
function setDomain(domain, templateId) {
  const d = String(domain || '').trim();
  if (!d) throw new Error('域不能为空');
  const map = domains();
  const tid = String(templateId || '').trim();
  if (!tid) {
    delete map[d];
  } else {
    if (!read(tid)) throw new Error('模板不存在：' + tid);
    map[d] = tid;
  }
  writeJson(DOMAINS, map);
  return map;
}

/**
 * 某个域该用哪份模板 —— **没配就返回 null**（调用方如实为空并点名，不挑兜底）。
 */
function templateFor(domain) {
  const map = domains();
  const tid = map[String(domain || '').trim()];
  return tid ? read(tid) : null;
}

/** 某个域的站点集合（按模板里的顺序）。没配模板 ⇒ null */
function sitesFor(domain) {
  const t = templateFor(domain);
  return t ? t.sites : null;
}

/** 哪些域用了这份模板（面板上要显示"它被哪几套模板用了"时用得上） */
function domainsUsing(templateId) {
  return Object.entries(domains())
    .filter(([, tid]) => tid === templateId)
    .map(([d]) => d);
}

module.exports = {
  DIR,
  DOMAINS,
  PARAM_KEYS,
  PARAM_DEFAULTS,
  newId,
  normSites,
  normParams,
  normalize,
  validate,
  list,
  read,
  save,
  remove,
  domains,
  setDomain,
  templateFor,
  sitesFor,
  domainsUsing,
};
