'use strict';
/**
 * 聚合模块 · 「模板」页 —— **只管模板的增 / 删 / 改**。
 *
 * 一份模板 = 名字 + 选中的站点 + 打分过滤参数 + 超时与并发（见 docs/adr/0033）。
 * 左边挑一套（或新建 / 删除），右边编辑这一套，改完按**一个**「保存」整份写回
 * （`POST /api/agg/templates`）。「哪个域用哪套模板」不在这里 —— 见「聚合设置 → 其他设置」。
 * 「保存」跟在左边那张卡的「新建 / 删除」后面 —— 三者都是"对模板集本身"的动作，归一处；
 * 草稿动过时按钮下面亮一个「未保存」，换模板前先拦一句。
 * 页面里的问一句（新建 / 删除 / 切模板 / 全不选 / 测速）一律走 `modal()` —— 原生 `confirm`
 * 在窄屏上被浏览器画成一条窄横条，字挤成一团、按钮还点不准。
 *
 * ⚠️ 勾选、改名、参数都只活在**这一个模块的草稿**（`draft`）里：不写全局状态、不落服务端，
 * 点「保存」才整份提交；换模板或保存成功时草稿作废，按服务端那一份重画。
 *
 * 站点表按**来源**（`s.source` = 插件 id / 实例 id）分组：多实例下站点 key 只在各自实例内唯一，
 * 上百条堆成一张扁平表既对不上号，也看不出哪个实例勾了多少。来源做成**横向页签**、一次只开一个 ——
 * 两三个来源的表上下堆着，页面会被拉得很长。组头带「整组全选 / 整组反选」。
 *
 * ⚠️ **测速的开关与间隔不在这里**（已搬到「面板设置」）—— 测速是"这台机器与这条网络"的体检，
 * 与内容偏好无关，而测速的**结果**是面板级共享的一份、不跟模板走。本站点表里的「延迟」列
 * 与「立即测速」按钮仍在（那是"看结果"和"手点一轮"）。
 */
import { $, el, modal, toast } from '../../core/dom.js';
import { api } from '../../core/api.js';
import { S } from '../../core/state.js';
import { sid, ensureAggSites, ensureTemplates } from '../../core/store.js';
import { renderPage } from '../../core/shell.js';

/* ------------------------------------------------------------------ 草稿 */

/** 正在编辑的那一份：`{id, name, sites:[{source,key}], params}`。null = 还没建草稿 */
let draft = null;
/** 草稿动过没有 —— 换模板前拿它拦一下，免得勾了半天被切走 */
let dirty = false;

/** 从服务端那一份抄出草稿（站点数组要深拷，免得改草稿顺手改了全局状态里那份） */
function draftOf(t) {
  return {
    id: t.id,
    name: t.name || '',
    sites: (t.sites || []).map((x) => ({ source: x.source, key: x.key })),
    params: Object.assign({}, t.params || {}),
  };
}

function curTpl() {
  const list = S.aggTemplates || [];
  return list.find((t) => t.id === S.tplId) || list[0] || null;
}

/** 切模板 / 存成功之后：草稿作废，下次渲染按服务端那一份重建 */
function resetDraft() {
  draft = null;
  dirty = false;
}

/** 草稿动过没有：改草稿的地方都走它，顶部操作条上那颗「未保存」跟着亮 */
function setDirty(on) {
  dirty = on;
  const chip = $('#tplDirty');
  if (chip) chip.classList.toggle('hidden', !dirty);
}

/** 页内确认框（替代原生 `confirm`）：resolve(true) = 用户点了确认那颗按钮。
 *  ✕ / Esc / 点遮罩关掉一律算"取消" —— 靠 modal 的 onClose 兜住。 */
function confirmModal({ title, text, okLabel = '确定', primary = true }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    modal({
      title,
      body: [el('p', { class: 'note', text })],
      actions: [
        { label: '取消', onclick: () => finish(false) },
        { label: okLabel, primary, onclick: () => finish(true) },
      ],
      onClose: () => finish(false),
    });
  });
}

