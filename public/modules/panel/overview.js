'use strict';
/**
 * 面板模块 · 「概览」页：**只看不改** —— 运行环境（版本 / Node / 数据与设置目录 / 当前地址）
 * 与插件进程内存。
 *
 * 要动设置去同模块的「设置」页（备份还原 / 面板密码）。
 */
import { el } from '../../core/dom.js';
import { api } from '../../core/api.js';

/* 三个类型名与侧栏那三栏一致（元数据 / 片源 / 首页，见 core/registry.js） */
const TYPE_LABEL = { metadata: '元数据', source: '片源', home: '首页' };
const fmtBytes = (n) => (n == null ? '—' : n >= 1048576 ? (n / 1048576).toFixed(0) + 'MB' : Math.round(n / 1024) + 'KB');

export function renderPanelOverview(v) {
  const card = el('div', { class: 'card' }, el('h3', { text: '运行环境' }));
  const body = el('div');
  card.append(body);
  v.append(card);

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

  /* 插件进程内存：只列正在跑的（停用的没有进程、也没有内存可看） */
  const pbody = el('div', { class: 'note', text: '读取中…' });
  v.append(el('div', { class: 'card' }, el('h3', { text: '插件进程' }), pbody));

  api('/api/plugins')
    .then((d) => {
      const running = ((d && d.plugins) || []).filter((p) => p.status === 'running');
      pbody.className = '';
      pbody.textContent = '';
      if (!running.length) {
        pbody.className = 'note';
        pbody.textContent = '当前没有运行中的插件。';
        return;
      }
      let total = 0;
      for (const p of running) {
        total += p.memoryBytes || 0;
        pbody.append(
          el(
            'div',
            { class: 'kv' },
            el('span', { class: 'k', text: `${TYPE_LABEL[p.type] || p.type} · ${p.id}` }),
            el('span', { class: 'v', text: fmtBytes(p.memoryBytes) })
          )
        );
      }
      pbody.append(el('div', { class: 'note', text: `运行中 ${running.length} 个，合计 ${fmtBytes(total)}。内存读的是各插件进程的 RSS，读不到会显示「—」（不编数）。` }));
    })
    .catch((e) => {
      pbody.className = 'note err-note';
      pbody.textContent = '取插件状态失败：' + e.message;
    });
}
