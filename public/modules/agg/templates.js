'use strict';
/**
 * 聚合模块 · 「模板」页 —— **模板就是一份配置数据文件**：选中的站点 + 打分过滤参数 + 超时与并发。
 *
 * 这一页把原来的「站点与参数」与「聚合参数」合成一处（两页本来就是同一件事的两半：
 * 一套模板里的东西）。页面分三块：
 *   ① 模板本身：选哪一套、新建 / 改名 / 删除，以及**每个域用哪一套**（域 → 模板 一对一，见 ADR-0033）
 *   ② 这套模板的参数（超时 / 并发 / 打分 / 匹配到底 / 线路过滤）—— 收在折叠区里，
 *      因为它是"偶尔调一次"的旋钮，不该跟天天勾的站点表抢地方
 *   ③ 站点表：勾选参与这套模板的站点（勾选即存回模板）
 *
 * ⚠️ **测速的开关与间隔不在这里**（已搬到「面板设置」）—— 测速是"这台机器与这条网络"的体检，
 * 与内容偏好无关，而测速的**结果**是面板级共享的一份、不跟模板走。本站点表里的「延迟」列
 * 与「立即测速」按钮仍在（那是"看结果"和"手点一轮"）。
 */
import { $, el, toast } from '../../core/dom.js';
import { api } from '../../core/api.js';
import { S } from '../../core/state.js';
import { sid, ensureAggSites, ensureTemplates } from '../../core/store.js';
import { renderPage, renderNav } from '../../core/shell.js';

/** 当前编辑的模板 id（放在 `S` 上：翻页回来还是同一套） */
function curTpl() {
  const list = S.aggTemplates || [];
  return list.find((t) => t.id === S.tplId) || list[0] || null;
}

export async function renderTemplates(v) {
  await loadTemplates();

  if (!(S.aggTemplates || []).length) {
    v.append(
      el(
        'div',
        { class: 'card' },
        el('h3', { text: '模板' }),
        el('p', {
          class: 'note',
          text:
            '还没有模板。模板 = 一份配置：选中的站点 + 打分过滤参数 + 超时与并发。' +
            '每个元数据域（比如 tmdb）指定一套模板；没配模板的域，它的内容会搜不到（如实为空，不猜）。',
        }),
        el('div', { class: 'row' }, el('button', { class: 'btn primary', text: '新建一套模板', onclick: () => createTemplate() }))
      )
    );
    return;
  }

  const t = curTpl();
  v.append(tplCard(t), paramsCard(t), sitesBlock(t));
  if (S.aggLoadedFor) {
    paintSites(t);
    return;
  }
  /* 站点清单归源插件：它要挨个问自己那些实例的 `/config`（连不上的要等超时），先画上面的卡片。
   * ⚠️ 这一块用的是**另一个宿主**（`siteAreaHost`），拿到之后必须把它清掉 ——
   * 否则那句"正在取…"会一直挂在站点表下面（实测就是这么留着的）。 */
  const host = el('div', { id: 'siteAreaHost' });
  v.append(host);
  host.append(el('div', { class: 'hint', text: '正在取站点清单…（连不上的实例要等超时；模板与参数可以先改）' }));
  try {
    await ensureAggSites();
  } catch (e) {
    if (!host.isConnected) return;
    host.textContent = '';
    host.append(el('div', { class: 'hint warn', text: '读取站点失败：' + e.message }));
    return;
  }
  if (!host.isConnected) return;
  host.textContent = '';
  paintSites(curTpl());
}

/** 拉模板清单 / 域对照 / 已注册的域（走 store 那一份，页面与搜索页共用同一处）。
 *  失败不该让整页空白 —— 拿不到就按内存里那份画。 */
async function loadTemplates(force = false) {
  try {
    await ensureTemplates({ force });
  } catch (e) {
    S.aggTemplates = S.aggTemplates || [];
    toast('读取模板失败：' + e.message, true);
  }
  if (S.tplId && !(S.aggTemplates || []).some((t) => t.id === S.tplId)) S.tplId = '';
}

async function createTemplate() {
  const name = prompt('这套模板叫什么？（例如「影视」「动漫」）', '新模板');
  if (!name || !name.trim()) return;
  try {
    const r = await api('/api/agg/templates', { method: 'POST', body: { template: { name: name.trim(), sites: [] } } });
    S.tplId = r.template.id;
    await loadTemplates(true);
    toast('已新建模板：' + r.template.name);
    renderPage();
  } catch (e) {
    toast('新建失败：' + e.message, true);
  }
}

