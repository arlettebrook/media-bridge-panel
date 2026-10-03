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
 * **自更新**（插件自带 `updateUrl` 时，见 docs/plugin-contract）：**只在进这一页时查一遍**
 * 「有没有新版」（不再按点轮询远端）；带新版的插件在行里标出来，行里那颗钮变成
 * 「更新到 vX」，卡头那颗钮则跟着查到的结果变脸 —— 查到更新是「全部更新（N）」，
 * 没查到是「检查更新」（点它就是再查一遍）。装完由服务端自动重启进程（见 updater.replaceInstalled）。
 */
import { $, el, toast } from '../../core/dom.js';
import { api } from '../../core/api.js';
import { S } from '../../core/state.js';
import { refreshNav } from '../../core/shell.js';

/* 四个类型名与侧栏那四栏一致（元数据 / 片源 / 首页 / 输出，见 core/registry.js） */
const TYPE_LABEL = { metadata: '元数据', source: '片源', home: '首页', output: '输出' };
/* 多类型之后身份就是 id（见 docs/adr/0046）：更新结果 / 忙碌状态都按 id 索引。
 * 管理 URL 仍要带一个角色段，用第一个类型即可（后端按 id 定位进程）。 */
const sidOf = (p) => p.id;
const roleOf = (p) => (Array.isArray(p.types) && p.types[0]) || p.type || '';
/** 一个类型一个小徽章：多类型包一排多个 */
const typeBadges = (p) =>
  (Array.isArray(p.types) ? p.types : [p.type]).filter(Boolean).map((t) =>
    el('span', { class: 'badge', title: '类型：' + t, text: TYPE_LABEL[t] || t })
  );
const fmtDuration = (ms) => {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.round(s / 60) + 'm';
  return (s / 3600).toFixed(1) + 'h';
};

