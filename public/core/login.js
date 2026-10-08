'use strict';
/**
 * 独立登录页（/login.html）的逻辑。
 *
 * 表单在 HTML 里是**真实提交**给 `/api/auth/login` 的（真实 `<form>` + 命名输入框），
 * 浏览器 / 密码管理器据此保存与自动填充密码。
 * 另有"记住密码"勾选框：勾选后登录成功会把密码 **Base64 混淆**后存进本机 localStorage，
 * 下次打开登录页自动预填；不勾或取消勾选则清除这份存储。两者并存、互不冲突。
 * ⚠️ Base64 只是**混淆**（不是加密）：防的是随手翻开存储的人，防不了懂行的人。
 * 这里接管提交（`preventDefault` + `fetch`）：免整页 POST 跳走，且能就地显示错误；
 * 万一 JS 没跑起来，那条原生 POST 仍可用。
 *
 * ⚠️ 本页是**静态文件（免登录）**，浏览器直接打开即可；已登录再进来会跳回面板。
 */
import { BRAND } from './branding.js';

const $ = (sel) => document.querySelector(sel);

const params = new URLSearchParams(location.search);

/** 登录成功后去哪：只接受站内路径（`/` 开头但不以 `//` 开头），否则回首页。 */
function redirectTarget() {
  const t = params.get('redirect') || '';
  return /^\/(?!\/)/.test(t) ? t : '/';
}

function showTip(msg) {
  $('#loginTip').textContent = msg || '';
}

async function init() {
  document.title = '登录 · ' + BRAND.panelName;
  $('#loginTitle').textContent = BRAND.panelName;
  const reason = params.get('reason');
  if (reason) $('#loginSub').textContent = reason;

  /* 已经登着就别停在登录页（手敲地址进来、或前一页刚登录完又回退过来） */
  try {
    const res = await fetch('/api/auth/status');
    const st = res.ok ? await res.json() : {};
    if (st && st.authed) {
      location.replace(redirectTarget());
      return;
    }
  } catch {
    /* 拿不到状态：照常显示表单，提交失败时会报"连不上面板后端" */
  }

  const form = $('#loginForm');
  const input = $('#panelPassword');
  const btn = $('#loginBtn');
  const remember = $('#rememberPw');

  /* "记住密码"：登录成功且勾选时把密码混淆后存进本机，下次打开自动预填并保留勾选。
     Base64 只是混淆不是加密；编解码走 UTF-8，兼容非 ASCII 密码。 */
  const REMEMBER_KEY = 'mbp-login-pw';
  const encodePw = (pw) => btoa(String.fromCharCode(...new TextEncoder().encode(pw)));
  const decodePw = (s) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
  let savedPw = '';
  try {
    const raw = localStorage.getItem(REMEMBER_KEY) || '';
    savedPw = raw ? decodePw(raw) : '';
  } catch { savedPw = ''; }
  if (savedPw) {
    input.value = savedPw;
    remember.checked = true;
    btn.focus();
  } else {
    input.focus();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!input.value) {
      showTip('请输入密码');
      return;
    }
    showTip('');
    btn.disabled = true;
    btn.textContent = '登录中…';
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: input.value }),
      });
      let data = {};
      try {
        data = await res.json();
      } catch {
        data = {};
      }
      if (res.ok) {
        try {
          if (remember.checked) localStorage.setItem(REMEMBER_KEY, encodePw(input.value));
          else localStorage.removeItem(REMEMBER_KEY);
        } catch {
          /* 存储不可用（隐私模式等）：不挡登录 */
        }
        location.replace(redirectTarget());
        return;
      }
      showTip(data.error || '登录失败');
      input.select();
    } catch {
      showTip('连不上面板后端，请确认服务在跑');
    }
    btn.disabled = false;
    btn.textContent = '登录';
  });
}

init();
