'use strict';
/**
 * PikPak 磁力片源设置页的前端。
 *
 * 请求都打到面板的转发通道 `/api/plugins/<类型>/<id>/api/**`：面板把它转成动作 `http`，
 * 由 index.js 处理（面板不解释内容）。
 *
 * 通道前缀是**算出来的**，不写死类型与 id：页面自己的地址是
 * `/api/plugins/source/pikpak/ui/index.html`，把 `/ui/…` 之后切掉就得到前缀。
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
  }, 5000);
}

const fmtMB = (n) => (Number(n || 0) / 1024 / 1024).toFixed(1);
const show = (id, text) => {
  const el = $(id);
  el.style.display = text ? 'block' : 'none';
  el.textContent = text || '';
};

function paintState(d) {
  const s = d.settings || {};
  const a = d.auth || {};
  const c = d.cacheSettings || {};
  $('username').value = a.username || '';
  $('deviceId').value = a.deviceId || '';
  $('sukebeiBase').value = s.sukebeiBase || '';
  $('saveDir').value = s.saveDir || '';
  $('waitSeconds').value = s.waitSeconds !== undefined ? s.waitSeconds : 40;
  $('cacheTtl').value = c.ttlMinutes !== undefined ? c.ttlMinutes : 10;
  $('cacheMax').value = c.maxMB !== undefined ? c.maxMB : 64;

  const flags = [
    a.loggedIn ? '有令牌' : '没有令牌',
    a.hasRefreshToken ? '有刷新令牌' : '没有刷新令牌',
    a.hasPassword ? '存了密码' : '没存密码',
  ].join(' · ');
  $('authState').textContent =
    `${flags}${a.username ? ' · 账号 ' + a.username : ''}${a.userId ? ' · 用户 ' + a.userId : ''}` +
    `${a.saveDirId ? ' · 保存目录已就位' : ''}`;

  const up = (d.cache && d.cache.tables && d.cache.tables.upstream) || {};
  const cap = up.maxBytes > 0 ? `${fmtMB(up.maxBytes)} MB` : '不限';
  const ttl = c.ttlMinutes > 0 ? `${c.ttlMinutes} 分钟` : '不缓存';
  $('cacheState').textContent =
    `已用 ${fmtMB(d.cache && d.cache.bytes)} MB / 上限 ${cap} · ${(d.cache && d.cache.rows) || 0} 条 · 有效期 ${ttl}`;
  $('where').textContent = `站点 key ${d.siteKey || ''} · 插件 ${(d.plugin && d.plugin.name) || ''} ${(d.plugin && d.plugin.version) || ''}`;
}

async function load() {
  try {
    paintState(await call('/state'));
  } catch (e) {
    say('读不到状态：' + e.message, true);
  }
}

/** 保存目录卡片：把条目画成一行行可勾选的样子 */
function paintSavedir(r) {
  const box = $('savedirList');
  box.textContent = '';
  if (!r || !r.ok) {
    $('savedirState').textContent = `保存目录读取失败：${(r && r.error) || '未知原因'}`;
    return;
  }
  const items = r.items || [];
  $('savedirState').textContent = `保存目录「${r.saveDir}」· ${r.count} 个条目`;
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = '目录是空的 —— 还没点过播放，或者已经清理干净。';
    box.appendChild(empty);
    return;
  }
  for (const one of items) {
    const row = document.createElement('label');
    row.className = 'savedir-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = one.id;
    cb.dataset.savedir = '1';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = (one.folder ? '[目录] ' : '') + one.name;
    const sz = document.createElement('span');
    sz.className = 'sz';
    sz.textContent = one.sizeText || (one.folder ? '' : '0 B');
    row.append(cb, nm, sz);
    box.appendChild(row);
  }
}

async function loadSavedir() {
  try {
    paintSavedir((await call('/savedir')).result);
  } catch (e) {
    paintSavedir({ ok: false, error: e.message });
  }
}

const checkedIds = () =>
  Array.from(document.querySelectorAll('input[data-savedir]:checked'))
    .map((x) => x.value)
    .filter(Boolean);

/** 清理（选中若干条，或整目录）—— 都只动目录里的条目，不动保存目录本身 */
async function runCleanup(body, e) {
  e.target.disabled = true;
  try {
    const r = (await call('/cleanup', { method: 'POST', body })).result || {};
    say(r.ok ? `已移进回收站：${r.trashed} 个` : `清理失败：${r.error || '未知原因'}`, !r.ok);
  } catch (err) {
    say('清理失败：' + err.message, true);
  }
  e.target.disabled = false;
  await loadSavedir();
}

/* ---------------- 事件接线 ---------------- */

$('credSave').addEventListener('click', async (e) => {
  e.target.disabled = true;
  try {
    /* 密码与刷新令牌只在填了的时候才发 —— 留空表示不动已保存的那份 */
    const body = { username: $('username').value, deviceId: $('deviceId').value };
    if ($('password').value.trim()) body.password = $('password').value;
    if ($('refreshToken').value.trim()) body.refreshToken = $('refreshToken').value;
    paintState(await call('/credentials', { method: 'POST', body }));
    $('password').value = '';
    $('refreshToken').value = '';
    say('凭据已保存');
  } catch (err) {
    say('保存失败：' + err.message, true);
  }
  e.target.disabled = false;
});