export async function renderPluginManage(v) {
  /* ⚠️ 宿主**本身就是那张卡**（不是套在卡外面的一层 div）：套一层的话，
   * 它与上面「装一个插件」那张卡之间就没有 `.card + .card` 那条 16px 间距，两张卡会贴在一起。 */
  const host = el('div', { class: 'card', id: 'pluginListHost' });
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
        el('h3', { text: '插件' }),
        el('div', {
          class: 'hint',
          /* 插件不随面板发行：全新安装这里就是空的，所以空态得指路（见 docs/adr/0035） */
          text: '还没有装任何插件 —— 到「插件库」页挑一个装，或在上面选一个 .tar.gz 手动装。',
        })
      );
      return;
    }

    /* ---- 已装的 ---- */
    box.append(el('h3', { text: '已装插件' }));
    /* 一颗按钮管所有插件，按钮上带"当前查到几个有新版本"：插件一多，
     * 挨个点「更新」很烦（而且大多点开都是"已是最新"）。 */
    const withUpdate = (d.plugins || []).filter((p) => p.updateUrl);
    if (withUpdate.length) box.append(updateBar(withUpdate));
    for (const p of d.plugins || []) {
      box.append(pluginRow(p));
    }
  }

  /* ------------------------------------------------------------------ 自更新 */

  /** 查一遍所有插件的自更新清单（开页 / 点「检查更新」/ 点「全部更新」前都走这里）。
   *  失败**不弹提示**（清单在远端，离线时管理页照样得能用），除非 `loud`。
   *  同一次检查里再有人来就**复用那一趟**（不并发打远端）。 */
  function checkUpdates({ force = false, loud = false } = {}) {
    if (checkInflight) return checkInflight;
    checking = true;
    paint();
    checkInflight = (async () => {
      try {
        const out = await api('/api/plugins/updates' + (force ? '?refresh=1' : ''));
        updates = new Map((out.updates || []).map((u) => [u.id, u]));
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

    /* 这颗钮跟着"查到的结果"变脸：查到有新版的（`fresh`）就是「全部更新（N）」，
     * 一个都没查到就是「检查更新」—— 点了再查一遍。**不再让它装作能更新**：
     * 没更新可装的时候，一颗写着「全部更新」的钮点下去只弹一句"已是最新"，白点一次。 */
    const btn0 = el('button', { class: 'btn mini' + (fresh.length ? ' primary' : '') });
    if (updatingAll) {
      btn0.textContent = `更新中…（${updatingAll.i}/${updatingAll.total}）`;
      btn0.disabled = true;
    } else if (checking) {
      btn0.textContent = '检查中…';
      btn0.disabled = true;
    } else if (fresh.length) {
      btn0.title = '按各插件自己声明的更新地址查一遍，有新版的都装上（装完自动重启）';
      btn0.textContent = `全部更新（${fresh.length}）`;
      btn0.onclick = () => updateAll(list);
    } else {
      btn0.title = '按各插件自己声明的更新地址查一遍有没有新版';
      btn0.textContent = '检查更新';
      btn0.onclick = () => checkUpdates({ force: true, loud: true });
    }

    const bits = [];
    if (checking) bits.push('正在检查更新…');
    else if (updatingAll) bits.push(`正在更新第 ${updatingAll.i} / ${updatingAll.total} 个`);
    else if (fresh.length) bits.push(`有 ${fresh.length} 个插件可以更新`);
    else if (found.length) bits.push('都已是最新版本');
    else bits.push('还没查到更新信息');
    if (failed.length) bits.push(`${failed.length} 个检查失败`);

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
    if (!confirm(`把下面 ${targets.length} 个插件更新到最新版？\n\n${lines.join('\n')}\n\n包从各插件声明的地址下载，仍会经过两道校验。`)) return;

    updatingAll = { i: 0, total: targets.length };
    const failed = [];
    for (const p of targets) {
      updatingAll.i += 1;
      const sid = sidOf(p);
      busy.add(sid);
      paint();
      try {
        await api(`/api/plugins/${roleOf(p)}/${p.id}/update`, { method: 'POST' });
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
    /* 版本与作者单独一行、紧跟标题下面；已跑时长与来路另起一行。
     * 跟名称、几颗按钮挤在一条线上时会被折成两三截，一屏看下来对不上号 */
    const headBits = [
      p.id,
      `v${p.version}`,
      p.domain ? `域 ${p.domain}` : '',
      p.author ? `作者 ${p.author}` : '',
    ].filter(Boolean);
    const restBits = [
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

    /* 按钮组不搁标题行：它是这一整块的最后一件东西（右下角），标题行只留名称与状态徽章 */
    return el(
      'div',
      { class: 'plugin-row' },
      el(
        'div',
        { class: 'plugin-head' },
        el('span', { class: 'plugin-name', text: p.name || p.id }),
        ...typeBadges(p),
        el('span', { class: 'badge' + statusCls, text: statusText }),
        canUpdate ? el('span', { class: 'badge warn', text: `可更新 v${u.latest}` }) : null
      ),
      el('div', { class: 'note', text: headBits.join(' · ') }),
      restBits.length ? el('div', { class: 'note', text: restBits.join(' · ') }) : null,
      p.lastError ? el('div', { class: 'note err-note', text: '最近一次错误：' + p.lastError }) : null,
      u && !u.ok ? el('div', { class: 'note', text: '更新检查失败：' + u.error }) : null,
      (p.actions || []).length ? el('div', { class: 'note', text: '实现了这些动作：' + p.actions.join(' / ') }) : null,
      el(
        'div',
        { class: 'row plugin-acts' },
        p.enabled
          ? btn('停用', '停掉它的进程（它自己起的东西由它自己清理）', () => act(() => api(`/api/plugins/${roleOf(p)}/${p.id}/disable`, { method: 'POST' })))
          : btn('启用', '起它的进程', () => act(() => api(`/api/plugins/${roleOf(p)}/${p.id}/enable`, { method: 'POST' })), 'btn mini primary'),
        updateBtn,
        btn('重启', '重起它的进程', () => act(() => api(`/api/plugins/${roleOf(p)}/${p.id}/restart`, { method: 'POST' }))),
        btn('卸载', '卸载它 —— 它的 data/ 目录也会一起删掉', () => uninstall(p))
      )
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
    if (!confirm(`「${p.name || p.id}」有新版本：v${u.current} → v${u.latest}，现在更新？\n\n包从插件声明的地址下载，仍会经过两道校验。${note}`)) return;

    busy.add(sid);
    paint();
    try {
      const out = await api(`/api/plugins/${roleOf(p)}/${p.id}/update`, { method: 'POST' });
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
    if (!confirm(`卸载「${p.name || p.id}」（${p.id}）？\n\n它的进程会停掉，插件目录与它自己的 data/ 目录都会删掉。`)) return;
    await act(() => api(`/api/plugins/${roleOf(p)}/${p.id}`, { method: 'DELETE' }));
    toast('已卸载：' + (p.name || p.id));
    updates.delete(sidOf(p));
  }

  /* ------------------------------------------------------------------ 轮询 */

  function startPolling() {
    if (timer) return;
    timer = setInterval(async () => {
      if (!$('#pluginListHost')) {
        clearInterval(timer);
        timer = null; // 页面走了就停：状态不再拉
        return;
      }
      await load();
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
    if (!confirm(`装插件「${f.name}」？\n\n插件能读写数据、能联网、能起进程 —— 装了就等于在这台机器上跑它的代码，只装信得过的包。`)) return;
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
      out.textContent = `已装上：${r.plugin.name} v${r.plugin.version}（${(r.plugin.types || []).join('/')}/${r.plugin.id}，${r.plugin.files} 个文件）`;
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
    out
  );
}