/** 把当前模板整份存回去（勾选、改名、参数都走它） */
async function saveTemplate(t, patch) {
  const body = {
    id: t.id,
    name: patch.name === undefined ? t.name : patch.name,
    sites: patch.sites === undefined ? t.sites : patch.sites,
    params: patch.params === undefined ? t.params : patch.params,
  };
  const r = await api('/api/agg/templates', { method: 'POST', body: { template: body } });
  const i = (S.aggTemplates || []).findIndex((x) => x.id === r.template.id);
  if (i >= 0) S.aggTemplates[i] = r.template;
  return r.template;
}

/* ------------------------------------------------------------------ ① 模板本身 + 域对照 */

function tplCard(t) {
  const sel = el('select', { title: '选一套模板来编辑' });
  for (const x of S.aggTemplates || []) {
    const o = el('option', { value: x.id, text: `${x.name}（${x.sites.length} 个站点）` });
    if (x.id === t.id) o.selected = true;
    sel.append(o);
  }
  sel.addEventListener('change', () => {
    S.tplId = sel.value;
    renderPage();
  });

  const name = el('input', { type: 'text', class: 'w-lg', value: t.name, maxlength: '40' });
  const saveName = el('button', { class: 'btn', text: '改名' });
  saveName.addEventListener('click', async () => {
    const v = name.value.trim();
    if (!v) return toast('名字不能空', true);
    saveName.disabled = true;
    try {
      await saveTemplate(t, { name: v });
      toast('已改名');
      renderNav();
      renderPage();
    } catch (e) {
      toast('改名失败：' + e.message, true);
      saveName.disabled = false;
    }
  });

  const del = el('button', { class: 'btn', text: '删除这套' });
  del.addEventListener('click', async () => {
    const used = Object.entries(S.aggDomains || {}).filter(([, id]) => id === t.id).map(([d]) => d);
    const tip =
      `删除模板「${t.name}」？` +
      (used.length ? `\n\n⚠️ 它还被这些域用着：${used.join(' / ')} —— 删掉之后它们会变成"没有配模板"（内容搜不到）。` : '');
    if (!confirm(tip)) return;
    try {
      const r = await api('/api/agg/templates/' + encodeURIComponent(t.id), { method: 'DELETE' });
      S.aggDomains = r.domains || {};
      S.tplId = '';
      await loadTemplates(true);
      toast('已删除');
      renderPage();
    } catch (e) {
      toast('删除失败：' + e.message, true);
    }
  });

  /* 域对照：每个已注册的域一行。**一个域最多一套**（选「（没配）」= 取消）。 */
  const domRows = (S.aggProviders || []).map((p) => {
    const cur = (S.aggDomains || {})[p.prefix] || '';
    const dsel = el('select', { title: `域 ${p.prefix} 用哪套模板` });
    dsel.append(el('option', { value: '', text: '（没配 —— 这个域的内容搜不到）', selected: !cur }));
    for (const x of S.aggTemplates || []) {
      const o = el('option', { value: x.id, text: x.name, selected: cur === x.id });
      dsel.append(o);
    }
    dsel.addEventListener('change', async () => {
      try {
        const r = await api('/api/agg/domains/' + encodeURIComponent(p.prefix), {
          method: 'POST',
          body: { templateId: dsel.value },
        });
        S.aggDomains = r.domains || {};
        toast(dsel.value ? `域 ${p.prefix} → ${(S.aggTemplates.find((x) => x.id === dsel.value) || {}).name}` : `域 ${p.prefix} 已取消指向`);
      } catch (e) {
        toast('设置失败：' + e.message, true);
      }
    });
    return el(
      'div',
      { class: 'kv' },
      el('span', { class: 'k', text: `${p.label}（域 ${p.prefix}）` }),
      dsel,
      el('span', { class: 'note', text: !cur ? '⚠️ 没配模板 ⇒ 这个域的内容搜不到（如实为空）' : '' })
    );
  });

  return el(
    'div',
    { class: 'card' },
    el('h3', { text: '模板' }),
    el('div', { class: 'row' }, el('span', { class: 'muted', text: '编辑哪一套：' }), sel, name, saveName, del, el('button', { class: 'btn primary', text: '新建一套', onclick: () => createTemplate() })),
    el('div', { class: 'note', text: '模板 = 一份配置数据文件：选中的站点 + 打分过滤参数 + 超时与并发。模板自己的 id 就是它的身份。' }),
    el('h3', { class: 'mt-md', text: '哪个域用这套' }),
    el('div', { class: 'note', text: '一个域最多一套模板（没配的域，内容搜不到）；同一套模板可以给多个域共用。' }),
    ...domRows
  );
}

