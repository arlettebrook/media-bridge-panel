'use strict';
/**
 * PikPak 接口封装（登录、离线下载、列目录、取播放地址）。
 *
 * 常量与请求口径照第三方 Forward Widget 脚本（`pan-pikpak.js`）搬过来：
 * 客户端 id / 版本 / 包名、接口域名、验证码签名链、请求头（浏览器 UA + Origin/Referer +
 * `Authorization` / `X-Device-ID` / `X-Captcha-Token`）。
 *
 * 与脚本不同的一处：**登录态落在插件自己的 `data/auth.json` 里，且一进动作就先用它**。
 * 反复登入登出会触发风控（用户明确交代过），所以调用顺序固定是
 * 「已有令牌 → 刷新令牌 → 账号密码」——前两步能成，就一次都不碰密码那条路。
 *
 * 但**刷新令牌救不回来是常态**：同账号在别处登录或刷新过，PikPak 会把旧刷新令牌作废
 * （实测回 `4126 invalid_grant`）。所以令牌一旦被判过期，补救链必须能继续回落到账号密码，
 * 否则登录态这样死掉就永久 502、只能手点重登。密码那条路有风控代价，故加时间闸限流。
 *
 * ⚠️ **验证码令牌是按「动作」签发的**（`GET:/drive/v1/files` 与 `POST:/drive/v1/files`
 * 各是一枚），拿错动作的令牌，接口一律回 `error_code: 9`。实测：列目录（GET）过得去的那枚，
 * 交给提交磁力（POST）就报 9；按 POST 那个动作另领一枚，同一发立刻变成「参数不对」而不是 9。
 * 所以下面按动作缓存令牌，`error_code: 9` 时也按**当前动作**重领，而不是一律领列目录那枚。
 * 列目录、取任务、取单个文件（GET 这几个）可以共用一枚，POST 必须单独一枚。
 *
 * 密码与令牌都不进日志；出错时只报错误码与可读描述。
 */
const crypto = require('crypto');
const settings = require('./settings');
const fetcher = require('./fetch');
const cache = require('./cache');

const API_BASE = 'https://api-drive.mypikpak.com/drive/v1';
const AUTH_SIGNIN = 'https://user.mypikpak.net/v1/auth/signin';
const AUTH_TOKEN = 'https://user.mypikpak.net/v1/auth/token';
const CAPTCHA_INIT = 'https://user.mypikpak.net/v1/shield/captcha/init';
const CLIENT_ID = 'YUMx5nI8ZU8Ap8pm';
const CLIENT_VERSION = '2.0.0';
const PACKAGE_NAME = 'mypikpak.com';
const CAPTCHA_REDIRECT = 'xlaccsdk01://xbase.cloud/callback?state=harbor';

/** 验证码签名链（照脚本那份逐条对齐，少一条签名就过不去） */
const ALGORITHMS = [
  'C9qPpZLN8ucRTaTiUMWYS9cQvWOE',
  '+r6CQVxjzJV6LCV',
  'F',
  'pFJRC',
  '9WXYIDGrwTCz2OiVlgZa90qpECPD6olt',
  '/750aCr4lm/Sly/c',
  'RB+DT/gZCrbV',
  '',
  'CyLsf7hdkIRxRm215hl',
  '7xHvLi2tOYP0Y92b',
  'ZGTXXxu8E/MIWaEDB+Sm/',
  '1UI3',
  'E7fP5Pfijd+7K+t6Tg/NhuLq0eEUVChpJSkrKxpO',
  'ihtqpG6FMt65+Xk+tWUH2',
  'NhXXU9rg4XXdzo7u5o',
];

/** 令牌过期那一类错误码（4122 / 4121 / 16 与 HTTP 401 同义） */
const TOKEN_CODES = [4122, 4121, 16];
/** 验证码过期 */
const CAPTCHA_CODE = 9;
/** 「列目录」那个动作：登录后必领的一枚，也是 GET 各发的兜底 */
const ACTION_FILES = 'GET:/drive/v1/files';
/**
 * 自动补救里「账号密码」那条路的风控闸：一个窗口内只放一次。
 * 客户端拉流失败会**原样重试几十次**，凭据本身有问题时，没有这道闸就会几十次连着撞登录。
 */
const PASSWORD_LOGIN_COOLDOWN_MS = 60 * 1000;
/** 上次走账号密码的毫秒时间戳（进程内；重启即清零，够用） */
let lastPasswordLoginAt = 0;

