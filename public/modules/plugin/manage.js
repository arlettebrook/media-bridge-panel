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
 * 状态每 2 秒拉一次（只在这一页活着）：**状态、重启次数**都在上面，
 * 「插件崩了会自动重启」这件事得看得见（见 docs/adr/0028）。
 */
import { $, el, toast } from '../../core/dom.js';
import { api } from '../../core/api.js';
import { S } from '../../core/state.js';
import { refreshNav } from '../../core/shell.js';

/* 三个类型名与侧栏那三栏一致（元数据 / 片源 / 首页，见 core/registry.js） */
const TYPE_LABEL = { metadata: '元数据', source: '片源', home: '首页' };
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
  v.append(installCard(() => load(true)), host);
  await load(true);
  startPolling();

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
    for (const p of d.plugins || []) {
      card.append(pluginRow(p));
    }
    card.append(
      el('div', {
        class: 'note',
        text:
          '状态每 2 秒刷新一次。「启用」会立刻把它的进程拉起来；它自己崩了或被杀掉，宿主会自动重启它（最多 5 次 / 5 分钟，每次都在日志里点名）。',
      })
    );
    box.append(card);
  }

  /** 装卸启停都走这里：出错弹提示、成功重拉列表，再刷新侧栏
   *  （三类插件栏的子项是照插件清单现算的，见 core/registry.js）。
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
    const statusText =
      p.status === 'running' ? '运行中' : p.status === 'starting' ? '启动中…' : p.status === 'broken' ? '起不来' : p.enabled ? '已启用（没在跑）' : '已停用';
    const statusCls = p.status === 'running' ? ' ok' : p.status === 'broken' ? ' err' : p.status === 'starting' ? ' warn' : '';
    /* 状态明细单独一行：跟名称、几颗按钮挤在一条线上时，它会被折成两三截，一屏看下来对不上号 */
    const bits = [
      `${TYPE_LABEL[p.type] || p.type} · ${p.id}`,
      `v${p.version}`,
      p.domain ? `域 ${p.domain}` : '',
      p.status === 'running' ? `已跑 ${fmtDuration(p.uptimeMs)}` : '',
      p.restarts ? `重启过 ${p.restarts} 次` : '',
      /* 只有两条来路（见 docs/adr/0035）：插件库装的 / 手动上传的。
         历史条目里写过的 `builtin` / `upload` 按同一口径归并显示，不做数据迁移。 */
      p.origin === 'manual' || p.origin === 'upload' ? '手动安装' : '插件库',
    ].filter(Boolean);

    const btn = (text, title, fn, cls = 'btn mini') => el('button', { class: cls, title, text, onclick: fn });

    return el(
      'div',
      { class: 'plugin-row' },
      el(
        'div',
        { class: 'plugin-head' },
        el('span', { class: 'plugin-name', text: p.name || p.id }),
        el('span', { class: 'badge' + statusCls, text: statusText }),
        el('span', { class: 'spacer' }),
        el(
          'div',
          { class: 'row plugin-acts' },
          p.enabled
            ? btn('停用', '停掉它的进程（它自己起的东西由它自己清理）', () => act(() => api(`/api/plugins/${p.type}/${p.id}/disable`, { method: 'POST' })))
            : btn('启用', '起它的进程', () => act(() => api(`/api/plugins/${p.type}/${p.id}/enable`, { method: 'POST' })), 'btn mini primary'),
          btn('重启', '重起它的进程（手动重启会把自动重启的退避计数清零）', () => act(() => api(`/api/plugins/${p.type}/${p.id}/restart`, { method: 'POST' }))),
          btn('卸载', '卸载它 —— 它的 data/ 目录也会一起删掉', () => uninstall(p))
        )
      ),
      el('div', { class: 'note', text: bits.join(' · ') }),
      p.lastError ? el('div', { class: 'note err-note', text: '最近一次错误：' + p.lastError }) : null,
      (p.actions || []).length ? el('div', { class: 'note', text: '实现了这些动作：' + p.actions.join(' / ') }) : null
    );
  }

  async function uninstall(p) {
    if (!confirm(`卸载「${p.name || p.id}」（${p.type}/${p.id}）？\n\n它的进程会停掉，插件目录与它自己的 data/ 目录都会删掉。`)) return;
    await act(() => api(`/api/plugins/${p.type}/${p.id}`, { method: 'DELETE' }));
    toast('已卸载：' + (p.name || p.id));
  }

  /* ------------------------------------------------------------------ 轮询 */

  function startPolling() {
    if (timer) return;
    timer = setInterval(async () => {
      if (!$('#pluginListHost')) {
        clearInterval(timer);
        timer = null;
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
      text: '包是一个 .tar.gz：里面要有 plugin.json（声明 id / 名称 / 版本 / 类型 / 入口）+ 入口文件。校验两道：包的 md5（发布方给的那个）+ 清单里逐个文件的 md5。',
    })
  );
}