/* ------------------------------------------------------------------ 页面 */

export async function renderTemplates(v) {
  await loadTemplates();

  if (!(S.aggTemplates || []).length) {
    v.append(emptyCard());
    return;
  }

  const t = curTpl();
  if (!draft || draft.id !== t.id) {
    draft = draftOf(t);
    dirty = false;
  }

  const ed = editor(t);
  v.append(el('div', { class: 'tpl-layout' }, tplList(t, ed.save), ed.node));

  /* 站点清单归源插件：它要挨个问自己那些实例的 `/config`（连不上的要等超时），先画别的卡片。 */
  paintSites();
  if (S.aggLoadedFor) return;
  try {
    await ensureAggSites();
  } catch (e) {
    toast('读取站点失败：' + e.message, true);
    return;
  }
  paintSites();
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

function emptyCard() {
  return el(
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
  );
}

/* ------------------------------------------------------------------ ① 左边：挑一套 / 新建 / 删除 */

function tplList(t, save) {
  const list = el('div', { class: 'tpl-list' });
  for (const x of S.aggTemplates || []) {
    list.append(
      el(
        'button',
        { class: 'tpl-item' + (x.id === t.id ? ' active' : ''), title: x.name, onclick: () => selectTemplate(x.id) },
        el('span', { class: 'tpl-name', text: x.name }),
        el('span', { class: 'tpl-meta', text: `${(x.sites || []).length} 站` })
      )
    );
  }
  return el(
    'div',
    { class: 'card' },
    el('h3', { text: '模板' }),
    list,
    /* 「保存」跟新建 / 删除挤在一行里（三者都是"对模板集本身"的动作，归一处看着顺） */
    el(
      'div',
      { class: 'row' },
      el('button', { class: 'btn', text: '新建', onclick: () => createTemplate() }),
      el('button', { class: 'btn', text: '删除', onclick: () => removeTemplate(t) }),
      save
    ),
    el('span', { class: 'dirty-chip' + (dirty ? '' : ' hidden'), id: 'tplDirty', text: '未保存' })
  );
}

/** 换一套编辑：草稿动过就先问一句（勾了半天被一句话切走最亏） */
async function selectTemplate(id) {
  if (draft && draft.id === id) return;
  if (dirty) {
    const go = await confirmModal({
      title: '切换模板',
      text: '这一套还没保存，切过去就不保留了。继续？',
      okLabel: '切过去',
    });
    if (!go) return;
  }
  S.tplId = id;
  resetDraft();
  renderPage();
}

function createTemplate() {
  const name = el('input', { type: 'text', value: '新模板', maxlength: '40', placeholder: '这套模板叫什么' });
  modal({
    title: '新建模板',
    body: [
      el('div', { class: 'field' }, el('label', { text: '名字（例如「影视」「动漫」）' }), name),
      el('p', { class: 'note', text: '新模板先是空的 —— 建好之后在下面的站点表里挑站点，再点顶部的「保存这套模板」。' }),
    ],
    actions: [
      { label: '取消' },
      {
        label: '新建',
        primary: true,
        onclick: async () => {
          const nm = name.value.trim();
          if (!nm) {
            toast('名字不能空', true);
            return false;
          }
          try {
            const r = await api('/api/agg/templates', { method: 'POST', body: { template: { name: nm, sites: [] } } });
            S.tplId = r.template.id;
            resetDraft();
            await loadTemplates(true);
            toast('已新建模板：' + r.template.name);
            renderPage();
          } catch (e) {
            toast('新建失败：' + e.message, true);
            return false;
          }
        },
      },
    ],
  });
}

async function removeTemplate(t) {
  const used = Object.entries(S.aggDomains || {}).filter(([, id]) => id === t.id).map(([d]) => d);
  const tip =
    `删除模板「${t.name}」？` +
    (used.length ? `；它还被这些域用着：${used.join(' / ')} —— 删掉之后它们会变成"没有配模板"（内容搜不到）。` : '');
  const go = await confirmModal({ title: '删除模板', text: tip, okLabel: '删除', primary: false });
  if (!go) return;
  try {
    const r = await api('/api/agg/templates/' + encodeURIComponent(t.id), { method: 'DELETE' });
    S.aggDomains = r.domains || {};
    S.tplId = '';
    resetDraft();
    await loadTemplates(true);
    toast('已删除');
    renderPage();
  } catch (e) {
    toast('删除失败：' + e.message, true);
  }
}

/* ------------------------------------------------------------------ ② 右边：编辑这一套 */

/** 名称 / 参数 / 站点在**同一份草稿**里，改完按一个「保存」整份写回。
 *  返回 `{ save, node }`：`save` 那颗按钮归左边那张卡（跟新建 / 删除排一起），`node` 是编辑器本体。 */
function editor(t) {
  const mark = () => setDirty(true);

  const name = el('input', { type: 'text', class: 'w-lg', value: draft.name, maxlength: '40', placeholder: '这套模板叫什么' });
  name.addEventListener('input', mark);

  /* 参数是"偶尔调一次"的旋钮，但**不折叠** —— 它和名称、站点同属"这一套模板"，一屏看完比点开找强。 */
  const p = draft.params || {};
  const num = (v, d) => (v === undefined || v === null || v === '' ? d : v);
  const to = el('input', { type: 'number', class: 'w-sm', value: String(num(p.timeoutSec, 5)), min: '1', max: '60' });
  const dto = el('input', { type: 'number', class: 'w-sm', value: String(num(p.detailTimeoutSec, 10)), min: '1', max: '120' });
  const pto = el('input', { type: 'number', class: 'w-sm', value: String(num(p.playTimeoutSec, 25)), min: '1', max: '120' });
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
  for (const x of [to, dto, pto, cc, minScore, maxItems, extraK, lineFilter]) x.addEventListener('input', mark);
  /* 站点取数：最近一次测速失败的站要不要先跳过（口径见 server/modules/agg/templates.js 的 skipFailedSites）。
   * 默认勾着 —— 与原来一直就有的行为一致；取消勾选就照打，用来确认那几个站现在到底行不行。 */
  const skipFailedCb = el('input', { type: 'checkbox', checked: p.skipFailedSites !== false });
  skipFailedCb.addEventListener('change', mark);
  const extraKLabel = el(
    'label',
    { class: 'chk', title: '前 N 条一条能用的都没拿到时，按分数继续往下打，最多再试这么多条；第一批拿到能用的就不再往下打。填 0 = 不补打' },
    extraK,
    '一条都没拿到时再往下打几条'
  );
  const syncExtra = () => extraKLabel.classList.toggle('hidden', extraAllCb.checked);
  extraAllCb.addEventListener('change', () => {
    mark();
    syncExtra();
  });
  syncExtra();

  const save = el('button', { class: 'btn primary', text: '保存这套模板' });
  save.addEventListener('click', async () => {
    const nm = name.value.trim();
    if (!nm) return toast('名字不能空', true);
    const params = {
      timeoutSec: Number(to.value),
      detailTimeoutSec: Number(dto.value),
      playTimeoutSec: Number(pto.value),
      concurrency: Number(cc.value),
      matchMinScore: Number(minScore.value),
      matchMaxItems: Number(maxItems.value),
      matchExtraK: Number(extraK.value),
      matchExtraAll: extraAllCb.checked,
      lineFilter: lineFilter.value.trim(),
      skipFailedSites: skipFailedCb.checked,
    };
    const bad = paramsError(params);
    if (bad) return toast(bad, true);
    save.disabled = true;
    try {
      const r = await api('/api/agg/templates', {
        method: 'POST',
        body: { template: { id: t.id, name: nm, sites: draft.sites, params } },
      });
      const i = (S.aggTemplates || []).findIndex((x) => x.id === r.template.id);
      if (i >= 0) S.aggTemplates[i] = r.template;
      resetDraft();
      toast(`已保存「${r.template.name}」：名称 / 参数 / 站点一起写回`);
      renderPage();
    } catch (e) {
      toast('保存失败：' + e.message, true);
      save.disabled = false;
    }
  });

  /* 参数是"偶尔调一次"的旋钮，但**不折叠** —— 它和名称、站点同属"这一套模板"，一屏看完比点开找强。
   * 分三小块排：八颗控件原来挤在同一行里，宽屏还能看，窄屏一折行就成了一大片没有归属感的数字。 */
  const group = (title, row) => el('div', { class: 'param-block' }, el('div', { class: 'param-title', text: title }), el('div', { class: 'row' }, row));

  return {
    save,
    node: el(
      'div',
      { class: 'grid' },
      el(
        'div',
        { class: 'card' },
        el('h3', { text: `编辑「${t.name}」` }),
        el('div', { class: 'row' }, el('span', { class: 'muted', text: '名称' }), name),
        group('超时与并发（单位都是秒）', [
          el('label', { class: 'chk', title: '搜索（以及首次 /init）的单站超时。慢站设太小会被一律判成超时' }, to, '单站超时'),
          el(
            'label',
            { class: 'chk', title: '取详情（POST /detail）的单站超时。比搜索更宽 —— 剧集动辄几十上百集，响应体大、上游拼装慢' },
            dto,
            '取详情超时'
          ),
          el(
            'label',
            {
              class: 'chk',
              title:
                '取播放地址（POST /play）的单站超时。要比搜索宽得多 —— 网盘类线路（PikPak 那种）' +
                '取一个地址要串行打登录、查已保存、提交离线下载、等完成、取直链好几发，' +
                '跟搜索共用一档会被一律判成超时（客户端拿到 502 就重试，越重试越慢）',
            },
            pto,
            '播放超时'
          ),
          el('label', { class: 'chk' }, cc, '并发数'),
        ]),
        group('打分与取条数', [
          el('label', { class: 'chk', title: '打分 ≥ 它的才算命中。填 0 = 不过滤分数线（只按分数排名取前 N 条）' }, minScore, '分数线'),
          el('label', { class: 'chk', title: '阶段一要取几条（有线路、且定位到你要的那一集）。每多取一条就多打一次站源 /detail' }, maxItems, '最多留几条命中'),
          extraKLabel,
          el('label', { class: 'chk', title: '不看"再往下打几条"，一直往下打到拿到一条能用的或名单打完（每个候选都要打一次站源 /detail，可能慢）' }, extraAllCb, '匹配到底'),
        ]),
        group('线路过滤', [lineFilter]),
        group('站点取数', [
          el(
            'label',
            {
              class: 'chk',
              title:
                '勾上：最近一次测速失败的站点在聚合搜索时先跳过（模板里的勾选不动，下一轮测速成功就自动恢复）。' +
                '取消勾选：照打 —— 用来确认"那几个站现在到底行不行"',
            },
            skipFailedCb,
            '跳过测速失败的站点'
          ),
        ]),
        el('div', {
          class: 'note',
          text:
            '「单站超时」= 搜索 / 首次 `/init` 的单站上限；「取详情超时」= 取详情 `POST /detail` 的单站上限；' +
            '「播放超时」= 取播放地址 `POST /play` 的单站上限（网盘类线路要串行打好几发，所以默认更宽）。' +
            '打分口径：名字 0.7 · 季集 0.2 · 年份 0.1（缺的项不计），名字像不上的直接出局。' +
            '「能用的」= 有线路、且定位到你要的那一集；前 N 条一条能用的都没拿到时才按分数往下补打（最多再试 K 条）。' +
            '「跳过测速失败的站点」勾着时，那几个站这一步不打（勾选不变，测速成功即恢复）。' +
            '⚠️ 打分与过滤只在两层式站点上生效（一层式站点给词就直接回结果，不做筛选）。',
        })
      ),
      sitesCard()
    ),
  };
}

/** 参数范围校验：返回错误文案；没问题回空串 */
function paramsError(p) {
  if (!(p.timeoutSec >= 1 && p.timeoutSec <= 60)) return '单站超时填 1~60 秒';
  if (!(p.detailTimeoutSec >= 1 && p.detailTimeoutSec <= 120)) return '取详情超时填 1~120 秒';
  if (!(p.playTimeoutSec >= 1 && p.playTimeoutSec <= 120)) return '播放超时填 1~120 秒';
  if (!(p.concurrency >= 1 && p.concurrency <= 32)) return '并发数填 1~32';
  if (!(p.matchMinScore >= 0 && p.matchMinScore <= 1)) return '分数线填 0~1（0 = 不过滤分数线）';
  if (!(p.matchMaxItems >= 1 && p.matchMaxItems <= 20)) return '最多留几条填 1~20';
  if (!(p.matchExtraK >= 0 && p.matchExtraK <= 10)) return '「一条都没拿到时再往下打几条」填 0~10（0 = 不补打）';
  return '';
}

/* ------------------------------------------------------------------ ③ 站点：按来源分组 */

function sitesCard() {
  const toolbar = el('div', { class: 'toolbar' });
  toolbar.append(
    el('button', { class: 'btn', text: '刷新站点', onclick: () => { S.aggLoadedFor = null; renderPage(); } }),
    (() => {
      const inp = el('input', { type: 'text', placeholder: '过滤站点名', value: S.siteFilter });
      inp.addEventListener('input', () => { S.siteFilter = inp.value; paintSites(); });
      return inp;
    })(),
    (() => {
      const sel = el('select', { title: '按"你自己的勾选"筛，不看源申报的能力' });
      for (const [val, label] of [['all', '全部站点'], ['on', '只看已勾选'], ['off', '只看未勾选']]) {
        const o = el('option', { value: val, text: label });
        if ((S.siteView || 'all') === val) o.selected = true;
        sel.append(o);
      }
      sel.addEventListener('change', () => { S.siteView = sel.value; paintSites(); });
      return el('label', { class: 'chk' }, sel, '');
    })(),
    el('span', { class: 'spacer' }),
    el('span', { class: 'muted', id: 'aggCount' }),
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
          paintSites();
        },
      });
      return btn;
    })(),
    el('button', { class: 'btn', text: '全部不选', onclick: () => clearAll() })
  );
  return el('div', { class: 'card' }, el('h3', { text: '站点' }), toolbar, el('div', { id: 'siteTableHost' }));
}

