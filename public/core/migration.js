'use strict';
/**
 * 数据迁移门禁（见 docs/adr/0047）。
 *
 * 启动时（登录之后、任何业务接口之前）问一次 `/api/migration/status`：
 *   · phase=ok       不挡，正常进面板；
 *   · phase=migrate  **预检里没有要用户决定的东西 → 默认静默迁移**（只铺一张进度卡，
 *                    跑完 reload）；有同名插件冲突（或预检本身出错）才铺向导，
 *                    而且向导**只列冲突项 + 解决入口**，步骤表跑起来才显示；
 *   · phase=ahead    数据来自更新的代码：只给"知悉后强制启动"（只改版本号、不转数据）。
 *
 * 迁移期间业务接口全是 503 MIGRATION_REQUIRED，所以这一层是**唯一**页面；
 * 跑完后服务端在本进程内拉起业务，前端直接 reload 进正常面板。
 */
import { el } from './dom.js';
import { api } from './api.js';

const TYPE_LABEL = { metadata: '元数据', source: '片源', home: '首页', output: '输出' };
const typeLabel = (t) => TYPE_LABEL[t] || t || '?';
const STEP_MARK = { done: '✔', running: '…', failed: '✘', pending: '·' };

/** @returns {Promise<boolean>} true = 已接管启动（调用方别再继续启动） */
export async function ensureMigrationGate() {
  let st = null;
  try {
    st = await api('/api/migration/status');
  } catch {
    /* 状态都取不到（网络断 / 老服务）：不挡启动 —— 让正常的"连不上后端"页去处理 */
    return false;
  }
  if (!st || st.phase === 'ok') return false;

  /* 迁移态而且**没什么要人决定的**（无同名冲突、预检也没出错）：静默跑完直接进面板，
   * 不铺向导 —— 向导只在真需要人来处置时才出现。 */
  if (st.phase === 'migrate' && !needsDecision(st)) {
    const { mask, card } = overlay();
    card.append(
      el('h2', { text: '正在升级数据' }),
      el('p', {
        class: 'note',
        text: `v${st.dataVersion} → v${st.currentVersion}，跑完自动进入面板，不用重启。`,
      }),
      el('div', { class: 'hint', text: '迁移中…' })
    );
    try {
      const out = await api('/api/migration/run', { method: 'POST' });
      if (out && out.phase === 'ok') {
        location.reload();
        return true;
      }
      mask.remove(); // 相位没变成 ok：交回正常启动流程
      return false;
    } catch (e) {
      /* 失败：退回向导（带错误文案与断点现场），让人处理后再点续跑 */
      mask.remove();
      await showWizardAfterFailure((e && e.message) || '未知错误');
      return true;
    }
  }

  showWizard(st);
  return true;
}

/** 预检里有没有需要用户决定的东西：同 id 多包冲突，或预检本身出错（那就不能静默） */
function needsDecision(st) {
  if (conflictGroups(st).length) return true;
  return ((st && st.tasks) || []).some((t) => t.precheck && t.precheck.error);
}

/** 预检列出的冲突组（只读；没冲突就是空数组） */
function conflictGroups(st) {
  const out = [];
  for (const t of (st && st.tasks) || []) {
    const pc = t.precheck;
    if (pc && Array.isArray(pc.conflicts)) out.push(...pc.conflicts);
  }
  return out;
}

/** 静默迁移失败后重新取一次状态（步骤状态才是现场），再铺向导 */
async function showWizardAfterFailure(message) {
  let fresh = null;
  try {
    fresh = await api('/api/migration/status');
  } catch {
    /* 取不到就用不到——下面兜底 */
  }
  if (fresh && fresh.phase === 'ok') {
    location.reload();
    return;
  }
  if (fresh && fresh.phase === 'migrate') {
    showWizard(fresh, message);
    return;
  }
  /* 状态本身也取不到 / 相位变了：铺一张只有错误文案的卡，别让人对着空白页 */
  const { card } = overlay();
  card.append(
    el('h2', { text: '迁移没跑完' }),
    el('div', { class: 'hint warn', text: message }),
    el('p', { class: 'note', text: '刷新页面可重试；迁移步骤是幂等的，会从未完成的那一步续跑。' })
  );
}

/** 全屏遮罩：盖住一切（含侧栏与登录框），不随 hash 切换消失 */
function overlay() {
  const mask = el('div', {
    style:
      'position:fixed;inset:0;z-index:9999;overflow:auto;background:rgba(0,0,0,.45);' +
      'padding:32px 16px;display:flex;justify-content:center;align-items:flex-start;',
  });
  const card = el('div', { class: 'card', style: 'width:min(720px,100%);margin:auto;' });
  mask.append(card);
  document.body.append(mask);
  return { mask, card };
}