/**
 * 动作 → 验证码令牌（进程内）。令牌是按动作签发的，用错动作就回 9，
 * 所以这里按动作各存一枚；换动作时才另领，同一个动作一直复用。
 */
const captchaByAction = new Map();

const md5 = (s) => crypto.createHash('md5').update(String(s)).digest('hex');

function pkErr(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

/** 服务端错误对象 → 可读文案（不回密码、不回令牌） */
function detailOf(data) {
  const d = data || {};
  return String(d.error_description || d.error || d.message || '').trim();
}

function apiErr(data, status) {
  const code = Number((data && data.error_code) || 0);
  const msg = detailOf(data) || `PikPak 回 HTTP ${status}`;
  return pkErr(code ? `PIKPAK_${code}` : `PIKPAK_HTTP_${status}`, code ? `PikPak 错误 ${code}：${msg}` : msg, { status });
}

/* ------------------------------------------------------------------ 请求 */

/** 一个请求该用哪枚验证码令牌：按「方法 + 资源」定动作（`files/<id>` 与 `files` 同属一个动作） */
function captchaActionOf(method, path) {
  const clean = String(path || '').split('?')[0].replace(/^\/+/, '');
  const seg = clean.split('/')[0] || 'files';
  return `${String(method || 'GET').toUpperCase()}:/drive/v1/${seg}`;
}

/**
 * 取某个动作的令牌：进程内缓存优先；没有就回落到 `auth.json` 里那枚（它就是「列目录」的）。
 * 回落只对 GET 有意义 —— 那几个 GET 共用一枚就够了（实测取任务、取单个文件都能过）。
 */
function captchaTokenOf(action, auth) {
  const hit = captchaByAction.get(action);
  if (hit) return hit;
  if (action.charAt(0) === 'G') return (auth && auth.captchaToken) || '';
  return '';
}

function headersFor(auth, captchaToken) {
  const a = auth || {};
  const h = {
    'User-Agent': fetcher.CHROME_UA,
    Accept: '*/*',
    'Content-Type': 'application/json',
    Origin: 'https://drive.mypikpak.com',
    Referer: 'https://drive.mypikpak.com/',
  };
  if (a.token) h.Authorization = 'Bearer ' + a.token;
  if (a.deviceId) h['X-Device-ID'] = a.deviceId;
  const ct = captchaToken === undefined ? a.captchaToken || '' : captchaToken;
  if (ct) h['X-Captcha-Token'] = ct;
  return h;
}

async function send(method, url, body, { timeout, auth, captchaToken } = {}) {
  const res = await fetcher.request(url, {
    method,
    headers: headersFor(auth, captchaToken),
    body: body === undefined || body === null ? undefined : body,
    timeout: timeout || 30000,
  });
  const data = res.json && typeof res.json === 'object' ? res.json : {};
  return { status: res.status, data };
}

/**
 * 驾驶舱接口（drive）通用一发：带令牌过期与验证码过期的自动补救，每种最多重试一次。
 * `path` 可以给相对路径（拼 `API_BASE`），登录/验证码那几个接口给完整地址。
 */
async function apiRequest(method, path, body, opts = {}) {
  const url = /^https?:\/\//.test(path) ? path : `${API_BASE}/${path}`;
  const auth = opts.auth || settings.readAuth();
  const action = captchaActionOf(method, path);
  const token = opts.captchaToken === undefined ? captchaTokenOf(action, auth) : opts.captchaToken;
  const res = await send(method, url, body, { timeout: opts.timeout, auth, captchaToken: token });
  const code = Number(res.data.error_code) || 0;
  const tokenBad = res.status === 401 || TOKEN_CODES.includes(code);
  const captchaBad = code === CAPTCHA_CODE;

  if (tokenBad || captchaBad) {
    if (opts.retried) throw apiErr(res.data, res.status);
    /* 令牌过期：走补救链（刷新令牌 → 账号密码；续期顺带会把「列目录」那枚换新）
     * 验证码过期：按**这一发的动作**重领 —— 令牌是按动作签发的，一律领列目录那枚解不了 POST */
    const fixed = tokenBad ? await recoverAuth(opts) : await mintCaptcha(action, opts);
    if (fixed) return apiRequest(method, path, body, Object.assign({}, opts, { retried: true, auth: null }));
    throw apiErr(res.data, res.status);
  }
  if (code) throw apiErr(res.data, res.status);
  return res.data;
}

/* ------------------------------------------------------------------ 登录 */

/** 设备 id：界面填了就用填的那个，否则按账号生成（刷新令牌那条路按令牌生成） */
function deviceIdFor(username, password, custom) {
  const c = String(custom || '').trim();
  if (c) return c;
  return md5(String(username || '') + String(password || ''));
}

/** 验证码签名：`client_id + 版本 + 包名 + 设备 id + 时间戳` 依次叠上那串算法 */
function captchaSign(deviceId) {
  const timestamp = String(Date.now());
  let str = CLIENT_ID + CLIENT_VERSION + PACKAGE_NAME + String(deviceId || '') + timestamp;
  for (const one of ALGORITHMS) str = md5(str + one);
  return { timestamp, sign: '1.' + str };
}

/**
 * 领一枚验证码令牌（只发这一发、不落盘 —— 缓存与持久化交给调用方）。
 * 拿不到就如实报，含「要人工验证」那种。
 */
async function initCaptcha(action, metas, opts = {}) {
  const auth = settings.readAuth();
  const body = {
    action,
    captcha_token: auth.captchaToken || '',
    client_id: CLIENT_ID,
    device_id: auth.deviceId || '',
    meta: metas || {},
    redirect_uri: CAPTCHA_REDIRECT,
  };
  const res = await send('POST', `${CAPTCHA_INIT}?client_id=${CLIENT_ID}`, body, { timeout: opts.timeout, auth });
  const data = res.data || {};
  if (data.captcha_token) return { ok: true, token: data.captcha_token };
  if (data.url) return { ok: false, message: `PikPak 要求人工验证（验证链接：${data.url}）` };
  return { ok: false, message: `验证码初始化没给令牌${detailOf(data) ? '：' + detailOf(data) : ''}` };
}

/**
 * 按动作领一枚并记住。「列目录」那枚顺带落盘：它是 GET 各发的兜底，
 * 重启之后进程内的表是空的，先拿它顶着，省掉一次「先失败再重领」。
 */
async function mintCaptcha(action, opts = {}) {
  const auth = settings.readAuth();
  const sign = captchaSign(auth.deviceId);
  const metas = {
    client_version: CLIENT_VERSION,
    package_name: PACKAGE_NAME,
    user_id: auth.userId || '',
    timestamp: sign.timestamp,
    captcha_sign: sign.sign,
  };
  const r = await initCaptcha(action, metas, opts);
  if (!r.ok) return false;
  captchaByAction.set(action, r.token);
  if (action === ACTION_FILES) settings.patchAuth({ captchaToken: r.token });
  return true;
}

/** 登录后补一枚「列目录」的验证码令牌（驾驶舱接口要带它） */
async function refreshCaptcha(opts = {}) {
  return mintCaptcha(ACTION_FILES, opts);
}

/** 刷新令牌换新令牌 */
async function refreshToken(opts = {}) {
  const auth = settings.readAuth();
  const rt = auth.refreshToken;
  if (!rt) return false;
  let res;
  try {
    res = await send(
      'POST',
      `${AUTH_TOKEN}?client_id=${CLIENT_ID}`,
      { client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: rt },
      { timeout: opts.timeout, auth: { deviceId: auth.deviceId || md5(rt) } }
    );
  } catch {
    return false;
  }
  const data = res.data || {};
  if (!data.access_token) return false;
  settings.patchAuth({
    token: data.access_token,
    refreshToken: data.refresh_token || rt,
    userId: data.sub || auth.userId,
  });
  /* 换了会话，按动作存的那几枚跟着作废（它们绑的是上一份会话），重新领 */
  captchaByAction.clear();
  await refreshCaptcha(opts);
  return true;
}

/** 账号密码登录（先领验证码令牌，再换令牌）；失败如实抛 */
async function signIn(opts = {}) {
  const auth = settings.readAuth();
  const username = auth.username;
  const password = auth.password;
  if (!username || !password) throw pkErr('NO_CREDENTIALS', '没有可用的账号密码：到插件设置页填一次');
  const deviceId = deviceIdFor(username, password, auth.deviceId);
  settings.patchAuth({ deviceId });

  const metas = { client_version: CLIENT_VERSION, package_name: PACKAGE_NAME };
  if (username.includes('@')) metas.email = username;
  else if (/^\d{8,18}$/.test(username)) metas.phone_number = username;
  else metas.username = username;
  const cap = await initCaptcha('POST:/v1/auth/signin', metas, opts);
  if (!cap.ok) throw pkErr('CAPTCHA_NEEDED', cap.message);

  const body = { client_id: CLIENT_ID, username, password };
  if (cap.token) body.captcha_token = cap.token;
  const res = await send('POST', `${AUTH_SIGNIN}?client_id=${CLIENT_ID}`, body, {
    timeout: opts.timeout,
    /* 刚领的这枚是「登录」动作的，请求头也带上它（照脚本那份：头与体带的是同一枚） */
    auth: Object.assign({}, settings.readAuth(), { captchaToken: cap.token || '' }),
  });
  const data = res.data || {};
  const token = data.access_token || data.token || '';
  if (!token) throw apiErr(data, res.status);
  settings.patchAuth({
    token,
    refreshToken: data.refresh_token || auth.refreshToken,
    userId: data.sub || '',
  });
  /* 新会话：按动作存的那几枚一并作废，重新领 */
  captchaByAction.clear();
  await refreshCaptcha(opts);
  return true;
}

/**
 * 令牌被判过期时的一发补救：刷新令牌 → 账号密码，每步只试一次，成败如实回。
 *
 * 刷新令牌那一步**救不回来是常态**：同账号在别处登录或刷新过，PikPak 会把旧刷新令牌作废
 * （实测回 `4126 invalid_grant`，提示 `may have been refreshed by other process`）。
 * 这种状态下若是只认刷新令牌，登录态一旦这样死掉就再也起不来 —— 每次播放都 502，只能手点重登。
 * 所以刷新失败必须能回落到账号密码。
 *
 * 账号密码那条路有风控代价，加一道时间闸：窗口内只放一次（见 `PASSWORD_LOGIN_COOLDOWN_MS`）。
 * 凭据正常时第一次就登成功、令牌换新，后续调用自然不会再走到这里；闸只挡「一直登不上」那种情况。
 */
async function recoverAuth(opts = {}) {
  try {
    if (await refreshToken(opts)) return true;
  } catch {
    /* 刷新这条路的异常当作「没刷成」，继续往下试账号密码 */
  }
  const auth = settings.readAuth();
  if (!auth.username || !auth.password) return false;
  /* 闸住期间**不动**时间戳：窗口自上次真正尝试起算（固定窗口）。
   * 若在这里也刷新时间戳，持续不断的重试会把窗口一路往后推，等于永远不放行。 */
  if (Date.now() - lastPasswordLoginAt < PASSWORD_LOGIN_COOLDOWN_MS) return false;
  lastPasswordLoginAt = Date.now();
  try {
    await signIn(opts);
    return true;
  } catch {
    return false;
  }
}

/**
 * 主动重登：刷新令牌 → 账号密码，依次试一遍，都不成如实抛。
 * 与 `recoverAuth` 的区别是**不看风控闸** —— 这是设置页上由人明确点的动作，
 * 不该被「自动补救刚试过」挡住。`loginNow` 用它。
 */
async function relogin(opts = {}) {
  const auth = settings.readAuth();
  if (auth.refreshToken && (await refreshToken(opts))) return true;
  if (auth.username && auth.password) {
    await signIn(opts);
    return true;
  }
  throw pkErr('NOT_LOGGED_IN', '既没有可用的刷新令牌，也没有账号密码：到插件设置页填一次');
}

/**
 * 保证有可用登录态：已有令牌直接用 → 刷新令牌 → 账号密码。
 * 三步都不成才抛（文案指向设置页，不做静默降级）。
 * 「已有令牌直接用」不加校验 —— 令牌若已死，各发请求会被 `apiRequest` 的补救链接手。
 */
async function ensureLogin(opts = {}) {
  const auth = settings.readAuth();
  if (auth.token) return auth;
  if (auth.refreshToken && (await refreshToken(opts))) return settings.readAuth();
  if (auth.username && auth.password) {
    await signIn(opts);
    return settings.readAuth();
  }
  throw pkErr('NOT_LOGGED_IN', '还没有登录 PikPak：到片源插件设置页填账号密码，或填一个刷新令牌');
}

/**
 * 设置页按「登录一下试试」用：如实回成功/失败，不抛。
 *
 * 关键是**实打一发**，而不是「盘上有令牌就报成功」—— 令牌可能已被别处登出或刷新作废，
 * 只看它存不存在，会把死令牌当活的报成功，手动重登入口也就形同虚设。
 * 现有令牌打得动就直接成功；打不动先走主动重登（刷新 → 账号密码）再实打一发确认。
 */
async function loginNow(opts = {}) {
  const t0 = Date.now();
  try {
    const auth = settings.readAuth();
    if (!auth.token && !auth.refreshToken && !(auth.username && auth.password)) {
      return { ok: false, ms: 0, error: '既没有令牌，也没有账号密码' };
    }
    try {
      await listFiles('', opts);
    } catch {
      /* 现有登录态打不动：主动重登一次（这一步不看风控闸），再实打一发 */
      await relogin(opts);
      await listFiles('', opts);
    }
    return { ok: true, ms: Date.now() - t0, userId: settings.readAuth().userId };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: (e && e.message) || String(e), code: (e && e.code) || '' };
  }
}

