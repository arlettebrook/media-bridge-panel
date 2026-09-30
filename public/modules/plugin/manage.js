'use strict';
/**
 * 插件模块 · 「管理」页：已装插件的装 / 卸 / 启停 / 重启，看状态与动作。
 *
 * 「**装**」有两条路，分别在两页（ADR-0035 去掉了"随包发行"，所以全新安装这里是空的）：
 *   · 「插件库」页 —— 从插件仓库的清单里挑一个装（`plugin-library`）
 *   · 这一页 —— 手动上传一个 `.tar.gz`
 * 两页都只是把包交给面板：**面板不解释插件的内容** —— 装的是包（两道 md5 校验），
 * 调的是"动作"，插件自己的设置页是它自己的静态文件（面板只托管与转发，见 docs/adr/0029）。
 *
 * 状态每 2 秒拉一次（只在这一页活着）：**状态与已跑时长**都在上面。
 * 插件崩了**不会自动重启**，只留一个「已启用（没在跑）」与退出原因在那儿（见 docs/adr/0037）。
 *
 * **自更新**（插件自带 `updateUrl` 时，见 docs/plugin-contract）：进页面自动查一遍
 * 「有没有新版」，之后每 5 分钟默默再查（页面关掉就停）；带新版的插件在行里标出来，
 * 行里那颗钮变成「更新到 vX」，卡头另有一颗「全部更新」一次把有新版的都装上。
 * 装完由服务端自动重启进程（见 updater.replaceInstalled）。
 */
import { $, el, toast } from '../../core/dom.js';
import { api } from '../../core/api.js';
import { S } from '../../core/state.js';
import { refreshNav } from '../../core/shell.js';

/* 四个类型名与侧栏那四栏一致（元数据 / 片源 / 首页 / 输出，见 core/registry.js） */
const TYPE_LABEL = { metadata: '元数据', source: '片源', home: '首页', output: '输出' };
/* 更新结果按 `type/id` 索引。**放在模块作用域**：放在 renderPluginManage 里会踩 TDZ ——
 * 首屏那次 `await load()` 会先跑到 paint()，那时函数体里的 `const` 还没初始化（实测报
 * "Cannot access 'sidOf' before initialization"，整张列表直接空掉）。 */
const sidOf = (p) => `${p.type}/${p.id}`;
const fmtDuration = (ms) => {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.round(s / 60) + 'm';
  return (s / 3600).toFixed(1) + 'h';
};

