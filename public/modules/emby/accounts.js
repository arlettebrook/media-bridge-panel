'use strict';
/**
 * Emby 模块 · 「账号」页 —— 客户端登录用的账号，**按实例**增 / 删 / 改。
 *
 * 账号表在**每个实例自己的库**里（各一个 sqlite 文件，见 server/modules/emby/instance.js），
 * 所以这一页顶部先选实例，下面这张表就是那个实例的账号 —— 别的实例看不见它们。
 * 端点也带实例：`/api/emby/instances/{iid}/accounts`（见后端 routes.js）。
 *
 * 密码只存 scrypt 哈希：忘了找不回来，只能删掉重建；改密或删号之后那些客户端要重新登录一次。
 *
 * 每行还写出该实例里的 `UserId`（`md5(serverId|用户名)`，服务端现算）——
 * 客户端日志里只出现 UserId，端点上排查"这个请求是哪个账号打的"全靠它。
 */
import { el, modal, toast, fmtTime, confirmModal } from '../../core/dom.js';
import { api } from '../../core/api.js';
import { S } from '../../core/state.js';
import { renderPage } from '../../core/shell.js';

export async function renderEmbyAccounts(v) {
  let err = '';
  try {
    if (!S.emby.instances) {
      const r = await api('/api/emby/instances');
      S.emby.instances = r.instances || [];
    }
  } catch (e) {
    err = e.message;
  }
  if (err) {
    v.append(el('div', { class: 'hint warn', text: '读取实例失败：' + err + ' —— 账号是按实例分的，先要拿到实例清单。' }));
    return;
  }

  const list = S.emby.instances || [];
  if (!list.length) {
    v.append(el('div', { class: 'hint warn', text: '还没有 Emby 实例 —— 先到「Emby → 实例」页新增一台。' }));
    return;
  }
  /* 选中的实例没了（被删了）就退回第一个 —— 免得整页对着一个不存在的 id 报 404 */
  if (!list.some((x) => x.id === S.emby.iid)) S.emby.iid = list[0].id;
  const inst = list.find((x) => x.id === S.emby.iid);

  const accounts = await loadAccounts(inst);

  v.append(instanceCard(list, inst), accounts ? accountsCard(inst, accounts) : null);
}

/** 当前实例的账号表（按实例缓存：换了实例要重拉，见下面切换处的清理） */
async function loadAccounts(inst) {
  if (S.emby.accountsFor === inst.id && S.emby.accounts) return S.emby.accounts;
  try {
    const r = await api(`/api/emby/instances/${encodeURIComponent(inst.id)}/accounts`);
    S.emby.accounts = r.accounts || [];
    S.emby.accountsFor = inst.id;
    return S.emby.accounts;
  } catch (e) {
    /* 老 Node 上没有内置 sqlite 时会走到这（db.js 会给一句人话报错） */
    S.emby.accounts = null;
    S.emby.accountsFor = '';
    renderPage();
    toast('读取账号失败：' + e.message, true);
    return null;
  }
}

async function afterChange(msg) {
  S.emby.accounts = null;
  S.emby.accountsFor = '';
  S.emby.instances = null; // 账号数会变，实例页那一行也要跟着对
  toast(msg);
  renderPage();
}

/* ------------------------------------------------------------------ 顶部：选实例 */

function instanceCard(list, inst) {
  const sel = el('select', { title: '账号按实例分开 —— 选谁就是谁的账号' });
  for (const x of list) {
    const o = el('option', { value: x.id, text: `${x.name}（:${x.port}）${x.running ? '' : ' · 没在监听'}` });
    if (x.id === inst.id) o.selected = true;
    sel.append(o);
  }
  sel.addEventListener('change', () => {
    S.emby.iid = sel.value;
    S.emby.accounts = null;
    S.emby.accountsFor = '';
    renderPage();
  });

  return el(
    'div',
    { class: 'card' },
    el('h3', { text: '账号' }),
    el(
      'div',
      { class: 'field' },
      el('label', { text: '实例' }),
      sel,
      el('div', {}, el('span', { class: 'muted', text: '客户端填：' }), el('code', { class: 'mono', text: inst.url }))
    ),
    inst.running
      ? null
      : el('div', { class: 'err-note', text: inst.error ? `这个实例没在监听：${inst.error}` : '这个实例没在监听（已停用）—— 客户端连不上，账号也登不了。' })
  );
}

/* ------------------------------------------------------------------ 账号表 */

function accountsCard(inst, accounts) {
  const card = el(
    'div',
    { class: 'card' },
    el('h3', { text: `账号表 · ${inst.name}` }),
    el('div', { class: 'actions' }, el('button', { class: 'btn primary', text: '＋ 添加账号', onclick: () => openAddAccount(inst) }))
  );
  if (!accounts.length) {
    card.append(el('div', { class: 'muted', text: '还没有账号 —— 客户端登录会返回 401，点上面「＋ 添加账号」。' }));
    return card;
  }
  for (const a of accounts) card.append(accountRow(inst, a));
  return card;
}

