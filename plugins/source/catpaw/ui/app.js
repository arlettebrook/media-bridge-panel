'use strict';
/**
 * 猫爪源设置页的前端。
 *
 * 所有请求都打到**面板的转发通道**：`/api/plugins/<类型>/<id>/api/**` ——
 * 面板把它转成动作 `http`，由插件的 `index.js` 处理（面板不解释内容）。
 *
 * ⚠️ 路径是**算出来的**，不写死类型与 id：页面自己的地址是
 * `/api/plugins/source/catpaw/ui/index.html`，把 `/ui/…` 之后切掉就得到通道前缀。
 * 这样换 id、换类型都不用改这里（也不该依赖 `./api/x` —— 那是相对 `ui/` 目录解析的）。
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

/** 面板与插件之间传的是 JSON，所以这里一律用 DOM 建节点，不拼 HTML 串 */
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'onclick') n.addEventListener('click', v);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, String(v));
  }
  for (const k of kids) if (k) n.append(k);
  return n;
}

function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtUp(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  return `${Math.floor(s / 3600)} 时 ${Math.floor((s % 3600) / 60)} 分`;
}

const STATUS_TEXT = { running: '运行中', starting: '启动中', stopping: '停止中', stopped: '已停止', error: '异常' };

/** 配置中心的地址：**直连实例端口**（面板不再在中间代理）。
 *  端口没发布到宿主机时浏览器连不上 —— 那是部署的事，这里如实给出地址。 */
function configUrl(one) {
  return `http://${location.hostname}:${one.port}/website`;
}

function statusBadge(one) {
  const cls = one.status === 'running' ? 'ok' : one.status === 'error' ? 'err' : one.status === 'starting' ? 'warn' : '';
  return el('span', { class: 'badge ' + cls }, el('span', { class: 'dot ' + (one.status || '') }), STATUS_TEXT[one.status] || one.status || '—');
}

function instanceRow(one) {
  const ops = el('td', { class: 'ops' });
  const busy = (btn) => {
    btn.disabled = true;
    btn.textContent = '…';
  };
  const act = (op, label, cls) =>
    el('button', {
      class: 'btn mini ' + (cls || ''),
      text: label,
      title: op ? `对这个实例执行 ${op}` : label,
      onclick: async (e) => {
        busy(e.target);
        try {
          await call(`/instances/${encodeURIComponent(one.id)}/${op}`, { method: 'POST' });
          say(`${one.id} ${label}完成`);
        } catch (err) {
          say(`${one.id} ${label}失败：${err.message}`, true);
        }
        await load();
      },
    });

  if (one.mode === 'local') {
    if (one.status === 'running') ops.append(act('stop', '停止'), act('restart', '重启'));
    else ops.append(act('start', '启动', 'primary'));
    ops.append(act('update', '更新'));
  }
  if (one.port) {
    ops.append(
      el('a', { class: 'btn mini', href: configUrl(one), target: '_blank', rel: 'noreferrer', text: '配置中心' })
    );
  }
  ops.append(
    el('button', {
      class: 'btn mini danger',
      text: '删除',
      onclick: async (e) => {
        if (!window.confirm(`删除实例「${one.name || one.id}」？它下载的源包与运行数据会一起删掉。`)) return;
        busy(e.target);
        try {
          await call(`/instances/${encodeURIComponent(one.id)}`, { method: 'DELETE' });
          say(`已删除 ${one.id}`);
        } catch (err) {
          say(`删除失败：${err.message}`, true);
        }
        await load();
      },
    })
  );

  const nameTd = el('td');
  nameTd.append(
    el('div', { text: one.name || '(未命名)' }),
    el('div', { class: 'muted mono', style: 'font-size:12px', text: one.id })
  );

  const whereTd = el('td');
  whereTd.append(
    el('div', { text: one.where }),
    /* 窄屏下表头不显示（表格摊成卡片），两行地址各自带个小标签，不然看不出哪条是哪条 */
    el('div', {
      class: 'muted mono',
      style: 'font-size:12px;word-break:break-all',
      text: (one.mode === 'local' ? '源包 ' : '服务 ') + (one.sourceUrl || ''),
    })
  );

  const addrTd = el('td');
  addrTd.append(
    el('div', { class: 'mono', style: 'font-size:12px;word-break:break-all', text: (one.mode === 'local' ? '服务 ' : '') + (one.url || '（没在服务）') }),
    el('div', { class: 'muted', style: 'font-size:12px', text: one.mode === 'local' ? `已跑 ${fmtUp(one.startedAt ? Date.now() - one.startedAt : 0)}` : '' })
  );

  const flagsTd = el('td');
  flagsTd.append(el('div', { class: one.enabled ? 'badge ok' : 'badge', text: one.enabled ? '参与聚合' : '不参与聚合' }));
  /* ⚠️ 不能用 `append(x ? el() : null)` —— DOM 会把 null 变成一个写着 "null" 的文本节点（实测）。
   * 本地部署才有"开机自启"这一项，外部地址那一栏就真的不加。 */
  if (one.mode === 'local') {
    flagsTd.append(el('div', { class: one.autostart ? 'badge ok' : 'badge', style: 'margin-top:4px', text: one.autostart ? '开机自启' : '不自启' }));
  }

  const statusTd = el('td');
  statusTd.append(statusBadge(one));
  if (one.error) statusTd.append(el('div', { class: 'err', style: 'margin-top:6px;max-width:420px', text: one.error }));
  if (one.tail && one.tail.length) statusTd.append(el('div', { class: 'muted mono', style: 'font-size:11px;margin-top:4px', text: one.tail.slice(-2).join(' / ') }));

  return el('tr', {}, nameTd, whereTd, addrTd, flagsTd, statusTd, ops);
}