/* ------------------------------------------------------------------ ② 这套模板的参数 */

function paramsCard(t) {
  const p = t.params || {};
  const num = (v, d) => (v === undefined || v === null || v === '' ? d : v);
  const to = el('input', { type: 'number', class: 'w-sm', value: String(num(p.timeoutSec, 5)), min: '1', max: '60' });
  const dto = el('input', { type: 'number', class: 'w-sm', value: String(num(p.detailTimeoutSec, 10)), min: '1', max: '120' });
  const cc = el('input', { type: 'number', class: 'w-sm', value: String(num(p.concurrency, 8)), min: '1', max: '32' });
  const minScore = el('input', { type: 'number', class: 'w-md', value: String(num(p.matchMinScore, 0.85)), min: '0', max: '1', step: '0.05' });
  const maxItems = el('input', { type: 'number', class: 'w-md', value: String(num(p.matchMaxItems, 8)), min: '1', max: '20' });
  const extraK = el('input', { type: 'number', class: 'w-md', value: String(num(p.matchExtraK, 0)), min: '0', max: '10' });
  const extraAllCb = el('input', { type: 'checkbox', checked: p.matchExtraAll === true });
  const lineFilter = el('input', {
    type: 'text',
    value: String(num(p.lineFilter, '')),
    placeholder: '正则，匹配线路名；留空 = 不过滤。例：夸克原画|百度原画',
    spellcheck: 'false',
  });
  const extraKLabel = el(
    'label',
    { class: 'chk', title: '前 N 条一条能用的都没拿到时，按分数继续往下打，最多再试这么多条；第一批拿到能用的就不再往下打。填 0 = 不补打' },
    extraK,
    '一条都没拿到时再往下打几条'
  );
  const syncExtra = () => extraKLabel.classList.toggle('hidden', extraAllCb.checked);
  extraAllCb.addEventListener('change', syncExtra);
  syncExtra();

  const save = el('button', { class: 'btn primary', text: '保存这套模板的参数' });
  save.addEventListener('click', async () => {
    const params = {
      timeoutSec: Number(to.value),
      detailTimeoutSec: Number(dto.value),
      concurrency: Number(cc.value),
      matchMinScore: Number(minScore.value),
      matchMaxItems: Number(maxItems.value),
      matchExtraK: Number(extraK.value),
      matchExtraAll: extraAllCb.checked,
      lineFilter: lineFilter.value.trim(),
    };
    if (!(params.timeoutSec >= 1 && params.timeoutSec <= 60)) return toast('单站超时填 1~60 秒', true);
    if (!(params.detailTimeoutSec >= 1 && params.detailTimeoutSec <= 120)) return toast('取详情超时填 1~120 秒', true);
    if (!(params.concurrency >= 1 && params.concurrency <= 32)) return toast('并发数填 1~32', true);
    if (!(params.matchMinScore >= 0 && params.matchMinScore <= 1)) return toast('分数线填 0~1（0 = 不过滤分数线）', true);
    if (!(params.matchMaxItems >= 1 && params.matchMaxItems <= 20)) return toast('最多留几条填 1~20', true);
    if (!(params.matchExtraK >= 0 && params.matchExtraK <= 10)) return toast('「一条都没拿到时再往下打几条」填 0~10（0 = 不补打）', true);
    save.disabled = true;
    try {
      await saveTemplate(t, { params });
      toast('参数已保存到「' + t.name + '」');
    } catch (e) {
      toast('保存失败：' + e.message, true);
    } finally {
      save.disabled = false;
    }
  });

  return el(
    'div',
    { class: 'card' },
    el(
      'details',
      {},
      el('summary', { text: `这套模板的参数（超时 / 并发 / 打分 / 线路过滤）· ${t.name}` }),
      el(
        'div',
        { class: 'row mt-sm' },
        el('label', { class: 'chk', title: '搜索 / 播放（以及首次 /init）的单站超时，单位秒。慢站设太小会被一律判成超时' }, to, '秒 单站超时'),
        el(
          'label',
          { class: 'chk', title: '取详情（POST /detail）的单站超时，单位秒。比搜索更宽 —— 剧集动辄几十上百集，响应体大、上游拼装慢' },
          dto,
          '秒 取详情超时'
        ),
        el('label', { class: 'chk' }, cc, '并发数'),
        el('label', { class: 'chk', title: '打分 ≥ 它的才算命中。填 0 = 不过滤分数线（只按分数排名取前 N 条）' }, minScore, '分数线'),
        el('label', { class: 'chk', title: '阶段一要取几条（有线路、且定位到你要的那一集）。每多取一条就多打一次站源 /detail' }, maxItems, '最多留几条命中'),
        extraKLabel,
        el('label', { class: 'chk', title: '不看"再往下打几条"，一直往下打到拿到一条能用的或名单打完（每个候选都要打一次站源 /detail，可能慢）' }, extraAllCb, '匹配到底'),
        el('label', { class: 'chk' }, el('span', { class: 'muted', text: '时间单位都是秒' })),
        save
      ),
      el('div', { class: 'row' }, lineFilter),
      el('div', {
        class: 'note',
        text:
          '「单站超时」= 搜索 / 播放 / 首次 `/init` 的单站上限；「取详情超时」= 取详情 `POST /detail` 的单站上限，单独一项、默认更宽。' +
          '打分口径：名字 0.7 · 季集 0.2 · 年份 0.1（缺的项不计），名字像不上的直接出局。' +
          '「能用的」= 有线路、且定位到你要的那一集；前 N 条一条能用的都没拿到时才按分数往下补打（最多再试 K 条）。' +
          '⚠️ 打分与过滤只在两层式站点上生效（一层式站点给词就直接回结果，不做筛选）。',
      })
    )
  );
}

