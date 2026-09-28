'use strict';
/**
 * MissAV 片源设置页的前端。
 *
 * 请求都打到面板的转发通道 `/api/plugins/<类型>/<id>/api/**`：面板把它转成动作 `http`，
 * 由 index.js 处理（面板不解释内容）。
 *
 * 通道前缀是**算出来的**，不写死类型与 id：页面自己的地址是
 * `/api/plugins/source/missav/ui/index.html`，把 `/ui/…` 之后切掉就得到前缀。
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

const fmtMB = (n) => (Number(n || 0) / 1024 / 1024).toFixed(1);

function paintState(d) {
  const s = d.settings || {};
  const c = d.cacheSettings || {};
  $('siteBase').value = s.siteBase || '';
  $('coverBase').value = s.coverBase || '';
  $('lang').value = s.lang || '';
  $('cacheTtl').value = c.ttlMinutes !== undefined ? c.ttlMinutes : 5;
  $('cacheMax').value = c.maxMB !== undefined ? c.maxMB : 64;

  const up = (d.cache && d.cache.tables && d.cache.tables.upstream) || {};
  const cap = up.maxBytes > 0 ? `${fmtMB(up.maxBytes)} MB` : '不限';
  const ttl = c.ttlMinutes > 0 ? `${c.ttlMinutes} 分钟` : '不缓存';
  $('cacheState').textContent =
    `已用 ${fmtMB(d.cache && d.cache.bytes)} MB / 上限 ${cap} · ${(d.cache && d.cache.rows) || 0} 条 · 有效期 ${ttl}`;
  $('where').textContent = `站点 key ${d.siteKey || ''} · 插件 ${(d.plugin && d.plugin.name) || ''} ${(d.plugin && d.plugin.version) || ''}`;
}

function paintTest(r) {
  const host = $('testResult');
  host.textContent = '';
  if (!r) return;
  const div = document.createElement('div');
  div.className = r.ok ? 'test-ok' : 'test-err';
  div.textContent = r.ok
    ? `通了：HTTP ${r.status} · ${r.ms} ms · 解析出 ${r.count} 条（关键词 ${r.wd}）`
    : `没通：${r.error || '未知原因'}（HTTP ${r.status || 0} · ${r.ms} ms）`;
  host.append(div);
}

async function load() {
  try {
    paintState(await call('/state'));
  } catch (e) {
    say('读不到状态：' + e.message, true);
  }
}

/* ---------------- 事件接线 ---------------- */

$('siteSave').addEventListener('click', async (e) => {
  e.target.disabled = true;
  try {
    paintState(
      await call('/settings', {
        method: 'POST',
        body: { siteBase: $('siteBase').value, coverBase: $('coverBase').value, lang: $('lang').value },
      })
    );
    say('站点设置已保存');
  } catch (err) {
    say('保存失败：' + err.message, true);
  }
  e.target.disabled = false;
});

$('test').addEventListener('click', async (e) => {
  e.target.disabled = true;
  e.target.textContent = '自检中…';
  let ok = false;
  try {
    const d = await call('/test', {
      method: 'POST',
      body: { siteBase: $('siteBase').value, coverBase: $('coverBase').value, lang: $('lang').value, wd: $('testWd').value },
    });
    paintTest(d.result);
    ok = !!(d.result && d.result.ok);
    say(ok ? '自检通过' : '自检未通过', !ok);
  } catch (err) {
    say('自检失败：' + err.message, true);
  }
  e.target.disabled = false;
  e.target.textContent = '一键自检';
});

$('cacheSave').addEventListener('click', async (e) => {
  e.target.disabled = true;
  try {
    await call('/cache/settings', {
      method: 'POST',
      body: { cacheTtlMinutes: Number($('cacheTtl').value), cacheMaxMB: Number($('cacheMax').value) },
    });
    say('缓存设置已保存');
  } catch (err) {
    say('保存失败：' + err.message, true);
  }
  e.target.disabled = false;
  await load();
});

$('cacheReload').addEventListener('click', async () => {
  try {
    await load();
    say('缓存用量已刷新');
  } catch (err) {
    say('刷新失败：' + err.message, true);
  }
});

$('cacheClear').addEventListener('click', async (e) => {
  if (!window.confirm('清空缓存？下次取数会重新打站点。')) return;
  e.target.disabled = true;
  try {
    await call('/cache/clear', { method: 'POST' });
    say('缓存已清空');
  } catch (err) {
    say('清空失败：' + err.message, true);
  }
  e.target.disabled = false;
  await load();
});

load();