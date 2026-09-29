'use strict';
/**
 * Emby 模块 · 「实例」页 —— **多实例的增 / 删 / 改**。
 *
 * 一个实例 = 一个**自己的端口** + 一套**自己的身份与数据**（账号 / 会话 / 播放进度各一个库）
 * + **选定的一个首页插件**（那个插件的全部行 = 这个实例客户端上的媒体库）
 * + **一套限定的搜索域**（客户端搜索走哪些元数据域；缺席 = 全部）。
 * 客户端「添加服务器」时填的就是这一行上的连接地址（见后端 `routes.js` 的 `/api/emby/instances`）。
 *
 * 首页插件做成**行内的下拉**（点一下就换，走 PATCH）：它是这一页最高频的动作，
 * 塞进弹窗等于每次都要"开窗→选→保存→关窗"；改名 / 改端口 / 启停则走弹窗
 * （那几样改错了客户端会连不上，值得多一步确认）。
 *
 * ⚠️ 端口不是随便填的：面板本体端口被后端 `instance.validate` 挡掉；留空则由后端从 8090 起
 * 挑一个空闲的（占用了就 +1）。被占用的端口**不会**让面板起不来 —— 只是这一行的状态变成红点 + 原因。
 */
import { el, modal, toast, confirmModal } from '../../core/dom.js';
import { api } from '../../core/api.js';
import { S } from '../../core/state.js';
import { renderPage } from '../../core/shell.js';

export async function renderEmbyInstances(v) {
  let err = '';
  try {
    await loadInstances();
  } catch (e) {
    err = e.message;
  }
  /* 首页插件清单只喂那个下拉，取不到不算错（下拉里只有"未选择"），但要说清楚为什么空 */
  let pluginErr = '';
  try {
    await loadHomePlugins();
  } catch (e) {
    pluginErr = e.message;
  }
  /* 元数据域清单只喂那个多选，取不到同样不算错（多选里只有"全部"的默认口径） */
  let domainErr = '';
  try {
    await loadMetaDomains();
  } catch (e) {
    domainErr = e.message;
  }

  if (err) {
    v.append(el('div', { class: 'hint warn', text: '读取实例失败：' + err + '（面板的 Emby 层没起来？看「面板设置 → 日志」）' }));
    return;
  }

  v.append(introCard(), listCard(pluginErr, domainErr));
}

async function loadInstances(force = false) {
  if (!force && S.emby.instances) return S.emby.instances;
  const r = await api('/api/emby/instances');
  S.emby.instances = r.instances || [];
  S.emby.maxInstances = r.max || 0;
  return S.emby.instances;
}

async function loadHomePlugins(force = false) {
  if (!force && S.emby.homePlugins) return S.emby.homePlugins;
  const r = await api('/api/emby/home-plugins');
  S.emby.homePlugins = r.plugins || [];
  return S.emby.homePlugins;
}

async function loadMetaDomains(force = false) {
  if (!force && S.emby.metaDomains) return S.emby.metaDomains;
  const r = await api('/api/emby/meta-domains');
  S.emby.metaDomains = r.domains || [];
  return S.emby.metaDomains;
}

/** 改完实例之后：清单与账号都得重拉（账号是按实例分的），再整页重画 */
async function afterChange(msg) {
  S.emby.instances = null;
  S.emby.accounts = null;
  S.emby.accountsFor = '';
  toast(msg);
  renderPage();
}

/* ------------------------------------------------------------------ 说明卡 */

function introCard() {
  return el(
    'div',
    { class: 'card' },
    el('h3', { text: 'Emby 实例' }),
    el('p', {
      class: 'note',
      text: '多个实例等于多个 Emby 服务器。',
    })
  );
}

/* ------------------------------------------------------------------ 实例列表 */

function listCard(pluginErr, domainErr) {
  const list = S.emby.instances || [];
  const max = S.emby.maxInstances || 0;
  const card = el(
    'div',
    { class: 'card' },
    el('h3', { text: `实例${max ? `（${list.length} / ${max}）` : ''}` }),
    el(
      'div',
      { class: 'actions' },
      el('button', {
        class: 'btn primary',
        text: '＋ 新增实例',
        onclick: () => openEditor(null),
      }),
      el('button', {
        class: 'btn',
        title: '重新读一份实例清单与运行状态',
        text: '刷新',
        onclick: async () => {
          try {
            await loadInstances(true);
            await loadHomePlugins(true);
            await loadMetaDomains(true);
            renderPage();
          } catch (e) {
            toast('刷新失败：' + e.message, true);
          }
        },
      })
    )
  );

  if (pluginErr) card.append(el('div', { class: 'hint warn', text: '读不到首页插件清单：' + pluginErr + '（下拉里只剩「未选择」）' }));
  if (domainErr) card.append(el('div', { class: 'hint warn', text: '读不到元数据域清单：' + domainErr + '（搜索域多选里只剩已保存的那些）' }));

  if (!list.length) {
    card.append(el('div', { class: 'muted', text: '还没有实例。' }));
    return card;
  }
  for (const inst of list) card.append(instanceRow(inst));
  return card;
}

