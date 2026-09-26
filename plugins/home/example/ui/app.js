'use strict';
/**
 * 首页示例插件 · 设置页前端。
 *
 * 所有请求都打到**面板的转发通道**：`/api/plugins/<类型>/<id>/api/**` ——
 * 面板把它转成动作 `http`，由插件的 `index.js` 处理（面板不解释内容）。
 *
 * 路径是**算出来的**，不写死类型与 id：页面自己的地址是
 * `/api/plugins/home/example/ui/index.html`，把 `/ui/…` 之后切掉就得到通道前缀。
 */
const API = location.pathname.replace(/\/ui\/.*$/, '') + '/api';

const $ = (id) => document.getElementById(id);

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    throw new Error(`面板回的不是 JSON（HTTP ${res.status}）`);
  }
  if (!res.ok || data.ok === false) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

let msgTimer = null;
function say(text, bad = false) {
  const el = $('msg');
  el.textContent = text || '';
  el.style.color = bad ? 'var(--err)' : 'var(--accent)';
  if (msgTimer) clearTimeout(msgTimer);
  msgTimer = setTimeout(() => {
    el.textContent = '';
  }, 4000);
}

/** 一个单元格：左边名字、右边值（自检结果里那几行都用它） */
function kvRow(k, v) {
  const row = document.createElement('div');
  row.className = 'kv';
  const kk = document.createElement('span');
  kk.className = 'k';
  kk.textContent = k;
  const vv = document.createElement('span');
  vv.className = 'v';
  vv.textContent = v;
  row.append(kk, vv);
  return row;
}

/* ---------------------------------------------------------------- 连接设置 */

function fill(s) {
  $('apiBase').value = s.settings.apiBase || '';
  $('imageBase').value = s.settings.imageBase || '';
  $('language').value = s.settings.language || '';
  $('token').placeholder = s.settings.tokenSet ? `留空 = 不改（已配 ${s.settings.tokenLength} 位）` : 'v4 API Read Access Token';
  const badge = $('tokenState');
  badge.textContent = s.settings.tokenSet ? 'Token 已配' : 'Token 没配';
  badge.className = 'badge ' + (s.settings.tokenSet ? 'ok' : 'err');
}

function formValues() {
  return {
    apiBase: $('apiBase').value.trim(),
    imageBase: $('imageBase').value.trim(),
    language: $('language').value.trim(),
  };
}

