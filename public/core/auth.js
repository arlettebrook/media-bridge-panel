'use strict';
/**
 * 面板鉴权（前端侧）：状态查询、跳登录页、退出、改密码。
 *
 * 会话是后端签发的 **HttpOnly cookie**，前端读不到也不该读 —— 所以这里不存任何 token，
 * 只做三件事：问后端当前登录状态、没登就**跳到独立登录页**、退出登录。
 *
 * 登录页是**独立页面** `/login.html`（逻辑见 core/login.js）：真实的表单 + 命名输入框，
 * 让浏览器 / 密码管理器能保存与自动填充密码（登录页能在"未登录"状态下被拉起来，
 * 靠的正是静态文件免登录这一点）。
 *
 * **不 import `core/api.js`**（那边反过来要 import 本文件的 `onUnauthorized`）——
 * 用原生 fetch 收发，避免模块循环。
 */

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { ok: res.ok, status: res.status, data: data || {} };
}

/** 问后端当前登录状态（**这个端点不需要登录**） */
export async function authStatus() {
  try {
    const res = await fetch('/api/auth/status');
    if (!res.ok) return { authed: false, isDefault: false, unknown: true };
    return Object.assign({ authed: false, isDefault: false }, await res.json());
  } catch {
    /* 后端都连不上：当作"未登录"，登录页里的报错会说明问题 */
    return { authed: false, isDefault: false, unreachable: true };
  }
}

/* ---------------------------------------------------------------- 跳登录页 */

let redirecting = false;

/**
 * 跳到独立登录页；`reason` 会在页面上说明原因（会话过期 / 后端连不上等）。
 *
 * 带上 `redirect` 记住"本来要去哪"，登录成功后跳回来。重复调用只跳一次 ——
 * 页面上常有好几条请求同时回 401，不拦就会互相打断跳转。
 */
export function gotoLogin(reason) {
  if (redirecting) return;
  redirecting = true;
  const q = new URLSearchParams();
  if (reason) q.set('reason', reason);
  const here = location.pathname + location.search + location.hash;
  if (here && here !== '/login.html') q.set('redirect', here);
  const qs = q.toString();
  location.replace('/login.html' + (qs ? '?' + qs : ''));
}

/** 数据接口回 401 时被 `core/api.js` 调 —— 跳到登录页 */
export function onUnauthorized(reason) {
  gotoLogin(reason || '会话已过期，请重新登录');
}

/**
 * 启动时先过这一关：登着 → true；没登 → 跳登录页并返回 false（调用方就别再拉数据了）。
 */
export async function ensureAuth() {
  const st = await authStatus();
  if (st.authed) return true;
  gotoLogin(st.unreachable ? '连不上面板后端，请确认服务在跑' : '');
  return false;
}

export async function logout() {
  await post('/api/auth/logout', {});
  location.replace('/login.html');
}

/** 改密码（成功后后端会清掉当前 cookie —— 调用方负责回到登录页） */
export async function changePassword(oldPassword, newPassword) {
  const r = await post('/api/auth/password', { oldPassword, newPassword });
  if (!r.ok) throw new Error((r.data && r.data.error) || '修改失败');
  return true;
}