/** 重画站点表（勾一下就地重画，不必整页重刷）。勾选来自草稿，草稿来自服务端那一份。 */
function paintSites() {
  const host = $('#siteTableHost');
  if (!host || !draft) return;
  host.textContent = '';

  if (!S.aggLoadedFor) {
    host.append(el('div', { class: 'hint', text: '正在取站点清单…（连不上的实例要等超时；模板与参数可以先改）' }));
    return;
  }
  if (!(S.aggSources || []).length) {
    host.append(el('div', { class: 'hint warn' }, '还没有源 —— 到「插件 → 管理」找到源插件（猫爪源），在它自己的设置页里加一个实例。'));
    return;
  }
  if (!(S.aggSites || []).length) {
    const bad = (S.aggSources || []).filter((s) => s.enabled !== false && !s.ok);
    host.append(el('div', { class: 'hint warn', text: '这些源都取不到站点：' + (bad.map((s) => `${s.id} ${s.error || '未知错误'}`).join('；') || '未知原因') }));
    return;
  }

  const chosenSet = new Set(draft.sites.map((x) => sid(x.source, x.key)));
  const list = sortSites((S.aggSites || []).filter((s) => siteVisible(s, chosenSet)));
  const srcN = new Set((S.aggSites || []).map((s) => s.source)).size;
  const cnt = $('#aggCount');
  if (cnt) cnt.textContent = `这套勾了 ${chosenSet.size} / ${(S.aggSites || []).length} 站点 · ${srcN} 个源`;

  if (!list.length) {
    host.append(el('div', { class: 'hint', text: '当前筛选下没有站点。' }));
    return;
  }

  /* 归组：按源清单里的出现顺序（Map 保序） */
  const groups = new Map();
  for (const s of list) {
    if (!groups.has(s.source)) groups.set(s.source, []);
    groups.get(s.source).push(s);
  }
  /* 来源做成**横向页签**、一次只开一个：两三个来源、上百条站点上下堆成好几张长表，
   * 页面会被拉得很长，而一组一组的表本来也是分开勾的。 */
  S.siteGroup = pickGroup(groups, chosenSet);
  if (groups.size > 1) host.append(srcTabs(groups, chosenSet));
  host.append(srcGroup(S.siteGroup, groups.get(S.siteGroup), chosenSet));

  host.append(
    el('div', {
      class: 'note',
      text:
        '站点按**来源**（源插件的实例）分成页签，一次只开一个来源。勾选只记在这一页的草稿里 —— 点顶部的「保存这套模板」才写回。' +
        '「延迟」= 服务端测速（每站一发 `POST /search`，片名随机取、非 200 换一个再测一发，单站 15 秒超时）；' +
        '测速的开关与间隔在「面板设置」，测速结果是面板共享的一份、不跟模板走。标红 = 测速失败，或比这套模板的单站超时还慢。' +
        '（这套模板勾了「跳过测速失败的站点」时，标红的站在聚合搜索里会被先跳过。）' +
        '「能力」列是源自己申报的，仅供参考（源常漏报）。',
    })
  );
  void initSpeedTestUi();
}