/* ------------------------------------------------------------------ 目录 */

/** 列一个目录下的文件（翻页到没有 next_page_token 为止） */
async function listFiles(parentId, opts = {}) {
  const out = [];
  const filters = JSON.stringify({ phase: { eq: 'PHASE_TYPE_COMPLETE' }, trashed: { eq: false } });
  let pageToken = '';
  for (let i = 0; i < 10; i += 1) {
    let path =
      `files?parent_id=${encodeURIComponent(String(parentId == null ? '' : parentId))}` +
      `&limit=100&thumbnail_size=SIZE_LARGE&with_audit=true&filters=${encodeURIComponent(filters)}`;
    if (pageToken) path += `&page_token=${encodeURIComponent(pageToken)}`;
    // eslint-disable-next-line no-await-in-loop
    const data = await apiRequest('GET', path, null, opts);
    for (const f of data.files || []) out.push(f);
    pageToken = data.next_page_token || '';
    if (!pageToken) break;
  }
  return out;
}

/** 保存目录 id：先验已存的那个，再按名字找，最后新建（新建后落盘，下次直接用） */
async function ensureSaveDir(opts = {}) {
  const name = settings.read().saveDir;
  const auth = settings.readAuth();
  if (auth.saveDirId) {
    try {
      await listFiles(auth.saveDirId, opts);
      return auth.saveDirId;
    } catch {
      /* 目录没了 / 令牌换了账号 —— 清掉重新找 */
      settings.patchAuth({ saveDirId: '' });
    }
  }
  const roots = await listFiles('', opts);
  const hit = roots.find((f) => f.kind === 'drive#folder' && f.name === name);
  if (hit) {
    const id = hit.id || hit.id_ || '';
    settings.patchAuth({ saveDirId: id });
    return id;
  }
  const created = await apiRequest('POST', 'files', { kind: 'drive#folder', name, parent_id: '' }, opts);
  const file = created.file || created;
  const id = file.id || file.id_ || '';
  if (!id) throw pkErr('NO_SAVE_DIR', `保存目录「${name}」没建起来`);
  settings.patchAuth({ saveDirId: id });
  return id;
}

