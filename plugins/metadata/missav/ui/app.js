'use strict';
/**
 * MissAV 元数据设置页的前端。
 *
 * 所有请求都打到**面板的转发通道**：`/api/plugins/<类型>/<id>/api/**` ——
 * 面板把它转成动作 `http`，由插件的 `index.js` 处理（面板不解释内容）。
 *
 * 路径是**算出来的**，不写死类型与 id：页面自己的地址是
 * `/api/plugins/metadata/missav/ui/index.html`，把 `/ui/…` 之后切掉就得到通道前缀。
 * 这样换 id、换类型都不用改这里（也不能写成 `./api/x` —— 那是相对 `ui/` 目录解析的）。
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

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(2)} MB`;
}

const fmtDays = (ms) => {
  const d = (Number(ms) || 0) / 86400000;
  return d >= 1 ? `${Math.round(d)} 天` : `${Math.round((Number(ms) || 0) / 3600000)} 小时`;
};

/* ---------------------------------------------------------------- 设置 */

function fill(s) {
  $('siteBase').value = s.settings.siteBase || '';
  $('imageBase').value = s.settings.imageBase || '';
  $('language').value = s.settings.language || '';
  $('cacheTtlDays').value = s.settings.cacheTtlDays;
  $('cacheMaxMB').value = s.settings.cacheMaxMB;
  $('siteBase').placeholder = `留空 = ${s.official.siteBase}`;
  $('imageBase').placeholder = `留空 = ${s.official.imageBase}`;
  paintCache(s.cache);
}

function formValues() {
  return {
    siteBase: $('siteBase').value.trim(),
    imageBase: $('imageBase').value.trim(),
    language: $('language').value.trim(),
    cacheTtlDays: Number($('cacheTtlDays').value),
    cacheMaxMB: Number($('cacheMaxMB').value),
  };
}

async function save() {
  const btn = $('save');
  btn.disabled = true;
  try {
    const out = await call('/settings', { method: 'POST', body: formValues() });
    fill(out);
    $('savedAt').textContent = '已保存 · ' + new Date().toLocaleTimeString();
    say('已保存');
  } catch (e) {
    say('保存失败：' + e.message, true);
  } finally {
    btn.disabled = false;
  }
}

/* ---------------------------------------------------------------- 自检 */

/** 失败的「大类」—— 一眼分清是网不通，还是上游拦了 */
function errKind(err) {
  const code = (err && err.code) || 'NETWORK';
  if (code === 'NOT_FOUND') return '页面不存在';
  if (code === 'TIMEOUT' || code === 'NETWORK') return '网络错误';
  if (code === 'UPSTREAM_HTTP') return '上游故障或被拦';
  return code;
}

const ERR_HINT = {
  网络错误: '面板这台机器连不上站点（网络不通，或者站点基地址填错了）。',
  '上游故障或被拦': '站点返回非 200，或响应过短被判为风控；换个镜像基地址再试。',
  页面不存在: '搜索页不存在，多半是语言段填错了。',
};

function paintTest(r) {
  const host = $('testOut');
  host.textContent = '';
  const line = (k, v) => {
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
  };

  if (r.error) {
    const kind = errKind(r.error);
    host.append(
      line('结论', `${kind} —— ${ERR_HINT[kind] || ''}`),
      line('原因', `${r.error.code || ''} ${r.error.message || ''}`),
      line('其中一步', `status=${r.status || '-'} · 站点=${r.siteBase} · ${r.elapsedMs}ms`)
    );
    return;
  }

  host.append(
    line('结论', `通（${r.elapsedMs}ms）`),
    line('探测词', `${r.probe.wd} · 解析到 ${r.rows} 条候选`),
    line('语言段', r.language),
    line('站点', r.siteBase),
    line('封面基地址', r.imageBase)
  );
  if (r.sample) {
    host.append(line('首条', `${r.sample.title}（${r.sample.entryId}）`));
    if (r.sample.posterPath) {
      const row = document.createElement('div');
      row.className = 'row';
      row.style.marginTop = '8px';
      const img = document.createElement('img');
      img.className = 'shot';
      img.src = r.sample.posterPath;
      img.alt = '';
      row.append(img);
      host.append(row);
    }
  }
}

async function test() {
  const btn = $('test');
  btn.disabled = true;
  $('testOut').textContent = '';
  try {
    paintTest(await call('/test', { method: 'POST', body: { form: formValues() } }));
  } catch (e) {
    say('测试失败：' + e.message, true);
  } finally {
    btn.disabled = false;
  }
}

/* ---------------------------------------------------------------- 缓存 */

function paintCache(c) {
  const host = $('cacheOut');
  host.textContent = '';
  const table = document.createElement('table');
  const head = document.createElement('thead');
  const hr = document.createElement('tr');
  const cols = ['表', '条数', '已用', '上限', '存活期'];
  for (const t of cols) {
    const th = document.createElement('th');
    th.textContent = t;
    hr.append(th);
  }
  head.append(hr);
  const body = document.createElement('tbody');
  const rows = [
    ['影片页解析结果', c.tables.meta],
    ['搜索词候选列表', c.tables.names],
  ];
  for (const [label, one] of rows) {
    const tr = document.createElement('tr');
    const cells = [label, String(one.rows), fmtBytes(one.bytes), one.maxBytes ? fmtBytes(one.maxBytes) : '不限', fmtDays(one.ttlMs)];
    cells.forEach((text, i) => {
      const td = document.createElement('td');
      td.textContent = text;
      /* 窄屏上表头不显示（表格摊成卡片）—— 每格自带列名，不然值看不出是哪一栏 */
      td.dataset.label = cols[i];
      tr.append(td);
    });
    body.append(tr);
  }
  table.append(head, body);
  host.append(table);
  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent = `合计 ${c.rows} 条 · ${fmtBytes(c.bytes)}（目录：${c.dir}）`;
  host.append(hint);
}

async function loadCache() {
  try {
    paintCache(await call('/cache'));
  } catch (e) {
    say('读缓存用量失败：' + e.message, true);
  }
}

async function clearCache() {
  if (!confirm('清空插件自己的这两个缓存？（都是可丢弃数据，下次用会重新抓）')) return;
  try {
    const out = await call('/cache/clear', { method: 'POST', body: {} });
    paintCache(out.cache);
    say('缓存已清空');
  } catch (e) {
    say('清空失败：' + e.message, true);
  }
}

/* ---------------------------------------------------------------- 启动 */

async function load() {
  try {
    fill(await call('/settings'));
  } catch (e) {
    say('读设置失败：' + e.message, true);
  }
}

$('save').addEventListener('click', save);
$('test').addEventListener('click', test);
$('cacheReload').addEventListener('click', loadCache);
$('cacheClear').addEventListener('click', clearCache);

load();