function accountRow(inst, a) {
  const when = a.lastLoginAt ? '最近登录 ' + fmtTime(a.lastLoginAt) + (a.lastClient ? ' · ' + a.lastClient : '') : '还没登录过';
  /* 与实例行同一个形状：信息一行在上，按钮组是整块的最后一件东西、靠右 */
  const row = el(
    'div',
    { class: 'plugin-row' },
    el(
      'div',
      { class: 'file-row' },
      el('span', { class: 'name', text: a.username }),
      el('span', { class: 'note', text: when }),
      a.userId
        ? el('span', {
            class: 'badge mono',
            title: `这个实例里的 UserId（md5(serverId|用户名)）—— 客户端日志里只出现它，排查时对得上：${a.userId}`,
            text: 'UserId ' + String(a.userId).slice(0, 8),
          })
        : null
    ),
    el(
      'div',
      { class: 'row file-acts' },
      /* 改密走弹窗：行里展开一个密码框时，这一行的宽度会整个变一下（别的行跟着错位），
       * 而且窄屏那点地方塞不下"新密码 + 保存 + 取消"。与「添加账号」同一个形状。 */
      el('button', { class: 'btn mini', text: '改密', onclick: () => openChangePassword(inst, a) }),
      el('button', {
        class: 'btn mini danger',
        text: '删除',
        onclick: async () => {
          const go = await confirmModal({
            title: '删除账号',
            text: `删除「${inst.name}」里的账号 ${a.username}？该账号的客户端会立刻失效（要重新建一个才能登）。`,
            okLabel: '删除',
            primary: false,
          });
          if (!go) return;
          try {
            await api(`/api/emby/instances/${encodeURIComponent(inst.id)}/accounts/${encodeURIComponent(a.id)}`, { method: 'DELETE' });
            await afterChange('已删除账号：' + a.username);
          } catch (e) {
            toast('删除失败：' + e.message, true);
          }
        },
      })
    )
  );
  return row;
}

/* ------------------------------------------------------------------ 改密 */

/**
 * 改密弹窗：与「添加账号」同一个形状（密码框 + 显示密码 + 提示 + 取消/保存）。
 *
 * 改完服务端会把该账号已签发的 token 全部作废（见 `db.updateAccount`），
 * 所以在说明里点明"客户端要重新登录一次"，免得改完以为客户端坏了。
 */
function openChangePassword(inst, a) {
  const pass = el('input', { type: 'password', autocomplete: 'new-password', placeholder: '新密码（≥6 位）' });
  const show = el('input', { type: 'checkbox' });
  show.addEventListener('change', () => {
    pass.type = show.checked ? 'text' : 'password';
  });
  const tip = el('div', { class: 'note' });

  modal({
    title: `改密 · ${a.username}`,
    body: [
      el('div', { class: 'field' }, el('label', { text: '新密码' }), pass),
      el('label', { class: 'chk' }, show, '显示密码'),
      el('p', { class: 'note', text: `改完「${a.username}」已签发的登录凭证全部作废 —— 它的客户端要重新登录一次。` }),
      tip,
    ],
    actions: [
      { label: '取消' },
      {
        label: '保存',
        primary: true,
        onclick: async () => {
          if (pass.value.length < 6) {
            tip.textContent = '密码至少 6 位';
            return false;
          }
          try {
            await api(`/api/emby/instances/${encodeURIComponent(inst.id)}/accounts/${encodeURIComponent(a.id)}`, {
              method: 'PUT',
              body: { password: pass.value },
            });
          } catch (e) {
            tip.textContent = '改密失败：' + e.message;
            return false; // 窗口留着，让改一次重来
          }
          await afterChange('已改密：' + a.username + '（该账号的客户端需重新登录）');
        },
      },
    ],
  });
}

/* ------------------------------------------------------------------ 添加账号 */

function openAddAccount(inst) {
  const name = el('input', { type: 'text', spellcheck: 'false', placeholder: '用户名（客户端里填这个）' });
  const pass = el('input', { type: 'password', autocomplete: 'new-password', placeholder: '密码（≥6 位）' });
  const show = el('input', { type: 'checkbox' });
  show.addEventListener('change', () => {
    pass.type = show.checked ? 'text' : 'password';
  });
  const tip = el('div', { class: 'note' });

  modal({
    title: `添加账号 · ${inst.name}`,
    body: [
      el('div', { class: 'field' }, el('label', { text: '用户名' }), name),
      el('div', { class: 'field' }, el('label', { text: '密码' }), pass),
      el('label', { class: 'chk' }, show, '显示密码'),
      el('p', { class: 'note', text: `加在「${inst.name}」（:${inst.port}）—— 别的实例登不了。` }),
      tip,
    ],
    actions: [
      { label: '取消' },
      {
        label: '添加账号',
        primary: true,
        onclick: async () => {
          const username = name.value.trim();
          if (!username) {
            tip.textContent = '请填写用户名';
            return false;
          }
          if (pass.value.length < 6) {
            tip.textContent = '密码至少 6 位';
            return false;
          }
          try {
            await api(`/api/emby/instances/${encodeURIComponent(inst.id)}/accounts`, {
              method: 'POST',
              body: { username, password: pass.value },
            });
          } catch (e) {
            tip.textContent = '添加失败：' + e.message;
            return false; // 窗口留着，用户名不用重填
          }
          await afterChange('已添加账号：' + username);
        },
      },
    ],
  });
}