function showWizard(st0, errMessage) {
  const { card } = overlay();
  if (st0.phase === 'ahead') renderAhead(card, st0);
  else renderMigrate(card, st0, errMessage || '');
}

/* ------------------------------------------------------------------ 超前 */

function renderAhead(card, st) {
  const cb = el('input', { type: 'checkbox' });
  const btn = el('button', { class: 'btn primary', text: '强制启动', disabled: true });
  cb.addEventListener('change', () => {
    btn.disabled = !cb.checked;
  });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = '正在切换…';
    try {
      await api('/api/migration/override', { method: 'POST' });
      location.reload();
    } catch (e) {
      btn.textContent = '强制启动';
      btn.disabled = !cb.checked;
      card.append(el('div', { class: 'hint warn', text: '失败：' + e.message }));
    }
  });
  card.append(
    el('h2', { text: '数据版本比面板新' }),
    el('div', {
      class: 'hint warn',
      text: `数据是 v${st.dataVersion} 的格式，而这个面板只认到 v${st.currentVersion}。`,
    }),
    el('p', {
      class: 'note',
      text:
        '强制启动只会把版本标记改到 v' +
        st.currentVersion +
        '，**不会转换任何数据**。如果这是降级旧面板后看到的，请确认旧代码读得动新数据，否则请换成更新的面板。',
    }),
    el('label', { class: 'chk' }, cb, '已知悉：数据不会被转换，仍要强制启动'),
    el('div', { class: 'row' }, btn)
  );
}

/* ------------------------------------------------------------------ 迁移 */

function renderMigrate(card, st0, errMessage) {
  const groups = conflictGroups(st0);
  card.append(
    el('h2', { text: '需要先完成数据迁移' }),
    el('p', {
      class: 'note',
      text: groups.length
        ? `数据当前是 v${st0.dataVersion}，面板要求 v${st0.currentVersion}。同名插件在多个类型下各装了一份，` +
          '而新布局一个 id 只有一个目录 —— 先决定各组保留哪一份，再跑迁移。'
        : `数据当前是 v${st0.dataVersion}，面板要求 v${st0.currentVersion}。迁移期间业务接口暂停，跑完自动继续，不用重启。`,
    })
  );

  /* 冲突区：**只列需要决定的项目**（没有冲突时整块不出现） */
  const conflictBox = el('div');
  card.append(conflictBox);
  renderConflicts(conflictBox, groups, st0);
  if (groups.length) {
    card.append(
      el('div', { class: 'row' }, el('a', { class: 'btn', href: '/api/panel/backup', text: '先下载一份完整备份' }))
    );
  }

  const errBox = el('div');
  const stepsBox = el('div', { style: 'display:none' }); // 跑起来才显示步骤表
  const runBtn = el('button', { class: 'btn primary', text: groups.length ? '解决并迁移' : '开始迁移' });
  const refreshBtn = () => {
    runBtn.disabled = conflictValidation(conflictBox) !== '';
  };
  refreshBtn();

  if (errMessage) {
    /* 从静默迁移退回来的：先亮出失败现场（哪一步挂了），再让人重试 */
    stepsBox.style.display = '';
    renderSteps(stepsBox, st0.tasks);
    errBox.append(
      el('div', { class: 'hint warn', text: '上次迁移没跑完：' + errMessage }),
      el('p', { class: 'note', text: '步骤是幂等的，处理完问题后再点一次即可从断点继续。' })
    );
  }

  card.append(el('div', { class: 'row' }, runBtn), errBox, stepsBox);

  runBtn.addEventListener('click', () => startRun(card, conflictBox, stepsBox, errBox, runBtn, refreshBtn));
  /* 勾选状态变化后刷新可点性（冲突复选框是后画进去的，事件在 conflictBox 上委托） */
  conflictBox.addEventListener('change', refreshBtn);
}

/** 预检冲突：同 id 的旧包在多个类型下各有一份，新布局只能留一个目录。
 * 默认**全选删除**（合并后的多类型包迁移完从插件库重装）；也可以只留一份。 */