/* --------------------------------------------------------- 离线下载与播放 */

/** 提交一个磁力。回 `{ taskId, fileId }`（`fileId` 有值 = 这个磁力已在云里，秒完成） */
async function submitMagnet(magnet, name, saveDirId, opts = {}) {
  const body = {
    kind: 'drive#file',
    name: String(name || '磁力链接'),
    upload_type: 'UPLOAD_TYPE_URL',
    url: { url: String(magnet) },
    folder_type: '',
  };
  if (saveDirId) body.parent_id = saveDirId;
  const data = await apiRequest('POST', 'files', body, opts);
  const task = data.task || {};
  const file = data.file || {};
  const taskId = task.id || '';
  const done = task.phase === 'PHASE_TYPE_COMPLETE';
  const fileId = (done && (task.file_id || (task.params && task.params.file_id))) || file.id || file.id_ || '';
  return { taskId, fileId: fileId || '' };
}

/** 轮询一个离线任务到 `deadlineAt`；完成回文件 id，失败抛，超时回空串（不编结果） */
async function waitTask(taskId, deadlineAt, opts = {}) {
  if (!taskId) return '';
  const filters = JSON.stringify({
    phase: { in: 'PHASE_TYPE_RUNNING,PHASE_TYPE_COMPLETE,PHASE_TYPE_ERROR,PHASE_TYPE_PENDING' },
  });
  while (Date.now() < deadlineAt) {
    let data = null;
    try {
      // eslint-disable-next-line no-await-in-loop
      data = await apiRequest(
        'GET',
        `tasks?task_ids=${encodeURIComponent(taskId)}&type=offline&filters=${encodeURIComponent(filters)}`,
        null,
        opts
      );
    } catch (e) {
      if (e && e.code && String(e.code).startsWith('PIKPAK_')) throw e;
      data = null;
    }
    const task = data && (data.tasks || [])[0];
    if (task) {
      const phase = task.phase || '';
      if (phase === 'PHASE_TYPE_COMPLETE') {
        return task.file_id || (task.params && task.params.file_id) || '';
      }
      if (phase === 'PHASE_TYPE_ERROR' || phase === 'PHASE_TYPE_FAILED') {
        throw pkErr('TASK_FAILED', `离线下载失败：${task.message || task.status || '未给原因'}`);
      }
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 1000));
  }
  return '';
}