function paintInstances(list) {
  const host = $('instHost');
  host.textContent = '';
  if (!list.length) {
    host.append(el('div', { class: 'hint warn', text: '还没有实例。下面加一个：本地部署（填源包地址）或外部地址（填已经在跑的源地址）。' }));
    return;
  }
  const table = el('table');
  table.append(
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        el('th', { text: '实例' }),
        el('th', { text: '方式' }),
        el('th', { text: '现在服务的地址' }),
        el('th', { text: '标记' }),
        el('th', { text: '状态' }),
        el('th', { text: '' })
      )
    )
  );
  const body = el('tbody');
  for (const one of list) body.append(instanceRow(one));
  table.append(body);
  host.append(table);
}

function paintAutoUpdate(au, results) {
  $('auEnabled').checked = !!au.enabled;
  $('auHours').value = au.hours || 12;
  const bits = [];
  if (au.running) bits.push('正在检查');
  if (au.lastRunAt) bits.push(`上次 ${fmtTime(au.lastRunAt)}（${au.lastReason || '-'}）`);
  if (au.nextRunAt) bits.push(`下次 ${fmtTime(au.nextRunAt)}`);
  $('auState').textContent = bits.join(' · ') || '还没跑过';

  const host = $('auResults');
  host.textContent = '';
  const rows = results || au.results || [];
  if (!rows.length) return;
  const table = el('table');
  table.append(
    el('thead', {}, el('tr', {}, el('th', { text: '实例' }), el('th', { text: '结果' }), el('th', { text: '说明' })))
  );
  const body = el('tbody');
  for (const r of rows) {
    body.append(
      el(
        'tr',
        {},
        el('td', { text: r.name || r.id }),
        el('td', {}, el('span', { class: 'badge ' + (r.ok ? 'ok' : 'err'), text: r.ok ? (r.changed ? '有新版' : '已最新') : '失败' })),
        el('td', { class: 'muted', text: r.error || (r.restarted ? '已重启' : '') })
      )
    );
  }
  table.append(body);
  host.append(table);
}

async function load() {
  try {
    const d = await call('/state');
    paintInstances(d.instances || []);
    paintAutoUpdate(d.autoUpdate || {});
  } catch (e) {
    say('读不到状态：' + e.message, true);
  }
}

/* ---------------- 事件接线 ---------------- */

$('reload').addEventListener('click', load);

$('mode').addEventListener('change', () => {
  const local = $('mode').value === 'local';
  $('urlLabel').textContent = local ? '源包地址（例如 https://example.com/dist/）' : '服务地址（例如 http://192.168.8.1:9988）';
  $('port').parentElement.style.display = local ? '' : 'none';
  $('autostart').parentElement.style.display = local ? '' : 'none';
  $('startNow').parentElement.style.display = local ? '' : 'none';
  $('addHint').textContent = local
    ? '本地部署：插件会把源包下载到自己的数据目录（下载必校验 md5，对不上就删掉重来），再按端口起一个常驻进程。'
    : '外部地址：那台机器上的源由那边自己管，插件只按地址取数。';
});

$('add').addEventListener('click', async (e) => {
  const body = {
    mode: $('mode').value,
    name: $('name').value.trim(),
    url: $('url').value.trim(),
    port: Number($('port').value) || 0,
    autostart: $('autostart').checked,
    enabled: $('enabled').checked,
  };
  if (!body.url) return say('请填地址', true);
  e.target.disabled = true;
  e.target.textContent = '添加中…';
  try {
    const d = await call('/instances', { method: 'POST', body: Object.assign({}, body, { start: $('startNow').checked }) });
    say(`已添加 ${d.instance.id}`);
    $('name').value = '';
    $('url').value = '';
    await load();
  } catch (err) {
    say('添加失败：' + err.message, true);
  }
  e.target.disabled = false;
  e.target.textContent = '添加';
});

$('auSave').addEventListener('click', async (e) => {
  e.target.disabled = true;
  try {
    await call('/autoupdate', { method: 'POST', body: { autoUpdate: $('auEnabled').checked, autoUpdateHours: Number($('auHours').value) || 12 } });
    say('自动更新设置已保存');
  } catch (err) {
    say('保存失败：' + err.message, true);
  }
  e.target.disabled = false;
  await load();
});

$('auRun').addEventListener('click', async (e) => {
  e.target.disabled = true;
  e.target.textContent = '检查中…';
  try {
    const d = await call('/autoupdate/run', { method: 'POST' });
    paintAutoUpdate(d.autoUpdate || {}, d.results || []);
    say('检查完成');
  } catch (err) {
    say('检查失败：' + err.message, true);
  }
  e.target.disabled = false;
  e.target.textContent = '立即检查';
  await load();
});

$('mode').dispatchEvent(new Event('change'));
load();