function instanceRow(inst) {
  const run = inst.running
    ? el('span', { class: 'dot running', title: '在监听（客户端能连上）' })
    : el('span', { class: 'dot error', title: '没在监听' });

  const row = el(
    'div',
    { class: 'file-row' },
    run,
    el('span', { class: 'name', title: inst.id, text: inst.name }),
    el('span', { class: 'badge mono', title: '这个实例自己的端口（客户端填它）', text: ':' + inst.port }),
    inst.isDefault ? el('span', { class: 'badge', title: '默认实例：老数据（原 emby.db）挂在它身上，不能删', text: '默认' }) : null,
    homePluginSelect(inst),
    el('code', { class: 'mono', text: inst.url }),
    el('button', { class: 'btn mini', title: '复制这个地址到剪贴板', text: '复制', onclick: () => copyText(inst.url) }),
    el('button', { class: 'btn mini', text: '编辑', onclick: () => openEditor(inst) }),
    inst.isDefault
      ? null
      : el('button', {
          class: 'btn mini danger',
          text: '删除',
          onclick: () => removeInstance(inst),
        })
  );

  /* 第二行：这一实例的规模 + 状态说明（错误 / 停用都写在这里，红字那句用 err-note） */
  const stats = `${inst.accountCount} 个账号 · ${inst.sessionCount} 个在线会话 · ${inst.viewCount} 个媒体库 · 搜索域：${domainsBrief(inst)}`;
  if (inst.error) {
    row.append(el('div', { class: 'err-note', text: `没在监听：${inst.error} —— 换个端口，或把占用那个端口的程序停掉，再来点「编辑」保存一次。` }));
  } else if (!inst.enabled) {
    row.append(el('div', { class: 'note', text: `${stats}。这个实例已停用，不在监听 —— 客户端连不上（数据还在）。` }));
  } else {
    row.append(el('div', { class: 'note', text: stats }));
  }
  return row;
}

/** 行内的「首页插件」下拉：选中即 PATCH（见文件头那段，这是本页最高频的动作） */
function homePluginSelect(inst) {
  const sel = el('select', { title: '这个实例客户端上的媒体库 = 所选插件的全部行；未选择 = 空库' });
  const opts = [{ id: '', name: '（未选择 —— 空库）' }, ...(S.emby.homePlugins || [])];
  /* 清单里没有当前值（插件被卸了 / 清单没取到）也要把它列出来，否则下拉会静默跳到第一项 */
  if (inst.homePlugin && !opts.some((p) => p.id === inst.homePlugin)) opts.push({ id: inst.homePlugin, name: inst.homePlugin, missing: true });
  for (const p of opts) {
    const note = p.missing ? '（插件不在了）' : p.id ? ` · ${p.enabled ? '' : '未启用'}${p.rowCount === undefined ? '' : p.rowCount + ' 行'}` : '';
    const o = el('option', { value: p.id, text: `${p.name}${p.id ? `（${p.id}）` : ''}${note}` });
    if (p.id === (inst.homePlugin || '')) o.selected = true;
    sel.append(o);
  }
  sel.addEventListener('change', async () => {
    sel.disabled = true;
    try {
      await api('/api/emby/instances/' + encodeURIComponent(inst.id), { method: 'PATCH', body: { homePlugin: sel.value } });
      await afterChange(sel.value ? `首页已切换为：${sel.value}` : '已清空首页 —— 这个实例的媒体库现在是空的');
    } catch (e) {
      toast('切换失败：' + e.message, true);
      sel.disabled = false;
      sel.value = inst.homePlugin || '';
    }
  });
  return sel;
}

/* ------------------------------------------------------------------ 增 / 改 / 删 */

/** 行上那句「搜索域」摘要：`null`/缺席 = 全部；空数组 = 无 */
function domainsBrief(inst) {
  const d = inst.metaDomains;
  if (!Array.isArray(d)) return '全部';
  if (!d.length) return '无（客户端搜不到内容）';
  return d.join('、');
}

/**
 * 搜索域多选组：每个元数据域一个勾选框。**新增 → 全选**；编辑 → 按 `inst.metaDomains`
 * （`null`/缺席 = 全部 → 全选）。
 * 已保存但当前清单里没有的域（插件被卸了）也补一项并勾上 —— 否则提交时会被静默丢掉。
 * 回 `{ row, hasItems, checked }`：`hasItems` 为假时调用方别写 `metaDomains`（保持"缺席=全部"）。
 */