/* ------------------------------------------------------------------ ③ 站点表 */

function sitesBlock(t) {
  const toolbar = el('div', { class: 'toolbar' });
  toolbar.append(
    el('button', { class: 'btn', text: '刷新站点', onclick: () => { S.aggLoadedFor = null; renderPage(); } }),
    (() => {
      const inp = el('input', { type: 'text', placeholder: '过滤站点名', value: S.siteFilter });
      inp.addEventListener('input', () => { S.siteFilter = inp.value; paintSites(curTpl()); });
      return inp;
    })(),
    (() => {
      const sel = el('select', { title: '按"你自己的勾选"筛，不看源申报的能力' });
      for (const [val, label] of [['all', '全部站点'], ['on', '只看已勾选'], ['off', '只看未勾选']]) {
        const o = el('option', { value: val, text: label });
        if ((S.siteView || 'all') === val) o.selected = true;
        sel.append(o);
      }
      sel.addEventListener('change', () => { S.siteView = sel.value; paintSites(curTpl()); });
      return el('label', { class: 'chk' }, sel, '');
    })(),
    el('span', { class: 'spacer' }),
    el('button', {
      class: 'btn',
      id: 'siteTestBtn',
      title: '对当前列出来的站点跑一轮测速（服务端执行：每站一发 /search，片名随机取、非 200 换一个再测一发）',
      text: '立即测速',
      onclick: () => startSpeedTest(),
    }),
    el('button', { class: 'btn mini hidden', id: 'siteTestStop', text: '停止测速', onclick: () => stopSpeedTest() }),
    el('span', { class: 'muted', id: 'siteTestMsg' }),
    (() => {
      let btn = null;
      btn = el('button', {
        class: 'btn',
        title: '只影响这张表的显示顺序（不改模板里的站点顺序）；失败与没测过的排在最后',
        text: sortLabel(),
        onclick: () => {
          S.siteSort = S.siteSort === 'fast' ? 'slow' : S.siteSort === 'slow' ? '' : 'fast';
          btn.textContent = sortLabel();
          paintSites(curTpl());
        },
      });
      return btn;
    })(),
    el('button', { class: 'btn', text: '清空这套的站点', onclick: () => clearSelection(t) }),
    el('span', { class: 'muted', id: 'aggCount' })
  );
  return el('div', { class: 'card' }, el('h3', { text: '站点' }), toolbar, el('div', { id: 'siteTableHost' }), el('div', { id: 'siteAreaHost' }));
}