/** 页签默认落在**这套模板勾了站点的那个来源**上（一个都没勾过就落在第一个）；
 *  当前那个在筛选下没有站点时也退回 —— 免得点开一个空页签。 */
function pickGroup(groups, chosenSet) {
  if (S.siteGroup && groups.has(S.siteGroup)) return S.siteGroup;
  for (const [src, sites] of groups) {
    if (sites.some((s) => chosenSet.has(sid(s.source, s.key)))) return src;
  }
  return [...groups.keys()][0];
}

/** 来源页签：一个来源一颗，页签上带"这一组勾了几个 / 当前列出来几个" */
function srcTabs(groups, chosenSet) {
  const bar = el('div', { class: 'src-tabs' });
  for (const [src, sites] of groups) {
    const on = sites.filter((s) => chosenSet.has(sid(s.source, s.key))).length;
    const name = `${sites[0].sourceName || src}（${src}）`;
    const tab = el('button', {
      class: 'src-tab' + (src === S.siteGroup ? ' active' : ''),
      title: `${name}：这一组 ${on}/${sites.length} 已勾选`,
      onclick: () => {
        S.siteGroup = src;
        paintSites();
      },
    });
    tab.append(el('span', { text: name }), el('span', { class: 'src-tab-meta', text: `${on}/${sites.length}` }));
    bar.append(tab);
  }
  return bar;
}

