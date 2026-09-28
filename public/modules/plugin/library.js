'use strict';
/**
 * 插件模块 · 「插件库」页：从**插件仓库**里挑一个装。
 *
 * 为什么有这一页（见 docs/adr/0035）：**插件不随面板发行** —— 全新安装的面板一个插件都没有，
 * 元数据与片源都得人去装。插件包集中放在一个独立仓库里（只放包 + 清单，不放源码），
 * 这一页拉它的 `index.json`，把"可装的"列出来；点一下就下载 → 校验 → 安装。
 *
 * ⚠️ 面板**不解释清单的内容**：清单里的字段由契约规定（见 docs/plugin-contract.md 第七节），
 * 这里只是把"可装的"画出来、把 type/id 交给后端。装包这件事本身与手动上传走的是同一套。
 *
 * 手动装（本地的 `.tar.gz`）在「插件 → 管理」页 —— 两条入口分开，是因为"从哪拿包"不同。
 */
import { $, el, toast, confirmModal, fmtTime } from '../../core/dom.js';
import { api } from '../../core/api.js';
import { S } from '../../core/state.js';
import { refreshNav } from '../../core/shell.js';

const TYPE_LABEL = { metadata: '元数据', source: '片源', home: '首页' };
const fmtKB = (n) => (Number(n) > 0 ? `约 ${Math.max(1, Math.round(Number(n) / 1024))}KB` : '');

export async function renderPluginLibrary(v) {
  const host = el('div', { id: 'pluginLibHost' });
  /* 「装完就启用」这颗复选框跨重绘保留：清单每次重画都把它原样挂回去，勾选状态不会丢 */
  const enableCb = el('input', { type: 'checkbox', checked: true });
  v.append(host);
  await load();

  /** 拉一次清单（`force` = 绕过后端那 60 秒缓存）并重绘 */
  async function load(force = false) {
    const box = $('#pluginLibHost');
    if (!box) return;
    box.textContent = '';
    let d = null;
    try {
      d = await api('/api/plugins/library' + (force ? '?refresh=1' : ''));
    } catch (e) {
      box.append(el('div', { class: 'card' }, el('h3', { text: '插件库' }), el('div', { class: 'hint warn', text: '读取插件库失败：' + e.message })));
      return;
    }
    paint(d || {});
  }

  /** 装完刷新「已装」清单：侧栏那三栏是按插件清单现算的，新插件的设置页入口要立刻出现 */
  async function refreshInstalled() {
    try {
      S.plugins = await api('/api/plugins');
      refreshNav();
    } catch {
      /* 侧栏没刷新不算装失败：下次进这一页会重拉 */
    }
  }

  async function install(p, btn) {
    const ok = await confirmModal({
      title: `装插件「${p.name || p.id}」`,
      text:
        `v${p.version}（${TYPE_LABEL[p.type] || p.type} · ${p.id}）\n\n` +
        '插件能读写数据、能联网、能起进程 —— 装了就等于在这台机器上跑它的代码。只装信得过的来源。',
      okLabel: '装上去',
    });
    if (!ok) return;
    btn.disabled = true;
    btn.textContent = '正在下载…';
    try {
      const r = await api('/api/plugins/library/install', {
        method: 'POST',
        body: { type: p.type, id: p.id, version: p.version, enable: enableCb.checked },
      });
      toast('已装上：' + ((r.plugin && r.plugin.name) || p.name || p.id));
      await load(true);
      await refreshInstalled();
    } catch (e) {
      toast('装失败：' + e.message, true);
      btn.textContent = p.installed ? '重装' : '安装';
      btn.disabled = false;
    }
  }

  function rowOf(p) {
    const label = !p.installed ? '安装' : p.hasUpdate ? `更新到 v${p.version}` : '重装';
    const btn = el('button', { class: 'btn mini primary', text: label, title: `装 ${p.type}/${p.id} v${p.version}` });
    btn.addEventListener('click', () => install(p, btn));
    const bits = [
      `${TYPE_LABEL[p.type] || p.type} · ${p.id}`,
      fmtKB(p.bytes),
      p.domain ? `域 ${p.domain}` : '',
      (p.depends || []).length ? `依赖 ${p.depends.join(' / ')}` : '',
    ].filter(Boolean);
    return el(
      'div',
      { class: 'plugin-row' },
      el(
        'div',
        { class: 'plugin-head' },
        el('span', { class: 'plugin-name', text: p.name || p.id }),
        el('span', { class: 'badge', text: 'v' + p.version }),
        p.installed ? el('span', { class: 'badge ok', text: '已装 v' + (p.installedVersion || '?') }) : null,
        el('span', { class: 'spacer' }),
        el('div', { class: 'row plugin-acts' }, btn)
      ),
      el('div', { class: 'note', text: bits.join(' · ') }),
      p.description ? el('div', { class: 'note', text: p.description }) : null
    );
  }

  function paint(d) {
    const box = $('#pluginLibHost');
    if (!box) return;

    /* ---- 头一张卡：这是哪个仓库、索引什么时候生成的、要不要装完就起来 ---- */
    const head = el(
      'div',
      { class: 'card' },
      el('h3', { text: '插件库' }),
      el(
        'div',
        { class: 'row' },
        el('span', { class: 'muted', text: '来源：' }),
        el('a', { href: d.repoUrl || '#', target: '_blank', rel: 'noreferrer', text: d.repo || '（未知）' }),
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn mini', text: '刷新', title: '重新拉一次清单（绕过后端 60 秒缓存）', onclick: () => load(true) })
      ),
      el('div', { class: 'row' }, el('label', { class: 'chk', title: '装完立刻启用（起它的进程）' }, enableCb, '装完就启用')),
      el('div', {
        class: 'note',
        /* 手动那条路在另一页，这里点一句就够，别把它也搬过来（两页各管一种"从哪拿包"） */
        text: '装的是仓库里的包，校验两道（包的 md5 + 包内清单逐个文件的 md5）。要装本地的 .tar.gz，到「插件 → 管理」页手动安装。',
      })
    );
    if (d.error) head.append(el('div', { class: 'hint warn', text: '清单取不到：' + d.error }));
    else if (d.generatedAt) head.append(el('div', { class: 'note', text: '索引生成于 ' + fmtTime(d.generatedAt) }));
    box.append(head);

    /* ---- 第二张卡：可装的插件（含已装的"重装 / 更新"） ---- */
    const list = el('div', { class: 'card' }, el('h3', { text: '可装的插件' }));
    if (!(d.plugins || []).length) {
      list.append(el('div', { class: 'note', text: d.error ? '清单没取到，所以这里没有可装的插件。' : '这个仓库的清单里没有插件。' }));
    } else {
      for (const p of d.plugins) list.append(rowOf(p));
      list.append(
        el('div', {
          class: 'note',
          text: '装完默认是停用状态（除非勾了上面那个「装完就启用」）—— 装完由人明确打开，见「插件 → 管理」。',
        })
      );
    }
    if ((d.bad || []).length) {
      list.append(
        el('div', {
          class: 'hint warn',
          text: `清单里有 ${d.bad.length} 条读不懂，已跳过：` + d.bad.map((x) => `${x.type || '?'}/${x.id || '?'}（${x.reason}）`).join('；'),
        })
      );
    }
    box.append(list);
  }
}