/** 重绘站点表（勾选一下不必整页重刷）。`t` = 当前模板。 */
function paintSites(t) {
  const host = $('#siteTableHost');
  if (!host) return;
  if (!t) return;
  if (!(S.aggSources || []).length) {
    host.textContent = '';
    host.append(el('div', { class: 'hint warn' }, '还没有源 —— 到「插件 → 管理」找到源插件（猫爪源），在它自己的设置页里加一个实例。'));
    return;
  }
  if (!(S.aggSites || []).length) {
    const bad = (S.aggSources || []).filter((s) => s.enabled !== false && !s.ok);
    host.textContent = '';
    host.append(el('div', { class: 'hint warn', text: '这些源都取不到站点：' + (bad.map((s) => `${s.id} ${s.error || '未知错误'}`).join('；') || '未知原因') }));
    return;
  }
  const chosen = (t.sites || []).map((x) => ({ source: x.source, key: x.key }));
  const chosenSet = new Set(chosen.map((x) => sid(x.source, x.key)));
  const list = sortSites((S.aggSites || []).filter((s) => siteVisible(s, chosenSet)));
  const srcN = new Set((S.aggSites || []).map((s) => s.source)).size;
  const timeoutMs = (Number((t.params || {}).timeoutSec) || 0) * 1000;
  const cnt = $('#aggCount');
  if (cnt) cnt.textContent = `这套勾了 ${chosenSet.size} / ${(S.aggSites || []).length} 站点 · ${srcN} 个源`;

  host.textContent = '';
  const table = el('table', { class: 'sites-table' });
  table.append(
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        el('th', { text: '这套模板' }),
        el('th', { text: '来源' }),
        el('th', { text: '名称' }),
        el('th', { title: '测速结果：一发 POST /search 的往返耗时。悬停可看用的片名与真实业务的耗时', text: '延迟' }),
        el('th', { title: '还有哪几套模板用了这个站点', text: '别的模板' }),
        el('th', { title: '源自己申报的字段，仅供参考（常漏报）', text: '能力' })
      )
    )
  );
  const tb = el('tbody');
  for (const s of list) {
    const cb = el('input', { type: 'checkbox', checked: chosenSet.has(sid(s.source, s.key)), class: 'switch' });
    cb.addEventListener('change', () => {
      /* 站点身份 = (源, 站点 key)：多源下同名 key 是两条不同的站点 */
      const next = chosen.filter((x) => !(x.source === s.source && x.key === s.key));
      if (cb.checked) next.push({ source: s.source, key: s.key });
      saveSites(curTpl(), next);
    });
    const others = (s.templates || []).filter((x) => x.id !== t.id).map((x) => x.name);
    tb.append(
      el(
        'tr',
        {},
        el('td', {}, cb),
        el('td', { class: 'note', text: s.sourceName || s.source }),
        el('td', { text: s.name || '-' }),
        delayCell(s, timeoutMs),
        el('td', { class: 'note', text: others.length ? others.join(' / ') : '—' }),
        el(
          'td',
          {},
          s.searchable ? el('span', { class: 'badge ok', title: '源申报它能搜（没标的也可能能搜）', text: '搜索' }) : null,
          s.filterable ? el('span', { class: 'badge', title: '源申报它支持二级筛选', text: '筛选' }) : null,
          s.indexs ? el('span', { class: 'badge', title: '源申报它是"点进条目后转去搜索"那种（豆瓣类）', text: '跳搜索' }) : null,
          el('span', { class: 'badge', title: '这条站点属于哪个大类（源申报）', text: s.groupLabel || s.group })
        )
      )
    );
  }
  table.append(tb);
  host.append(el('div', { class: 'table-wrap' }, table));
  host.append(
    el('div', {
      class: 'note',
      text:
        '勾选即存回当前这套模板。「延迟」= 服务端测速（每站一发 `POST /search`，片名随机取、非 200 换一个再测一发，单站 15 秒超时）；' +
        '测速的开关与间隔在「面板设置」，测速结果是面板共享的一份、不跟模板走。标红 = 测速失败，或比这套模板的单站超时还慢。' +
        '「能力」列是源自己申报的，仅供参考（源常漏报）。',
    })
  );
  void initSpeedTestUi();
}