$('login').addEventListener('click', async (e) => {
  e.target.disabled = true;
  e.target.textContent = '登录中…';
  try {
    const d = await call('/login', { method: 'POST' });
    paintState(d);
    const r = d.login || {};
    say(r.ok ? `登录成功（${r.ms} ms）` : `登录失败：${r.error || '未知原因'}`, !r.ok);
    if (r.ok) await loadSavedir();
  } catch (err) {
    say('登录失败：' + err.message, true);
  }
  e.target.disabled = false;
  e.target.textContent = '登录一下';
});

$('logout').addEventListener('click', async (e) => {
  if (!window.confirm('清掉插件里保存的令牌与保存目录记录？（账号密码保留）')) return;
  e.target.disabled = true;
  try {
    paintState(await call('/logout', { method: 'POST' }));
    say('本地登录态已清掉');
  } catch (err) {
    say('操作失败：' + err.message, true);
  }
  e.target.disabled = false;
});

$('siteSave').addEventListener('click', async (e) => {
  e.target.disabled = true;
  try {
    paintState(
      await call('/settings', {
        method: 'POST',
        body: {
          sukebeiBase: $('sukebeiBase').value,
          saveDir: $('saveDir').value,
          waitSeconds: Number($('waitSeconds').value),
        },
      })
    );
    say('设置已保存');
  } catch (err) {
    say('保存失败：' + err.message, true);
  }
  e.target.disabled = false;
});

$('test').addEventListener('click', async (e) => {
  e.target.disabled = true;
  e.target.textContent = '自检中…';
  show('testResult', '');
  try {
    const d = await call('/test', {
      method: 'POST',
      body: { sukebeiBase: $('sukebeiBase').value, saveDir: $('saveDir').value, waitSeconds: Number($('waitSeconds').value), wd: $('testWd').value },
    });
    const r = d.result || {};
    const lines = [
      `磁力站：${r.sukebei && r.sukebei.ok ? `通了 · HTTP ${r.sukebei.status} · ${r.sukebei.ms} ms · 解析出 ${r.sukebei.count} 条` : `没通 · ${(r.sukebei && r.sukebei.error) || '未知原因'}`}`,
      r.sukebei && r.sukebei.top && r.sukebei.top.length ? `  前几条：${r.sukebei.top.join(' | ')}` : '',
      `PikPak：${r.pikpak && r.pikpak.ok ? `通了 · ${r.pikpak.ms} ms · 保存目录 ${r.pikpak.saveDir}（${r.pikpak.saveDirFiles} 个文件，${r.pikpak.folders} 个文件夹）` : `没通 · ${(r.pikpak && r.pikpak.error) || '未知原因'}`}`,
    ].filter(Boolean);
    show('testResult', lines.join('\n'));
    const ok = !!(r.sukebei && r.sukebei.ok) && !!(r.pikpak && r.pikpak.ok);
    say(ok ? '自检通过' : '自检未通过', !ok);
    await load();
  } catch (err) {
    say('自检失败：' + err.message, true);
  }
  e.target.disabled = false;
  e.target.textContent = '一键自检';
});

$('magnetRun').addEventListener('click', async (e) => {
  e.target.disabled = true;
  e.target.textContent = '处理中…';
  show('magnetResult', '');
  try {
    const d = await call('/magnet', {
      method: 'POST',
      body: { magnet: $('magnet').value, title: $('magnetTitle').value, waitSeconds: Number($('magnetWait').value) },
    });
    const r = d.result || {};
    const lines = [`阶段：${r.phase || '-'} · ${r.ms || 0} ms${r.taskId ? ` · 任务 ${r.taskId}` : ''}`];
    for (const v of r.videos || []) {
      lines.push(`· ${v.name}（${fmtMB(v.size)} MB）`);
      lines.push(`  ${v.url || '（没取到地址：' + (v.error || '未知原因') + '）'}`);
    }
    if (r.error) lines.push(`失败：${r.error}`);
    show('magnetResult', lines.join('\n'));
    say(r.ok ? '取到播放地址了' : '没取到地址（详见下方）', !r.ok);
    await load();
    await loadSavedir();
  } catch (err) {
    say('处理失败：' + err.message, true);
  }
  e.target.disabled = false;
  e.target.textContent = '提交并取地址';
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
  if (!window.confirm('清空缓存？下次搜索会重新打磁力站。')) return;
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

$('savedirReload').addEventListener('click', async (e) => {
  e.target.disabled = true;
  await loadSavedir();
  say('保存目录已刷新');
  e.target.disabled = false;
});

$('cleanupSel').addEventListener('click', async (e) => {
  const ids = checkedIds();
  if (!ids.length) {
    say('先勾选要清理的条目', true);
    return;
  }
  if (!window.confirm(`把选中的 ${ids.length} 个条目移进回收站？`)) return;
  await runCleanup({ ids }, e);
});

$('cleanupAll').addEventListener('click', async (e) => {
  if (!window.confirm('把保存目录里的条目全部移进回收站？（回收站里还能捞回来）')) return;
  await runCleanup({ all: true }, e);
});

load();
loadSavedir();