/** 一组 = 一个来源（一个源插件实例）的站点：组头 + 一张表 */
function srcGroup(src, sites, chosenSet) {
  const on = sites.filter((s) => chosenSet.has(sid(s.source, s.key))).length;
  const head = el(
    'div',
    { class: 'src-head' },
    el('b', { text: `${sites[0].sourceName || src}（${src}）` }),
    el('span', { class: 'muted', text: `这一组 ${on}/${sites.length} 已勾选` }),
    el('span', { class: 'spacer' }),
    el('button', { class: 'btn mini', title: '把这一组**当前列出来的**站点全部勾上', text: '整组全选', onclick: () => bulk(sites, 'on') }),
    el('button', {
      class: 'btn mini',
      title: '把这一组**当前列出来的**站点整组翻转：勾上的取消、没勾的勾上',
      text: '整组反选',
      onclick: () => bulk(sites, 'invert'),
    })
  );

  const timeoutMs = (Number((draft.params || {}).timeoutSec) || 0) * 1000;
  const table = el('table', { class: 'sites-table' });
  table.append(
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        el('th', { text: '这套模板' }),
        el('th', { text: '名称' }),
        el('th', { title: '测速结果：一发 POST /search 的往返耗时。悬停可看用的片名与真实业务的耗时', text: '延迟' }),
        el('th', { title: '还有哪几套模板用了这个站点', text: '别的模板' }),
        el('th', { title: '源自己申报的字段，仅供参考（常漏报）', text: '能力' })
      )
    )
  );
  const tb = el('tbody');
  for (const s of sites) {
    const cb = el('input', { type: 'checkbox', checked: chosenSet.has(sid(s.source, s.key)), class: 'switch' });
    cb.addEventListener('change', () => {
      setChosen(s, cb.checked);
      paintSites();
    });
    const others = (s.templates || []).filter((x) => x.id !== draft.id).map((x) => x.name);
    tb.append(
      el(
        'tr',
        {},
        el('td', {}, cb),
        el('td', { text: s.name || '-' }),
        delayCell(s, timeoutMs),
        el('td', { class: 'note', 'data-label': '别的模板', text: others.length ? others.join(' / ') : '—' }),
        el(
          'td',
          { 'data-label': '能力' },
          s.searchable ? el('span', { class: 'badge ok', title: '源申报它能搜（没标的也可能能搜）', text: '搜索' }) : null,
          s.filterable ? el('span', { class: 'badge', title: '源申报它支持二级筛选', text: '筛选' }) : null,
          s.indexs ? el('span', { class: 'badge', title: '源申报它是"点进条目后转去搜索"那种（豆瓣类）', text: '跳搜索' }) : null,
          el('span', { class: 'badge', title: '这条站点属于哪个大类（源申报）', text: s.groupLabel || s.group })
        )
      )
    );
  }
  table.append(tb);
  return el('div', { class: 'src-group' }, head, el('div', { class: 'table-wrap' }, table));
}