async function saveSites(t, sites) {
  try {
    const r = await saveTemplate(t, { sites });
    S.aggTemplates = (S.aggTemplates || []).map((x) => (x.id === r.id ? r : x));
    /* 站点表要重画：计数、以及"别的模板"那一列的归属可能变了 */
    paintSites(r);
    renderNav();
  } catch (e) {
    toast(e.message, true);
  }
}

async function clearSelection(t) {
  if (!confirm(`把「${t.name}」这套模板里的站点全部取消勾选？`)) return;
  await saveSites(t, []);
  toast('已清空这套模板的站点');
}

/* ------------------------------------------------------------------ 站点表的小工具 */

function siteVisible(s, chosenSet) {
  if (S.siteView === 'on' && !chosenSet.has(sid(s.source, s.key))) return false;
  if (S.siteView === 'off' && chosenSet.has(sid(s.source, s.key))) return false;
  const f = String(S.siteFilter || '').trim().toLowerCase();
  if (f && !(String(s.name || '').toLowerCase().includes(f) || String(s.key || '').toLowerCase().includes(f))) return false;
  return true;
}

const fmtMs = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms) + 'ms');

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function sortLabel() {
  if (S.siteSort === 'fast') return '延迟 · 快→慢';
  if (S.siteSort === 'slow') return '延迟 · 慢→快';
  return '按延迟排序';
}

function sortKey(s) {
  const one = (s.stat || {}).probe || null;
  return one && one.ok ? one.ms : Infinity;
}

function sortSites(list) {
  if (!S.siteSort) return list;
  const dir = S.siteSort === 'slow' ? -1 : 1;
  return list.slice().sort((a, b) => dir * (sortKey(a) - sortKey(b)));
}

/** 「延迟」列：服务端测速结果 + 单点复测按钮（复测成功即恢复"不再被跳过"） */
function delayCell(s, timeoutMs) {
  const stat = s.stat || {};
  const one = stat.probe || null;
  const call = stat.call || {};
  const callNote = [
    call.search ? `真实搜索：最近一次 ${fmtMs(call.search.ms)}${call.search.ok ? '' : '（失败：' + call.search.error + '）'}` : '真实搜索：还没搜过',
    call.detail ? `真实取详情：最近一次 ${fmtMs(call.detail.ms)}${call.detail.ok ? '' : '（失败：' + call.detail.error + '）'}` : '真实取详情：还没点开过',
  ].join('\n');

  const btn = el('button', {
    class: 'btn mini ml-sm',
    text: '测速',
    title: '只测这一个站：服务端打一发 /search（片名随机取、非 200 换一个再测），结果直接写进这一列',
    onclick: async (e) => {
      const b = e.target;
      b.disabled = true;
      b.textContent = '…';
      try {
        /* 单站测速：只要「实例 + 站点 key」—— 接口前缀由插件自己知道（面板不再拼路径） */
        const r = await api('/api/agg/site-test/one', { method: 'POST', body: { source: s.source, key: s.key } });
        if (td.isConnected) td.replaceWith(delayCell(Object.assign({}, s, { stat: r.stat }), timeoutMs));
        toast(`${s.name || s.key}：${r.search.ok ? fmtMs(r.search.ms) + ` · ${r.search.count} 条` : r.search.error || '失败'}`);
      } catch (err) {
        toast((err && err.message) || '单站测速失败', true);
        b.disabled = false;
        b.textContent = '测速';
      }
    },
  });

  let td;
  if (!one) {
    td = el('td', { class: 'note', title: `还没测过 —— 点右边的「测速」，或用上面的「立即测速」整轮刷新。\n${callNote}` }, '—', btn);
  } else if (!one.ok) {
    const why = one.routeMissing
      ? '这个源里该站没有 /search 端点（文案是 Route POST:… not found，不是站坏了）'
      : one.timeout
        ? `超过测速超时（${fmtMs(one.ms)}）`
        : one.error || '请求失败';
    td = el(
      'td',
      {
        class: 'note err-note',
        title: `测速失败：${why}\n用的片名「${one.wd}」${one.tries > 1 ? `（第 ${one.tries} 发，首发失败后换过词）` : ''}\n聚合搜索会先跳过这一列失败的站 —— 点「测速」复测成功即恢复。\n${callNote}`,
      },
      one.status ? 'HTTP ' + one.status : '失败',
      btn
    );
  } else {
    const slow = timeoutMs > 0 && one.ms >= timeoutMs;
    td = el(
      'td',
      {
        class: slow ? 'note err-note' : 'mono',
        title:
          `测速：${fmtMs(one.ms)}（单发 /search，片名「${one.wd}」${one.tries > 1 ? `，第 ${one.tries} 发（首发失败换过词）` : ''}）\n` +
          `返回 ${one.count} 条${one.count === 0 ? '（这个词这站没有 —— 仍是有效样本）' : ''}\n测速时间：${fmtTime(one.at)}\n` +
          (slow ? `⚠️ 比这套模板的单站超时（${fmtMs(timeoutMs)}）还慢 —— 聚合里会被判超时\n` : '') +
          callNote,
      },
      fmtMs(one.ms),
      btn
    );
  }
  return td;
}