function renderConflicts(box, groups, st) {
  for (const t of (st && st.tasks) || []) {
    const pc = t.precheck;
    if (pc && pc.error) box.append(el('div', { class: 'hint warn', text: '预检出错：' + pc.error }));
  }
  if (!groups.length) return;

  box.append(el('h3', { text: '先解决同名插件冲突' }), el(
    'p',
    { class: 'note' },
    '下面这些插件 id 在多个类型下各装了一份；新布局一个 id 只有一个目录。' +
      '勾选要**删除**的副本（默认全删，合并后的多类型包迁移完再从插件库安装）；每组最多保留一份，保留的会被拍平迁移。'
  ));

  for (const g of groups) {
    const rows = g.items.map((it) => {
      const ck = el('input', { type: 'checkbox', checked: true, 'data-type': it.type, 'data-id': it.id });
      const dataNote = it.dirExists ? (it.dataEmpty ? '无数据' : `有约 ${Math.max(1, Math.round(Number(it.dataBytes || 0) / 1024))}KB 数据`) : '目录不在';
      return el(
        'label',
        { class: 'chk' },
        ck,
        el('span', { class: 'badge', text: typeLabel(it.type) }),
        ` ${it.name} v${it.version || '?'}（${dataNote}）`
      );
    });
    box.append(el('div', { class: 'card' }, el('div', { class: 'plugin-head' }, el('strong', { text: g.id })), ...rows));
  }
}

/** 校验冲突勾选：每组保留数 ≤ 1。返回错误文案（'' = 通过） */
function conflictValidation(box) {
  const groups = box.querySelectorAll('.card');
  for (const grp of groups) {
    const boxes = grp.querySelectorAll('input[type=checkbox]');
    const kept = [...boxes].filter((c) => !c.checked).length;
    if (kept > 1) return '每组最多保留一份（其余勾选删除）';
  }
  return '';
}

function renderSteps(box, tasks) {
  box.textContent = '';
  for (const t of tasks || []) {
    box.append(el('h3', { text: t.title || `升级到 v${t.version}` }));
    const ul = el('div');
    for (const s of t.steps || []) {
      const cls = s.status === 'done' ? ' ok' : s.status === 'failed' ? ' err' : s.status === 'running' ? ' warn' : '';
      ul.append(
        el('div', {}, el('span', { class: 'badge' + cls, text: STEP_MARK[s.status] || '·' }), ' ', s.name),
        s.status === 'failed' && s.error ? el('div', { class: 'note err-note', text: '错误：' + s.error }) : null
      );
    }
    if (t.status === 'failed' && t.error) ul.append(el('div', { class: 'hint warn', text: '任务失败：' + t.error }));
    box.append(ul);
  }
}

async function startRun(card, conflictBox, stepsBox, errBox, runBtn, refreshBtn) {
  errBox.textContent = '';
  const verr = conflictValidation(conflictBox);
  if (verr) {
    errBox.append(el('div', { class: 'hint warn', text: verr }));
    return;
  }
  /* 收集删除名单（勾上的 = 删） */
  const removeConflicts = [];
  for (const ck of conflictBox.querySelectorAll('input[type=checkbox]')) {
    if (ck.checked) removeConflicts.push({ type: ck.dataset.type, id: ck.dataset.id });
  }

  runBtn.disabled = true;
  runBtn.textContent = '迁移中…';
  stepsBox.style.display = ''; // 开跑才亮出步骤表（跑之前的向导只关心冲突）

  /* 边跑边刷步骤状态：服务端每步落盘，status 里看得到断点位置 */
  const timer = setInterval(async () => {
    try {
      const st = await api('/api/migration/status');
      if (st && st.phase === 'migrate') renderSteps(stepsBox, st.tasks);
    } catch {
      /* 轮询失败不打断：结果以 POST 回来的为准 */
    }
  }, 800);

  let out = null;
  let failed = null;
  try {
    out = await api('/api/migration/run', { method: 'POST', body: { removeConflicts } });
  } catch (e) {
    failed = e;
  }
  clearInterval(timer);

  /* 再拉一次终态（步骤完成标记 / 失败定位都以它为准） */
  let last = null;
  try {
    last = await api('/api/migration/status');
  } catch {
    /* ignore */
  }
  if (last && last.phase === 'migrate') renderSteps(stepsBox, last.tasks);

  if (!failed && out && out.phase === 'ok') {
    card.textContent = '';
    card.append(
      el('h2', { text: '迁移完成' }),
      el('div', { class: 'hint', text: '数据已是最新版本，正在进入面板…' })
    );
    setTimeout(() => location.reload(), 600);
    return;
  }

  /* 失败：保留现场（已完成的步骤已标完成，可断点续跑），允许再点一次 */
  runBtn.textContent = '继续迁移（从未完成的步骤续跑）';
  refreshBtn();
  errBox.append(
    el(
      'div',
      { class: 'hint warn' },
      '迁移没跑完：' + ((failed && failed.message) || '未知错误'),
      el('br'),
      '步骤是幂等的，处理完问题后再点一次即可从断点继续。'
    )
  );
}