async function save() {
  const btn = $('save');
  btn.disabled = true;
  try {
    const body = formValues();
    const token = $('token').value.trim();
    if (token) body.token = token;
    await call('/settings', { method: 'POST', body });
    $('token').value = '';
    fill(await call('/state'));
    $('savedAt').textContent = '已保存 · ' + new Date().toLocaleTimeString();
    say('已保存');
  } catch (e) {
    say('保存失败：' + e.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function clearToken() {
  if (!confirm('清掉这个首页插件里保存的 TMDB Token？（元数据插件那份不受影响）')) return;
  try {
    await call('/settings', { method: 'POST', body: { clearToken: true } });
    fill(await call('/state'));
    say('Token 已清除');
  } catch (e) {
    say('清除失败：' + e.message, true);
  }
}

/* ---------------------------------------------------------------- 自检 */

/** 失败的「大类」—— 一眼分清是网不通、没配对，还是上游自己的问题 */
function errKind(err) {
  const code = (err && err.code) || 'NETWORK';
  if (code === 'NO_TOKEN') return '没配 Token';
  if (code === 'INVALID_TOKEN') return 'Token 不对';
  if (code === 'NOT_FOUND') return '探测对象不存在';
  if (code === 'TIMEOUT' || code === 'NETWORK') return '网络错误';
  if (code === 'UPSTREAM_HTTP') return '上游故障';
  return code;
}

const ERR_HINT = {
  网络错误: '这台机器连不上 TMDB（网络不通，或者 API 基地址填错了）。',
  上游故障: 'TMDB 自己回错了（5xx），跟设置无关，过会儿再试。',
  '没配 Token': '填一个 v4 API Read Access Token 再测。',
  'Token 不对': 'Token 无效或没有权限，换一个再试。',
  探测对象不存在: 'TMDB 里没有这个编号，换个探测对象试试。',
};

function paintTest(r) {
  const host = $('testOut');
  host.textContent = '';
  if (r.error) {
    const kind = errKind(r.error);
    host.append(
      kvRow('结论', `${kind} —— ${ERR_HINT[kind] || ''}`),
      kvRow('原因', `${r.error.code || ''} ${r.error.message || ''}`),
      kvRow('其中一步', `auth=${(r.auth && r.auth.status) || '-'} · api=${r.apiBase} · ${r.elapsedMs}ms`)
    );
    return;
  }
  host.append(
    kvRow('结论', `通（${r.elapsedMs}ms）`),
    kvRow('探测对象', `${r.probe.type}/${r.probe.tmdbId} · ${r.item.title}${r.item.year ? '（' + r.item.year + '）' : ''}`),
    kvRow('Token', `已配 ${r.tokenLength} 位`),
    kvRow('语言', r.language),
    kvRow('API', r.apiBase),
    kvRow('图片基地址', `${r.imageBase}　（TMDB 官方给的是 ${(r.images && r.images.secureBaseUrl) || '-'}）`)
  );
  if (r.item.poster) {
    const img = document.createElement('img');
    img.className = 'shot';
    img.src = r.item.poster;
    img.alt = '';
    img.style.marginTop = '8px';
    host.append(img);
  }
}

async function test() {
  const btn = $('test');
  btn.disabled = true;
  $('testOut').textContent = '';
  try {
    paintTest(await call('/test', { method: 'POST', body: formValues() }));
  } catch (e) {
    say('测试失败：' + e.message, true);
  } finally {
    btn.disabled = false;
  }
}

/* ---------------------------------------------------------------- 行参数 */

/** 当前值：用户存过的优先，没有就用行声明的默认值 */
function currentValue(rowId, p, saved) {
  const one = saved[rowId];
  if (one && Object.prototype.hasOwnProperty.call(one, p.name)) return one[p.name];
  return p.value;
}

/** 一个参数的控件：枚举 → 下拉；条数 → 数字；其余 → 文本框（带可选候选项） */
function paramControl(rowTitle, p, value) {
  let input;
  if (p.type === 'enumeration') {
    input = document.createElement('select');
    for (const o of p.enumOptions || []) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.title;
      input.append(opt);
    }
    input.value = String(value ?? '');
    if (input.selectedIndex < 0) input.selectedIndex = 0;
  } else if (p.type === 'count') {
    input = document.createElement('input');
    input.type = 'number';
    input.value = String(value ?? '');
  } else {
    input = document.createElement('input');
    input.type = 'text';
    input.value = String(value ?? '');
    if (p.description) input.placeholder = p.description;
    const list = (p.placeholders || []);
    if (list.length) {
      const id = 'pl_' + p.name + '_' + Math.random().toString(36).slice(2, 7);
      input.setAttribute('list', id);
      const dl = document.createElement('datalist');
      dl.id = id;
      for (const ph of list) {
        const opt = document.createElement('option');
        opt.value = ph.value;
        opt.textContent = ph.title;
        dl.append(opt);
      }
      input.append(dl);
    }
  }
  input.dataset.row = rowTitle;
  input.dataset.param = p.name;
  input.dataset.type = p.type || 'input';
  input.dataset.dft = String(p.value ?? '');

  const label = document.createElement('label');
  label.className = 'field';
  const cap = document.createElement('span');
  cap.textContent = p.title || p.name;
  label.append(cap, input);
  return label;
}

/** 画行清单：一行一块，块里是这行的参数控件 */
function renderRows(rows, saved) {
  const host = $('rowsOut');
  host.textContent = '';
  for (const row of rows || []) {
    const block = document.createElement('div');
    block.className = 'rowblock';

    const head = document.createElement('div');
    head.className = 'head';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = row.title;
    head.append(name);
    const badge = document.createElement('span');
    const CT = { movies: '电影库', tvshows: '剧库', mixed: '混合库' };
    badge.className = 'badge';
    badge.textContent = CT[row.collectionType] || '混合库';
    head.append(badge);
    if (row.feed) head.append(kvRow('', `feed=${row.feed}`));
    const meta = document.createElement('span');
    meta.className = 'muted';
    meta.textContent = `${row.id}　缓存 ${row.cacheDuration ? row.cacheDuration + 's' : '关'}`;
    head.append(meta);
    block.append(head);

    const params = document.createElement('div');
    params.className = 'params';
    const decls = row.params || [];
    if (!decls.length) {
      const none = document.createElement('div');
      none.className = 'hint';
      none.textContent = '这一行没有可调参数。';
      params.append(none);
    }
    for (const p of decls) params.append(paramControl(row.id, p, currentValue(row.id, p, saved)));
    block.append(params);
    host.append(block);
  }
}

/** 收整页的行参数：**只记改动过的**（等于默认值的就不写，配置文件才不会被默认值冻住） */
function collectRowParams() {
  const out = {};
  for (const input of $('rowsOut').querySelectorAll('[data-param]')) {
    const rowId = input.dataset.row;
    const name = input.dataset.param;
    const val = input.value;
    if (String(val) === String(input.dataset.dft)) continue;
    if (!out[rowId]) out[rowId] = {};
    out[rowId][name] = input.dataset.type === 'count' ? Number(val) || 0 : val;
  }
  return out;
}

async function saveRows() {
  const btn = $('saveRows');
  btn.disabled = true;
  try {
    await call('/settings', { method: 'POST', body: { rowParams: collectRowParams() } });
    /* 存完重画：库类型跟着参数走，界面上那张「电影库 / 剧库」的牌子要立刻对上 */
    const state = await call('/state');
    renderRows(state.rows, state.rowParams);
    say('行参数已保存（客户端下次拉媒体库时生效）');
  } catch (e) {
    say('保存行参数失败：' + e.message, true);
  } finally {
    btn.disabled = false;
  }
}

/* ---------------------------------------------------------------- 启动 */

async function load() {
  try {
    const state = await call('/state');
    $('testOut').textContent = '';
    fill(state);
    renderRows(state.rows, state.rowParams);
  } catch (e) {
    say('读设置失败：' + e.message, true);
  }
}

$('save').addEventListener('click', save);
$('test').addEventListener('click', test);
$('clearToken').addEventListener('click', clearToken);
$('saveRows').addEventListener('click', saveRows);

load();