export async function renderPluginManage(v) {
  const host = el('div', { id: 'pluginListHost' });
  /* 轮询句柄先声明再调用 startPolling()：它下面就用到了这个变量（声明在后会踩 TDZ） */
  let timer = null;
  /* 自更新检查结果：`type/id` → `{ ok, hasUpdate, current, latest, changelog, error? }` */
  let updates = new Map();
  /* 正在更新的插件（`type/id`）：这颗钮据此显示"更新中…"并禁用 —— 2 秒一次的轮询
   * 会把整行重绘，光改按钮文字是留不住的（下一帧就被刷回去了）。 */
  const busy = new Set();
  let checking = false; // 正在查清单
  let checkInflight = null; // 正在跑的那趟检查（并发调用复用它）
  let updatingAll = null; // 「全部更新」进行中：{ i, total }（i 从 1 数）
  v.append(installCard(() => void load(true).then(() => checkUpdates({ force: true }))), host);
  await load(true);
  startPolling();
  void checkUpdates({ force: true }); // 开页自动查一遍（force：进页面看到的就是当下实情）

  /** 拉一次列表并重绘 */
  async function load(loud = false) {
    try {
      S.plugins = await api('/api/plugins');
    } catch (e) {
      if (loud) host.append(el('div', { class: 'hint warn', text: '读取插件失败：' + e.message }));
      return;
    }
    paint();
  }

  function paint() {
    const box = $('#pluginListHost');
    if (!box) return;
    const d = S.plugins || { plugins: [] };
    box.textContent = '';

    if (!(d.plugins || []).length) {
      box.append(
        el(
          'div',
          { class: 'card' },
          el('h3', { text: '插件' }),
          el('div', {
            class: 'hint',
            /* 插件不随面板发行：全新安装这里就是空的，所以空态得指路（见 docs/adr/0035） */
            text: '还没有装任何插件。插件不随面板发行 —— 到「插件库」页从插件仓库里挑一个装，或者在下面选一个 .tar.gz 手动装。',
          })
        )
      );
      return;
    }

    /* ---- 已装的 ---- */
    const card = el('div', { class: 'card' }, el('h3', { text: '已装插件' }));
    /* 一颗按钮管所有插件，按钮上带"当前查到几个有新版本"：插件一多，
     * 挨个点「更新」很烦（而且大多点开都是"已是最新"）。 */
    const withUpdate = (d.plugins || []).filter((p) => p.updateUrl);
    if (withUpdate.length) card.append(updateBar(withUpdate));
    for (const p of d.plugins || []) {
      card.append(pluginRow(p));
    }
    box.append(card);
  }

  /* ------------------------------------------------------------------ 自更新 */

  /** 查一遍所有插件的自更新清单（开页 / 每 5 分钟 / 点「全部更新」前都走这里）。
   *  失败**不弹提示**（清单在远端，离线时管理页照样得能用），除非 `loud`。
   *  同一次检查里再有人来就**复用那一趟**（不并发打远端）。 */
  function checkUpdates({ force = false, loud = false } = {}) {
    if (checkInflight) return checkInflight;
    checking = true;
    paint();
    checkInflight = (async () => {
      try {
        const out = await api('/api/plugins/updates' + (force ? '?refresh=1' : ''));
        updates = new Map((out.updates || []).map((u) => [`${u.type}/${u.id}`, u]));
      } catch (e) {
        if (loud) toast('检查更新失败：' + e.message, true);
        /* 失败就保留上一次的结果：这一页的状态不该因为一次网络抖动变空 */
      } finally {
        checking = false;
        checkInflight = null;
        paint();
      }
    })();
    return checkInflight;
  }

  /** 卡头那一行：一颗「全部更新」+ 一句话说明当前查到的情况 */
  function updateBar(list) {
    const found = list.map((p) => updates.get(sidOf(p))).filter(Boolean);
    const fresh = found.filter((u) => u.ok && u.hasUpdate);
    const failed = found.filter((u) => !u.ok);

    const btn0 = el('button', { class: 'btn mini' + (fresh.length ? ' primary' : '') });
    btn0.title = '按各插件自己声明的更新地址查一遍，有新版的都装上（装完自动重启）';
    if (updatingAll) {
      btn0.textContent = `更新中…（${updatingAll.i}/${updatingAll.total}）`;
      btn0.disabled = true;
    } else if (checking) {
      btn0.textContent = '检查中…';
      btn0.disabled = true;
    } else {
      btn0.textContent = fresh.length ? `全部更新（${fresh.length}）` : '全部更新';
      btn0.onclick = () => updateAll(list);
    }

    const bits = [];
    if (checking) bits.push('正在检查更新…');
    else if (updatingAll) bits.push(`正在更新第 ${updatingAll.i} / ${updatingAll.total} 个`);
    else if (fresh.length) bits.push(`有 ${fresh.length} 个插件可以更新`);
    else if (found.length) bits.push('都已是最新版本');
    else bits.push('还没查到更新信息');
    if (failed.length) bits.push(`${failed.length} 个检查失败`);
    bits.push('每 5 分钟自动查一次');

    return el('div', { class: 'row' }, btn0, el('span', { class: 'note', text: bits.join(' · ') }));
  }

  /** 一次把所有有新版的插件装完（**一个一个来**：每次更新都要停旧起新，
   *  并发只会让进程管理乱套）。中途失败不打断后面的，最后一起报。 */
  async function updateAll(list) {
    if (updatingAll) return;
    await checkUpdates({ force: true, loud: true });
    const targets = list.filter((p) => {
      const u = updates.get(sidOf(p));
      return u && u.ok && u.hasUpdate;
    });
    if (!targets.length) return toast('所有插件都已是最新版本');

    const lines = targets.map((p) => {
      const u = updates.get(sidOf(p));
      return `${p.name || p.id}：v${u.current} → v${u.latest}`;
    });
    if (!confirm(`把下面 ${targets.length} 个插件更新到最新版？\n\n${lines.join('\n')}\n\n包从各插件自己声明的地址下载，仍会经过两道校验，装完自动重启。`)) return;

    updatingAll = { i: 0, total: targets.length };
    const failed = [];
    for (const p of targets) {
      updatingAll.i += 1;
      const sid = sidOf(p);
      busy.add(sid);
      paint();
      try {
        await api(`/api/plugins/${p.type}/${p.id}/update`, { method: 'POST' });
      } catch (e) {
        failed.push(`${p.name || p.id}（${e.message}）`);
      } finally {
        busy.delete(sid);
      }
    }
    updatingAll = null;
    await load();
    await checkUpdates(); // 缓存里刚装过的那条已在服务端作废，这里拿到的是新版本
    refreshNav();
    if (failed.length) return toast(`已更新 ${targets.length - failed.length} 个，${failed.length} 个没成功：${failed.join('；')}`, true);
    toast(`已更新 ${targets.length} 个插件`);
  }

  /** 装卸启停都走这里：出错弹提示、成功重拉列表，再刷新侧栏
   *  （四类插件栏的子项是照插件清单现算的，见 core/registry.js）。
   *  必须放在这一层：`pluginRow()` 与 `uninstall()` 都要用它。 */
  const act = async (fn) => {
    try {
      await fn();
    } catch (e) {
      toast(e.message, true);
    }
    await load();
    refreshNav();
  };

  function pluginRow(p) {
    const sid = sidOf(p);
    const u = updates.get(sid);
    const canUpdate = !!(u && u.ok && u.hasUpdate);
    const rowBusy = busy.has(sid) || !!updatingAll;
    const statusText =
      p.status === 'running' ? '运行中' : p.status === 'starting' ? '启动中…' : p.status === 'broken' ? '起不来' : p.enabled ? '已启用（没在跑）' : '已停用';
    const statusCls = p.status === 'running' ? ' ok' : p.status === 'broken' ? ' err' : p.status === 'starting' ? ' warn' : '';
    /* 状态明细单独一行：跟名称、几颗按钮挤在一条线上时，它会被折成两三截，一屏看下来对不上号 */
    const bits = [
      `${TYPE_LABEL[p.type] || p.type} · ${p.id}`,
      `v${p.version}`,
      p.domain ? `域 ${p.domain}` : '',
      p.author ? `作者 ${p.author}` : '',
      p.updateUrl ? '支持自更新' : '',
      p.status === 'running' ? `已跑 ${fmtDuration(p.uptimeMs)}` : '',
      /* 只有两条来路（见 docs/adr/0035）：插件库装的 / 手动上传的。
         历史条目里写过的 `builtin` / `upload` 按同一口径归并显示，不做数据迁移。 */
      p.origin === 'manual' || p.origin === 'upload' ? '手动安装' : '插件库',
    ].filter(Boolean);

    const btn = (text, title, fn, cls = 'btn mini') => el('button', { class: cls, title, text, onclick: fn });

    /* 自更新（插件声明了 updateUrl 才有这颗钮）：先查清单，有新版确认后一键下载换装，
     * 装完服务端自动把进程起回来（成功后这里照常 load + 刷侧栏）。 */
    let updateBtn = null;
    if (p.updateUrl) {
      if (busy.has(sid)) updateBtn = btn('更新中…', '正在更新…', null);
      else if (canUpdate) updateBtn = btn(`更新到 v${u.latest}`, `有新版本：v${u.current} → v${u.latest}`, () => checkAndUpdate(p), 'btn mini primary');
      else updateBtn = btn('更新', '按插件自带的更新地址检查并一键更新', () => checkAndUpdate(p));
      if (rowBusy) updateBtn.disabled = true;
    }

    return el(
      'div',
      { class: 'plugin-row' },
      el(
        'div',
        { class: 'plugin-head' },
        el('span', { class: 'plugin-name', text: p.name || p.id }),
        el('span', { class: 'badge' + statusCls, text: statusText }),
        canUpdate ? el('span', { class: 'badge warn', text: `可更新 v${u.latest}` }) : null,
        el('span', { class: 'spacer' }),
        el(
          'div',
          { class: 'row plugin-acts' },
          p.enabled
            ? btn('停用', '停掉它的进程（它自己起的东西由它自己清理）', () => act(() => api(`/api/plugins/${p.type}/${p.id}/disable`, { method: 'POST' })))
            : btn('启用', '起它的进程', () => act(() => api(`/api/plugins/${p.type}/${p.id}/enable`, { method: 'POST' })), 'btn mini primary'),
          updateBtn,
          btn('重启', '重起它的进程', () => act(() => api(`/api/plugins/${p.type}/${p.id}/restart`, { method: 'POST' }))),
          btn('卸载', '卸载它 —— 它的 data/ 目录也会一起删掉', () => uninstall(p))
        )
      ),
      el('div', { class: 'note', text: bits.join(' · ') }),
      p.lastError ? el('div', { class: 'note err-note', text: '最近一次错误：' + p.lastError }) : null,
      u && !u.ok ? el('div', { class: 'note', text: '更新检查失败：' + u.error }) : null,
      (p.actions || []).length ? el('div', { class: 'note', text: '实现了这些动作：' + p.actions.join(' / ') }) : null
    );
  }

  /** 单个更新：没有现成的检查结果（或已过期）就先查一次，有新版才问，装完立刻重查 */
  async function checkAndUpdate(p) {
    const sid = sidOf(p);
    if (busy.has(sid) || updatingAll) return;
    if (!updates.get(sid)) await checkUpdates();
    let u = updates.get(sid);
    if (!u) return toast('检查更新失败', true);
    if (!u.ok) return toast('检查更新失败：' + u.error, true);
    if (!u.hasUpdate) return toast(`已是最新版本（v${u.current}）`);

    const note = u.changelog ? `\n\n更新说明：\n${u.changelog}` : '';
    if (!confirm(`「${p.name || p.id}」有新版本：v${u.current} → v${u.latest}，现在更新？\n\n包从插件声明的地址下载，仍会经过两道校验，装完自动重启。${note}`)) return;

    busy.add(sid);
    paint();
    try {
      const out = await api(`/api/plugins/${p.type}/${p.id}/update`, { method: 'POST' });
      toast(`已更新：${p.name || p.id} → v${out.to || u.latest}`);
    } catch (e) {
      toast('更新失败：' + e.message, true);
    } finally {
      busy.delete(sid);
    }
    await load(); // 版本 / 状态立刻刷出来
    await checkUpdates(); // 装过的那个在服务端已作废，这里重查到的是新版本
    refreshNav();
  }

  async function uninstall(p) {
    if (!confirm(`卸载「${p.name || p.id}」（${p.type}/${p.id}）？\n\n它的进程会停掉，插件目录与它自己的 data/ 目录都会删掉。`)) return;
    await act(() => api(`/api/plugins/${p.type}/${p.id}`, { method: 'DELETE' }));
    toast('已卸载：' + (p.name || p.id));
    updates.delete(sidOf(p));
  }

  /* ------------------------------------------------------------------ 轮询 */

  function startPolling() {
    if (timer) return;
    let tick = 0;
    timer = setInterval(async () => {
      if (!$('#pluginListHost')) {
        clearInterval(timer);
        timer = null; // 页面走了就停：状态与自更新都不再拉
        return;
      }
      await load();
      tick += 1;
      /* 每 5 分钟默默再查一遍有没有新版（150 × 2s）。服务端有 60 秒缓存，
       * 这里不加 force —— 到点缓存早过了，查的就是最新的。 */
      if (tick % 150 === 0) await checkUpdates();
    }, 2000);
  }
}

