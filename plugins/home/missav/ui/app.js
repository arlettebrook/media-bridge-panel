'use strict';
/**
 * MissAV 首页插件 · 设置页前端。
 *
 * 所有请求都打到**面板的转发通道**：`/api/plugins/<类型>/<id>/api/**` ——
 * 面板把它转成动作 `http`，由插件的 `index.js` 处理（面板不解释内容）。
 *
 * 路径是**算出来的**，不写死类型与 id：页面自己的地址是
 * `/api/plugins/home/missav/ui/index.html`，把 `/ui/…` 之后切掉就得到通道前缀。
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
  $('siteBase').value = s.settings.siteBase === s.defaults.siteBase ? '' : s.settings.siteBase;
  $('imageBase').value = s.settings.imageBase === s.defaults.imageBase ? '' : s.settings.imageBase;
  $('siteBase').placeholder = `留空 = ${s.defaults.siteBase}`;
  $('imageBase').placeholder = `留空 = ${s.defaults.imageBase}`;
  const badge = $('cacheBadge');
  badge.textContent = `缓存 ${s.cache.entries} 项 · ${(s.cache.bytes / 1024).toFixed(1)} KB`;
  badge.className = 'badge ' + (s.cache.entries ? 'ok' : '');
}

function formValues() {
  return { siteBase: $('siteBase').value.trim(), imageBase: $('imageBase').value.trim() };
}

async function save() {
  const btn = $('save');
  btn.disabled = true;
  try {
    await call('/settings', { method: 'POST', body: formValues() });
    fill(await call('/state'));
    $('savedAt').textContent = '已保存 · ' + new Date().toLocaleTimeString();
    say('已保存');
  } catch (e) {
    say('保存失败：' + e.message, true);
  } finally {
    btn.disabled = false;
  }
}

/* ---------------------------------------------------------------- 自检 */

/** 失败的「大类」—— 一眼分清是网不通、地址填错，还是站点自己出问题 */
function errKind(err) {
  const code = (err && err.code) || 'NETWORK';
  if (code === 'RISK_CONTROL') return '站点风控';
  if (code === 'TIMEOUT' || code === 'NETWORK') return '网络错误';
  if (code === 'UPSTREAM_HTTP') return '上游故障';
  if (code === 'BAD_PARAM') return '地址没填';
  return code;
}

const ERR_HINT = {
  网络错误: '这台机器连不上站点（网络不通，或者站点基地址填错了）。',
  站点风控: '站点回了风控页（响应过短）。换个基地址，或者过一会儿再试。',
  上游故障: '站点自己回错了（跳转或不正常状态码），跟设置无关。',
};

function paintTest(r) {
  const host = $('testOut');
  host.textContent = '';
  if (r.error) {
    const kind = errKind(r.error);
    host.append(
      kvRow('结论', `${kind} —— ${ERR_HINT[kind] || ''}`),
      kvRow('原因', `${r.error.code || ''} ${r.error.message || ''}`),
      kvRow('地址', r.siteBase)
    );
    return;
  }
  host.append(
    kvRow('结论', `通（${r.elapsedMs}ms）`),
    kvRow('这一页', r.url),
    kvRow('拿到条目', `${r.count} 条（分页条显示共 ${r.totalPages || '?'} 页）`),
    kvRow('第一条', r.first ? r.first.title : '（这一页没解析出条目）')
  );
  if (r.first && r.first.poster) {
    const img = document.createElement('img');
    img.className = 'shot';
    img.src = r.first.poster;
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

/* ---------------------------------------------------------------- 缓存 */

async function clearCache() {
  if (!confirm('清空这个首页插件的取数缓存？（设置与行参数不受影响）')) return;
  try {
    const r = await call('/cache/clear', { method: 'POST', body: {} });
    const badge = $('cacheBadge');
    badge.textContent = `缓存 ${r.cache.entries} 项 · ${(r.cache.bytes / 1024).toFixed(1)} KB`;
    badge.className = 'badge';
    say('缓存已清空');
  } catch (e) {
    say('清空失败：' + e.message, true);
  }
}

/* ---------------------------------------------------------------- 行参数 */

/** 当前值：用户存过的优先，没有就用行声明的默认值 */
function currentValue(rowId, p, saved) {
  const one = saved[rowId];
  if (one && Object.prototype.hasOwnProperty.call(one, p.name)) return one[p.name];
  return p.value;
}

/** 一个参数的控件：枚举 → 下拉；其余 → 文本框 */
function paramControl(rowId, p, value) {
  let input;
  if (p.type === 'enumeration') {
    input = document.createElement('select');
    for (const o of p.enumOptions || []) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.title;
      input.append(opt);
    }
    input.value = String(value === undefined || value === null ? '' : value);
    if (input.selectedIndex < 0) input.selectedIndex = 0;
  } else {
    input = document.createElement('input');
    input.type = 'text';
    input.value = String(value === undefined || value === null ? '' : value);
    if (p.description) input.placeholder = p.description;
    const list = p.placeholders || [];
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
  input.dataset.row = rowId;
  input.dataset.param = p.name;
  input.dataset.type = p.type || 'input';
  input.dataset.dft = String(p.value === undefined || p.value === null ? '' : p.value);

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
    const meta = document.createElement('span');
    meta.className = 'muted';
    meta.textContent = `${row.id}　缓存 ${row.cacheDuration ? row.cacheDuration + 's' : '关'}`;
    head.append(meta);
    block.append(head);

    const params = document.createElement('div');
    params.className = 'params';
    for (const p of row.params || []) params.append(paramControl(row.id, p, currentValue(row.id, p, saved)));
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
    out[rowId][name] = val;
  }
  return out;
}

async function saveRows() {
  const btn = $('saveRows');
  btn.disabled = true;
  try {
    await call('/settings', { method: 'POST', body: { rowParams: collectRowParams() } });
    /* 存完重画：设置页上看到的就是现在生效的那份 */
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
$('clearCache').addEventListener('click', clearCache);
$('saveRows').addEventListener('click', saveRows);

load();