/* ------------------------------------------------------------------ 测速（服务端任务，页内 UI） */

let pollTimer = null;
let wasRunning = false;

function paintTestMsg(st) {
  const msg = $('#siteTestMsg');
  if (!msg || !st) return;
  if (st.running) {
    msg.textContent = `测速中… ${st.done}/${st.total}` + (st.badCount ? `（${st.badCount} 个失败）` : '');
    return;
  }
  const parts = st.lastRunAt
    ? [`上次测速 ${fmtTime(st.lastRunAt)}：${st.done}/${st.total} 个站 · ${Math.round((st.lastElapsedMs || 0) / 1000)}s` + (st.lastBad ? ` · ${st.lastBad} 个失败` : '')]
    : ['还没测过'];
  parts.push(st.enabled ? `下次自动 ${fmtTime(st.nextRunAt)}（每 ${st.hours} 小时）` : '自动测速已关（「面板设置」可开）');
  msg.textContent = parts.join(' · ');
}

async function refreshTestState() {
  try {
    const st = await api('/api/agg/site-test');
    paintTestMsg(st);
    return st;
  } catch {
    return null;
  }
}

function setTestBtns(running) {
  const btn = $('#siteTestBtn');
  const stopBtn = $('#siteTestStop');
  if (btn) {
    btn.disabled = !!running;
    btn.textContent = running ? '测速中…' : '立即测速';
  }
  if (stopBtn) stopBtn.classList.toggle('hidden', !running);
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    if (!$('#siteTestMsg')) {
      clearInterval(pollTimer);
      pollTimer = null;
      return;
    }
    const st = await refreshTestState();
    if (!st) return;
    setTestBtns(st.running);
    if (st.running) {
      wasRunning = true;
      return;
    }
    if (!wasRunning) return;
    wasRunning = false;
    try {
      await ensureAggSites({ force: true });
    } catch {
      /* 拉不到就按内存里那份画 */
    }
    paintSites(curTpl());
    toast('测速完成');
    clearInterval(pollTimer);
    pollTimer = null;
  }, 1500);
}

async function initSpeedTestUi() {
  const st = await refreshTestState();
  if (!st || !$('#siteTestMsg')) return;
  setTestBtns(st.running);
  wasRunning = st.running;
  if (st.running) startPolling();
}

async function startSpeedTest() {
  const t = curTpl();
  if (!t) return;
  const chosenSet = new Set((t.sites || []).map((x) => sid(x.source, x.key)));
  const list = (S.aggSites || []).filter((s) => siteVisible(s, chosenSet));
  if (!list.length) return toast('没有可测的站点（先调好筛选或视图）', true);
  if (
    !confirm(
      `对当前列出来的 ${list.length} 个站点跑一轮测速？\n\n` +
        '测速在服务端跑（关掉页面也会继续）：每站一发 /search，片名从常见影视名里随机取、' +
        '非 200 换一个再测一发，单站最多 15 秒。随时可以点「停止测速」。'
    )
  ) {
    return;
  }
  try {
    const r = await api('/api/agg/site-test/start', {
      method: 'POST',
      body: { keys: list.map((s) => ({ source: s.source, key: s.key })) },
    });
    paintTestMsg(r);
    setTestBtns(!!r.running);
    wasRunning = !!r.running;
    startPolling();
  } catch (e) {
    toast(e.message || '启动测速失败', true);
    refreshTestState();
  }
}

async function stopSpeedTest() {
  try {
    paintTestMsg(await api('/api/agg/site-test/stop', { method: 'POST' }));
  } catch (e) {
    toast(e.message || '停止测速失败', true);
  }
}