function metaDomainPicker(inst) {
  const saved = inst && Array.isArray(inst.metaDomains) ? inst.metaDomains.slice() : null; // null = 全部
  const items = (S.emby.metaDomains || []).map((d) => ({ domain: d.domain, label: d.label, enabled: d.enabled, missing: false }));
  if (saved) for (const d of saved) if (!items.some((x) => x.domain === d)) items.push({ domain: d, label: d, enabled: false, missing: true });

  const row = el('div', { class: 'row' });
  const boxes = [];
  for (const it of items) {
    const cb = el('input', { type: 'checkbox', title: it.domain });
    cb.checked = saved ? saved.includes(it.domain) : true;
    cb.dataset.domain = it.domain;
    boxes.push(cb);
    const note = it.missing ? '（插件不在了）' : it.enabled ? '' : ' · 未启用';
    row.append(el('label', { class: 'chk' }, cb, `${it.label}${note}`));
  }
  if (!items.length) row.append(el('span', { class: 'muted', text: '还没有装元数据插件（「插件」页可以装一个）' }));

  return { row, hasItems: items.length > 0, checked: () => boxes.filter((b) => b.checked).map((b) => b.dataset.domain) };
}

/** 新增（inst = null）与编辑共用一张窗：几样都是 `instance.patch` 认的字段 */
function openEditor(inst) {
  const isNew = !inst;
  const name = el('input', { type: 'text', spellcheck: 'false', maxlength: '40', placeholder: '实例名称', value: isNew ? '' : inst.name });
  const port = el('input', {
    type: 'number',
    class: 'w-md',
    min: '1',
    max: '65535',
    placeholder: '留空 = 自动挑',
    value: isNew ? '' : String(inst.port),
  });
  const sel = el('select');
  for (const p of [{ id: '', name: '（未选择 —— 空库）' }, ...(S.emby.homePlugins || [])]) {
    const o = el('option', { value: p.id, text: p.id ? `${p.name}（${p.id}）${p.enabled ? '' : ' · 未启用'}` : p.name });
    if (p.id === ((isNew ? '' : inst.homePlugin) || '')) o.selected = true;
    sel.append(o);
  }
  const enabled = el('input', { type: 'checkbox' });
  enabled.checked = isNew ? true : !!inst.enabled;
  const picker = metaDomainPicker(inst);
  const tip = el('div', { class: 'note' });

  modal({
    title: isNew ? '新增 Emby 实例' : `编辑「${inst.name}」`,
    body: [
      el('div', { class: 'field' }, el('label', { text: '实例名（客户端「服务器名」）' }), name),
      el('div', { class: 'field' }, el('label', { text: '端口' }), port),
      el('div', { class: 'field' }, el('label', { text: '首页插件（= 这个实例的媒体库）' }), sel),
      el('div', { class: 'field' }, el('label', { text: '接受的元数据域内容' }), picker.row),
      el('label', { class: 'chk' }, enabled, '启用（启用才会在这个端口上监听）'),
      tip,
    ],
    actions: [
      { label: '取消' },
      {
        label: isNew ? '创建' : '保存',
        primary: true,
        onclick: async () => {
          const body = {
            name: name.value.trim(),
            enabled: enabled.checked,
            homePlugin: sel.value,
          };
          /* 搜索域：有可选项时才写（一个域都没装时保持"缺席=全部"）；全不勾 = `[]`（一个都不搜） */
          if (picker.hasItems) body.metaDomains = picker.checked();
          if (!body.name) {
            tip.textContent = '实例名不能空';
            return false;
          }
          /* 端口只在填了的时候才传：留空 = 交给后端自动挑（新增），或不改（编辑） */
          if (String(port.value).trim()) body.port = Number(port.value);
          try {
            const r = isNew
              ? await api('/api/emby/instances', { method: 'POST', body })
              : await api('/api/emby/instances/' + encodeURIComponent(inst.id), { method: 'PATCH', body });
            await afterChange(isNew ? `已新增实例：${r.instance.name}（端口 ${r.instance.port}）` : `已保存：${r.instance.name}`);
          } catch (e) {
            /* 端口不合法 / 已被别的实例占用 / 名字太长 —— 后端的话原样显示，窗口留着不丢输入 */
            tip.textContent = (isNew ? '创建失败：' : '保存失败：') + e.message;
            return false;
          }
        },
      },
    ],
  });
}

async function removeInstance(inst) {
  const go = await confirmModal({
    title: '删除实例',
    text:
      `删除「${inst.name}」（端口 ${inst.port}）？` +
      `它自己的 ${inst.accountCount} 个账号与全部观看进度**一并删掉**，删完找不回来；那些客户端要重新建账号。`,
    okLabel: '删除',
    primary: false,
  });
  if (!go) return;
  try {
    await api('/api/emby/instances/' + encodeURIComponent(inst.id), { method: 'DELETE' });
    await afterChange('已删除实例：' + inst.name);
  } catch (e) {
    toast('删除失败：' + e.message, true);
  }
}

/* ------------------------------------------------------------------ 小工具 */

/** 复制到剪贴板。**http 直连局域网 IP 时剪贴板 API 不可用**（非安全上下文）——
 *  那种情况如实提示手动复制，不假装成功。 */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制：' + text);
  } catch {
    toast('这个浏览器不让直接复制，请手动选中：' + text, true);
  }
}