/**
 * 「装一个插件」卡：选一个 `.tar.gz` + 可选的包 md5（发布方给的）+ **安装确认**。
 *
 * 确认那段话不是走过场：插件**能读写数据、能联网、能起进程**（不沙箱，见 docs/adr/0028），
 * 装了就等于在这台机器上跑它的代码 —— 装之前必须知道这件事。
 */
function installCard(onInstalled = () => {}) {
  const file = el('input', { type: 'file', accept: '.gz,.tgz,application/gzip' });
  const md5In = el('input', { type: 'text', class: 'w-lg', placeholder: '（可选）发布方给的包 md5 —— 填了就会校验', spellcheck: 'false' });
  const enableCb = el('input', { type: 'checkbox', checked: true });
  const go = el('button', { class: 'btn primary', text: '装上去' });
  const out = el('div', { class: 'note' });

  go.addEventListener('click', async () => {
    const f = (file.files || [])[0];
    if (!f) return toast('先选一个 .tar.gz 包', true);
    if (!confirm(`装插件「${f.name}」？\n\n⚠️ 插件能读写数据、能联网、能起进程 —— 装了就等于在这台机器上跑它的代码。只装你信得过的包。`)) return;
    go.disabled = true;
    out.textContent = '正在上传并校验…';
    try {
      const b64 = await new Promise((resolve, reject) => {
        const rd = new FileReader();
        rd.onerror = () => reject(new Error('读文件失败'));
        rd.onload = () => resolve(String(rd.result).split(',')[1] || '');
        rd.readAsDataURL(f);
      });
      const r = await api('/api/plugins/install', {
        method: 'POST',
        body: { tarball: b64, md5: md5In.value.trim(), enable: enableCb.checked },
      });
      out.textContent = `已装上：${r.plugin.name} v${r.plugin.version}（${r.plugin.type}/${r.plugin.id}，${r.plugin.files} 个文件）`;
      toast('已装上：' + r.plugin.name);
    } catch (e) {
      out.textContent = '装失败：' + e.message;
      toast('装失败：' + e.message, true);
    } finally {
      go.disabled = false;
      onInstalled(); // 刷新列表（新插件要出现在下面）
    }
  });

  return el(
    'div',
    { class: 'card' },
    el('h3', { text: '装一个插件' }),
    /* 四样控件原来挤在一行：包、md5、勾选、按钮各自的宽度都不一样，窄屏一折行就散了。
       这里拆成"选包一行、动作一行"，每行最多两件东西，眼睛有落点。 */
    el('div', { class: 'row' }, file, md5In),
    el('div', { class: 'row' }, el('label', { class: 'chk', title: '装完立刻启用（起它的进程）' }, enableCb, '装完就启用'), go),
    out,
    el('div', {
      class: 'note',
      text: '包是一个 .tar.gz',
    })
  );
}