/**
 * 播放直链的缓存存活期。
 *
 * PikPak 的直链**带签名、有时效**，但时效多久面板这边观察不到（面板只做 302，之后客户端
 * 直连 CDN，CDN 的回应不会回到这里）—— 所以取一个**保守的短窗口**：客户端一次播放里
 * 连番的 Range 请求都落在窗口内，能被同一条地址吃下；窗口外宁可重新解析一次，
 * 也不冒「把过期地址钉在缓存里」的险。若实测链接更短，把它调小即可。
 */
const PLAY_URL_TTL_MS = 5 * 60 * 1000;

/**
 * 一个文件 id → 带签名的播放地址。
 *
 * **带缓存**（表 `playurl`，键 = 网盘文件 id）：客户端一次播放会反复拉流 ——
 * 面板每个 Range 请求都要解析一次地址，不缓存就每次都重新走一遍解析链、
 * 每次落到**不同的 CDN 节点**（实测同一文件在 `dl-z01a-00XX` 各节点速度差异极大），
 * 既慢又不稳。`opts.force` 跳过缓存，用于「明知手上那条坏了、要重取」的场合。
 */
async function getPlayUrl(fileId, opts = {}) {
  const key = String(fileId || '').trim();
  if (key && !opts.force) {
    const hit = cachedPlayUrl(key);
    if (hit && hit.url) return Object.assign({}, hit, { cached: true });
  }
  const data = await apiRequest('GET', `files/${encodeURIComponent(fileId)}?_magic=2021&usage=CACHE&thumbnail_size=SIZE_LARGE`, null, opts);
  const file = data.file || data;
  let url = file.web_content_link || '';
  let resolution = '';
  const medias = file.medias || [];
  if (medias.length) {
    const m = medias[0] || {};
    if (m.link && m.link.url) url = m.link.url;
    resolution = m.resolution || '';
  }
  if (!url) return null;
  const one = {
    name: file.name || '',
    url,
    size: Number(file.size) || 0,
    resolution,
    fileExtension: file.file_extension || '',
  };
  /* 存进去的是干净的取值；`cached` 只在返回时附加，别把 true/false 一起落盘 */
  if (key) cache.put('playurl', key, one, PLAY_URL_TTL_MS);
  return Object.assign({}, one, { cached: false });
}

