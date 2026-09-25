'use strict';
/**
 * 插件模块 · 「管理」页：装 / 卸 / 启停 / 重启，看状态、内存与动作，打开插件自己的设置页。
 *
 * 这一页是面板侧唯一动插件的地方；**它不解释插件的内容** ——
 * 装的是包（tar.gz + 两道 md5 校验），调的是"动作"，插件自己的设置页是它自己的静态文件
 * （面板只负责托管与转发，见 docs/adr/0029 的已定 21）。
 *
 * 状态每 2 秒拉一次（只在这一页活着）：**状态、内存、重启次数**都在上面，
 * 「插件崩了会自动重启」这件事得看得见（见 docs/adr/0028）。
 */
import { $, el, toast, modal } from '../../core/dom.js';
import { api } from '../../core/api.js';
import { S } from '../../core/state.js';

const TYPE_LABEL = { metadata: '元数据', source: '源', home: '首页' };
const fmtBytes = (n) => (n == null ? '—' : n >= 1048576 ? (n / 1048576).toFixed(0) + 'MB' : Math.round(n / 1024) + 'KB');
const fmtDuration = (ms) => {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.round(s / 60) + 'm';
  return (s / 3600).toFixed(1) + 'h';
};

export async function renderPluginManage(v) {
  const host = el('div', { id: 'pluginListHost' });
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
    const d = S.plugins || { plugins: [], builtins: [] };
    box.textContent = '';

    if (!(d.plugins || []).length && !(d.builtins || []).length) {
      box.append(
        el('div', { class: 'card' }, el('h3', { text: '插件' }), el('div', { class: 'hint', text: '还没有装任何插件。上面那个「装一个插件」选一个 .tar.gz 包就能装上。' }))
      );
      return;
    }

    /* ---- 已装的 ---- */
    const card = el('div', { class: 'card' }, el('h3', { text: '已装插件' }));
    if (!(d.plugins || []).length) card.append(el('div', { class: 'note', text: '还没有装任何插件。' }));
    for (const p of d.plugins || []) {
      card.append(pluginRow(p));
    }
    const anyRunning = (d.plugins || []).some((p) => p.status === 'running');
    card.append(
      el('div', {
        class: 'note',
        text:
          '状态每 2 秒刷新一次。「启用」会立刻把它的进程拉起来；它自己崩了或被杀掉，宿主会自动重启它（最多 5 次 / 5 分钟，每次都在日志里点名）。' +
          (anyRunning ? '' : '') +
          '「内存」读的是它那个进程的 RSS；读不到会显示「—」（不编数）。',
      })
    );
    box.append(card);

    /* ---- 仓库里随包发行的、还没装的 ---- */
    if ((d.builtins || []).length) {
      const b = el('div', { class: 'card' }, el('h3', { text: '随包发行的内置插件（还没装）' }), el('div', { class: 'note', text: '它们跟着面板一起发行，开机时同步进插件目录 —— 这里列出来只是为了让你知道有它们。' }));
      for (const x of d.builtins) {
        b.append(
          el(
            'div',
            { class: 'kv' },
            el('span', { class: 'k', text: `${TYPE_LABEL[x.type] || x.type} · ${x.name}` }),
            el('span', { class: 'v', text: `v${x.version}　${x.description || ''}` })
          )
        );
      }
      box.append(b);
    }
  }

  function pluginRow(p) {
    const statusText =
      p.status === 'running' ? '运行中' : p.status === 'starting' ? '启动中…' : p.status === 'broken' ? '起不来' : p.enabled ? '已启用（没在跑）' : '已停用';
    const bits = [
      `${TYPE_LABEL[p.type] || p.type} · ${p.id}`,
      `v${p.version}`,
      statusText,
      p.domain ? `域 ${p.domain}` : '',
      `内存 ${fmtBytes(p.memoryBytes)}`,
      p.status === 'running' ? `已跑 ${fmtDuration(p.uptimeMs)}` : '',
      p.restarts ? `重启过 ${p.restarts} 次` : '',
      p.origin === 'builtin' ? '随包发行' : '手动安装',
    ].filter(Boolean);

    const btn = (text, title, fn, cls = 'btn mini') => el('button', { class: cls, title, text, onclick: fn });
    const act = async (fn) => {
      try {
        await fn();
      } catch (e) {
        toast(e.message, true);
      }
      await load();
    };

    const row = el(
      'div',
      { class: 'kv' },
      el('span', { class: 'k', text: p.name || p.id }),
      el('span', { class: 'v note', text: bits.join('　·　') }),
      el(
        'span',
        { class: 'row' },
        p.enabled
          ? btn('停用', '停掉它的进程（它自己起的东西由它自己清理）', () => act(() => api(`/api/plugins/${p.type}/${p.id}/disable`, { method: 'POST' })))
          : btn('启用', '起它的进程', () => act(() => api(`/api/plugins/${p.type}/${p.id}/enable`, { method: 'POST' })), 'btn mini primary'),
        btn('重启', '重起它的进程（手动重启会把自动重启的退避计数清零）', () => act(() => api(`/api/plugins/${p.type}/${p.id}/restart`, { method: 'POST' }))),
        p.hasWebui ? btn('设置', '打开插件自己的设置页', () => window.open(p.webuiPath, '_blank'), 'btn mini primary') : null,
        btn('调试', '手发一条动作给它（面板不解释动作与参数，原样转过去）', () => callDialog(p)),
        btn('卸载', '卸载它 —— 它的 data/ 目录也会一起删掉', () => uninstall(p))
      )
    );
    if (p.lastError) {
      row.append(el('div', { class: 'note err-note', text: '最近一次错误：' + p.lastError }));
    }
    if ((p.actions || []).length) {
      row.append(el('div', { class: 'note', text: '实现了这些动作：' + p.actions.join(' / ') }));
    }
    return row;
  }

  /** 调试台：手发一条动作（插件作者最需要的那个小工具） */
  function callDialog(p) {
    const action = el('input', { type: 'text', class: 'w-md', value: (p.actions || [])[0] || '', placeholder: '动作名' });
    const timeout = el('input', { type: 'number', class: 'w-sm', value: '20000', min: '1000', title: '这次调用的超时（毫秒）' });
    const out = el('pre', { class: 'json', text: '（点「发一条」看结果）' });
    const send = el('button', {
      class: 'btn primary',
      text: '发一条',
      onclick: async () => {
        send.disabled = true;
        try {
          const r = await api(`/api/plugins/${p.type}/${p.id}/call`, {
            method: 'POST',
            body: { action: action.value.trim(), args: argsEl.value.trim() ? JSON.parse(argsEl.value) : {}, timeoutMs: Number(timeout.value) },
          });
          out.textContent = JSON.stringify(r, null, 2);
        } catch (e) {
          out.textContent = '失败：' + e.message;
        } finally {
          send.disabled = false;
        }
      },
    });
    const argsEl = el('input', { type: 'text', class: 'w-lg', value: '{}', placeholder: '参数（JSON，面板原样转给插件）' });
    modal({
      title: `调试 · ${p.name || p.id}`,
      body: [
        el('div', { class: 'row' }, el('span', { class: 'muted', text: '动作' }), action, el('span', { class: 'muted', text: '参数' }), argsEl, timeout, el('span', { class: 'muted', text: '毫秒' })),
        el('div', { class: 'row' }, send),
        out,
        el('div', { class: 'note', text: '面板不解释动作与参数 —— 原样转给插件，插件的回答也原样显示在这里。' }),
      ],
    });
  }

  async function uninstall(p) {
    if (!confirm(`卸载「${p.name || p.id}」（${p.type}/${p.id}）？\n\n它的进程会停掉，插件目录与它自己的 data/ 目录都会删掉。`)) return;
    await act(() => api(`/api/plugins/${p.type}/${p.id}`, { method: 'DELETE' }));
    toast('已卸载：' + (p.name || p.id));
  }

  /* ------------------------------------------------------------------ 轮询 */

  let timer = null;
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
    el('div', { class: 'row' }, file, md5In, el('label', { class: 'chk', title: '装完立刻启用（起它的进程）' }, enableCb, '装完就启用'), go),
    out,
    el('div', {
      class: 'note',
      text: '包是一个 .tar.gz：里面要有 plugin.json（声明 id / 名称 / 版本 / 类型 / 入口）+ 入口文件。校验两道：包的 md5（发布方给的那个）+ 清单里逐个文件的 md5。',
    })
  );
}
