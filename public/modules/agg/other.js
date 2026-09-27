'use strict';
/**
 * 聚合模块 · 「其他设置」页 —— 聚合里除了模板本身之外的少量对照关系。
 *
 * 目前只有一处：**哪个元数据域用哪套模板**（域 → 模板一对一，见 docs/adr/0033）。
 * 它原先挂在「模板」页上，可那是"跨模板"的对照、不是某一套模板的内容：
 * 与模板的增删改摆在一页，容易让人以为改的是当前这套模板 —— 所以拆到这里。
 * 一个域最多一套模板；没配的域，它的内容搜不到（如实为空，不猜）。
 */
import { el, toast } from '../../core/dom.js';
import { api } from '../../core/api.js';
import { S } from '../../core/state.js';
import { ensureTemplates } from '../../core/store.js';

export async function renderAggOther(v) {
  try {
    await ensureTemplates();
  } catch (e) {
    S.aggTemplates = S.aggTemplates || [];
    toast('读取设置失败：' + e.message, true);
  }

  const card = el('div', { class: 'card' }, el('h3', { text: '域 → 模板' }));
  v.append(card);

  const providers = S.aggProviders || [];
  if (!providers.length) {
    card.append(el('div', { class: 'hint warn', text: '还没有已注册的元数据域 —— 域由元数据插件申报（见「插件 → 管理」里装了哪些）。' }));
    return;
  }
  if (!(S.aggTemplates || []).length) {
    card.append(el('div', { class: 'hint warn', text: '还没有模板 —— 先到「聚合设置 → 模板」建一套。' }));
    return;
  }

  card.append(el('div', { class: 'note', text: '一个域最多一套模板；同一套模板可以给多个域共用。选「（没配）」= 取消指向 —— 那个域的内容就搜不到了。' }));
  card.append(
    el('div', {
      class: 'note',
      text:
        '这份对照只给客户端那条路用（Emby 按 `tmdb` 这类前缀问，面板据此翻译成一套模板）。' +
        '网页「聚合搜索」页不按域选，直接在那一页挑模板。',
    })
  );
  for (const p of providers) card.append(domRow(p));
}

/** 一个已注册的域一行：选它用哪套模板（改一下就存，没有「保存」按钮） */
function domRow(p) {
  const cur = (S.aggDomains || {})[p.prefix] || '';
  const sel = el('select', { title: `域 ${p.prefix} 用哪套模板` });
  sel.append(el('option', { value: '', text: '（没配 —— 这个域的内容搜不到）', selected: !cur }));
  for (const x of S.aggTemplates || []) {
    sel.append(el('option', { value: x.id, text: x.name, selected: cur === x.id }));
  }
  sel.addEventListener('change', async () => {
    try {
      const r = await api('/api/agg/domains/' + encodeURIComponent(p.prefix), { method: 'POST', body: { templateId: sel.value } });
      S.aggDomains = r.domains || {};
      const name = ((S.aggTemplates || []).find((x) => x.id === sel.value) || {}).name;
      toast(sel.value ? `域 ${p.prefix} → ${name}` : `域 ${p.prefix} 已取消指向`);
    } catch (e) {
      toast('设置失败：' + e.message, true);
    }
  });
  return el(
    'div',
    { class: 'kv' },
    el('span', { class: 'k', text: `${p.label}（域 ${p.prefix}）` }),
    sel,
    el('span', { class: 'note', text: !cur ? '⚠️ 没配模板 ⇒ 这个域的内容搜不到（如实为空）' : '' })
  );
}