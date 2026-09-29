'use strict';
/**
 * 面板模块 · 「概览」页：运行环境（版本 / Node / 数据与设置目录 / 当前地址）+ 两个**整机动作**。
 *
 * 动作只放两件"与面板本身有关、又不属于某项设置"的：**面板重启**与**退出登录**。
 * 它们原先散在「设置」页底部（退出登录）与"更新完顺带重启"里，挪到这一页是因为
 * 概览是进面板的第一屏，这两件事要的就是"随手够得着"。
 *
 * 具体设置按性质分在别处：备份还原在「备份与还原」页，改密码在「安全」页，
 * 测速与缓存在「设置」页。
 */
import { el, confirmModal } from '../../core/dom.js';
import { api } from '../../core/api.js';
import { authStatus, logout } from '../../core/auth.js';

/** 重启后的轮询节奏：间隔与总时限。重启那几秒请求会被拒绝，属预期，不按错误处理。 */
const POLL_MS = 500;
const POLL_LIMIT_MS = 60000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 等面板重新起来：比的是 `/api/panel/info` 给的**进程启动时间**（`startedAt`）。
 *
 * 面板重启只换进程、不换版本，所以版本号不能当判据；日志序号也不行 ——
 * 实测交接只有约 0.4 秒，新进程启动时本身就刷出几十行日志，等轮询打到时序号
 * 已经涨过重启前的值，"序号变小"根本抓不到。`startedAt` 在同一进程内恒定、
 * 换进程必然不同，轮询拿到一个与重启前不同的值，就是新进程无疑。
 * 重启那几秒的请求失败不按错误处理，继续等。
 *
 * 超过时限返回 false —— 由调用方提示手动刷新，绝不假装成功。
 */
async function waitBack(beforeStartedAt) {
  const deadline = Date.now() + POLL_LIMIT_MS;
  let sawDown = false;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    let startedAt = null;
    try {
      startedAt = (await api('/api/panel/info')).startedAt;
    } catch {
      sawDown = true; // 断了：正常，正在重启
      continue;
    }
    if (beforeStartedAt) {
      if (startedAt !== beforeStartedAt) return true;
    } else if (sawDown && startedAt) {
      /* 重启前没拿到身份的兜底：得先确认断过，否则旧进程答一句就被误认成"回来了" */
      return true;
    }
  }
  return false;
}

/** 面板重启：确认 → 请求 → 等它回来 → 刷新页面。**容器不动**，只重起应用进程。 */
function restartCard() {
  const btn = el('button', { class: 'btn', text: '面板重启' });
  const out = el('div', { class: 'note hidden' });

  btn.addEventListener('click', async () => {
    const yes = await confirmModal({
      title: '重启面板？',
      text:
        '会重起面板的应用进程（容器不动，版本不变）：几秒内打不开页面、正在进行的请求会断，' +
        '重启后照旧。插件进程也会跟着重起一轮（启用的会自动拉起来）。' +
        '设置、模板、插件与账号数据都不受影响。',
      okLabel: '重启',
    });
    if (!yes) return;

    btn.disabled = true;
    out.className = 'note';
    out.textContent = '正在重启，请稍候…';
    try {
      let beforeStartedAt = null;
      try {
        beforeStartedAt = (await api('/api/panel/info')).startedAt;
      } catch {
        /* 拿不到进程身份也照样请求重启；waitBack 第一次拿到非空值即可认作新进程 */
      }
      await api('/api/panel/restart', { method: 'POST' });
      const ok = await waitBack(beforeStartedAt);
      if (!ok) {
        out.className = 'note err-note';
        out.textContent = '等了一会儿还没见面板回来 —— 请手动刷新页面确认（重启期间打不开是正常的）。';
        btn.disabled = false;
        return;
      }
      out.textContent = '面板已重启，正在刷新…';
      location.reload();
    } catch (e) {
      out.className = 'note err-note';
      out.textContent = '重启失败：' + e.message;
      btn.disabled = false;
    }
  });

  return el(
    'div',
    { class: 'card' },
    el('h3', { text: '面板重启' }),
    el('p', {
      class: 'note',
      text:
        '重起面板的应用进程（容器不动，版本不变）—— 改了插件、想清掉运行态、或者觉得哪里不对时用。' +
        '插件进程会跟着重起一轮。与「关于」页那个"装新版本后重启"不是一回事：这里不装东西。',
    }),
    el(
      'div',
      { class: 'row' },
      btn,
      el('button', { class: 'btn', text: '退出登录', onclick: () => logout() })
    ),
    out
  );
}

export function renderPanelOverview(v) {
  const card = el('div', { class: 'card' }, el('h3', { text: '运行环境' }));
  const body = el('div');
  card.append(body);
  v.append(card, restartCard());

  api('/api/panel/info')
    .then((info) => {
      const rows = [
        ['面板版本', info.version],
        ['Node', info.node],
        ['数据目录', info.dataDir],
        ['设置目录', info.settingsDir],
        ['当前地址', location.origin],
      ];
      for (const [k, val] of rows) {
        body.append(el('div', { class: 'kv' }, el('span', { class: 'k', text: k }), el('span', { class: 'v', text: val || '-' })));
      }
    })
    .catch((e) => body.append(el('div', { class: 'note err-note', text: '取运行环境失败：' + e.message })));

  /* 还在用默认密码 → 页顶插一条警告（改密码在「安全」页，这里只指路） */
  authStatus().then((st) => {
    if (!st.isDefault) return;
    v.insertBefore(
      el(
        'div',
        { class: 'hint warn' },
        '⚠️ 面板还在用默认密码 ',
        el('code', { text: '123456' }),
        ' —— 任何人打开这个地址都能进。到「面板设置 → 安全」里改掉。'
      ),
      card
    );
  });
}