/** 读缓存：缓存出任何差错都不该影响取地址本身（插件未绑定数据目录时也不该炸） */
function cachedPlayUrl(key) {
  try {
    return cache.get('playurl', key);
  } catch {
    return null;
  }
}

/**
 * 一批文件移进回收站（**软删除**，可恢复）—— 设置页的「手动清理」用。
 * 走 `files:batchTrash`；另有 `files:batchDelete` 是永久删除，这里不用它：
 * 清理是「把占地方的下完的东西挪走」，误点了还能捞回来。
 */
async function trashFiles(ids, opts = {}) {
  const list = (ids || []).map((x) => String(x || '').trim()).filter(Boolean);
  if (!list.length) return 0;
  const data = await apiRequest('POST', 'files:batchTrash', { ids: list }, opts);
  /* 各家实现对这个接口的回应不一致（有的回 `deleted`，有的只在 `files` 里列明细），
   * 认不出来就按请求条数如实回，不编一个更漂亮的数。 */
  const n = Array.isArray(data.files) ? data.files.length : Number(data.deleted);
  return Number.isFinite(n) && n > 0 ? n : list.length;
}

module.exports = {
  CLIENT_ID,
  CLIENT_VERSION,
  PACKAGE_NAME,
  deviceIdFor,
  captchaSign,
  ensureLogin,
  loginNow,
  refreshToken,
  refreshCaptcha,
  signIn,
  listFiles,
  ensureSaveDir,
  submitMagnet,
  waitTask,
  getPlayUrl,
  trashFiles,
};