/** 勾 / 不勾一条（站点身份 = (源, 站点 key)：多源下同名 key 是两条不同的站点） */
function setChosen(s, on) {
  const next = draft.sites.filter((x) => !(x.source === s.source && x.key === s.key));
  if (on) next.push({ source: s.source, key: s.key });
  draft.sites = next;
  setDirty(true);
}

/** 整组动作：`mode` = 'on' 全勾 / 'invert' 翻转 —— 只动**传进来这些**（= 当前列出来的）站点 */
function bulk(sites, mode) {
  const keys = new Set(sites.map((s) => sid(s.source, s.key)));
  const chosen = new Set(draft.sites.map((x) => sid(x.source, x.key)));
  const next = draft.sites.filter((x) => !keys.has(sid(x.source, x.key)));
  for (const s of sites) {
    if (mode === 'on' || !chosen.has(sid(s.source, s.key))) next.push({ source: s.source, key: s.key });
  }
  draft.sites = next;
  setDirty(true);
  paintSites();
}

async function clearAll() {
  if (!draft.sites.length) return toast('这一套本来就没勾站点');
  const go = await confirmModal({
    title: '清空勾选',
    text: '把这一套模板的站点全部取消勾选？（点顶部的「保存这套模板」才真正写回）',
    okLabel: '全部取消',
    primary: false,
  });
  if (!go) return;
  draft.sites = [];
  setDirty(true);
  paintSites();
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
        title: `测速失败：${why}\n用的片名「${one.wd}」${one.tries > 1 ? `（第 ${one.tries} 发，首发失败后换过词）` : ''}\n这套模板开了「跳过测速失败的站点」时，聚合搜索会先跳过它 —— 点「测速」复测成功即恢复。\n${callNote}`,
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
    paintSites();
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
  if (!draft) return;
  const chosenSet = new Set(draft.sites.map((x) => sid(x.source, x.key)));
  const list = (S.aggSites || []).filter((s) => siteVisible(s, chosenSet));
  if (!list.length) return toast('没有可测的站点（先调好筛选或视图）', true);
  const go = await confirmModal({
    title: '立即测速',
    text:
      `对当前列出来的 ${list.length} 个站点跑一轮测速？` +
      '测速在服务端跑（关掉页面也会继续）：每站一发 /search，片名从常见影视名里随机取、非 200 换一个再测一发，单站最多 15 秒。随时可以点「停止测速」。',
    okLabel: '开始测速',
  });
  if (!go) return;
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