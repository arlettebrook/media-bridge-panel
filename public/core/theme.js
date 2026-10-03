'use strict';
/**
 * 主题：亮 / 暗，默认**亮**。
 *
 * 偏好只存在**浏览器本地**（localStorage），不上后端 —— 这是"这台设备上看着顺眼"的事，
 * 换台设备各选各的比"一处改、处处变"更合理。
 *
 * ⚠️ 样式层只认 `<html data-theme="light|dark">`（两套令牌组见 style.css 顶部）。
 * 首屏那一刻由 index.html 里那段内联小脚本兜底：不然刷新时会先闪一帧另一套色。
 */
const KEY = 'mbp-theme';
const MODES = ['light', 'dark'];
const LABEL = { light: '亮', dark: '暗' };

/**
 * 按钮上的图标：**画的是当前那一档**（亮色时一颗太阳、暗色时一弯月亮），
 * 与按钮 title 里"当前X色 —— 点击切到Y色"的说法一致 —— 切换类按钮显示"现在是什么"
 * 比显示"点一下会变成什么"更不容易看岔。外形沿用侧栏那套 `nav-ico` 约定
 * （16 网格、`stroke="currentColor"`，跟着按钮文字色走）。 */
const ICON = {
  light:
    '<svg class="nav-ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="8" cy="8" r="3.1"/>' +
    '<path d="M8 1.2v1.7M8 13.1v1.7M1.2 8h1.7M13.1 8h1.7M3.2 3.2l1.2 1.2M11.6 11.6l1.2 1.2M12.8 3.2l-1.2 1.2M4.4 11.6l-1.2 1.2"/>' +
    '</svg>',
  dark:
    '<svg class="nav-ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M13.4 9.7A5.7 5.7 0 0 1 6.3 2.6 5.8 5.8 0 1 0 13.4 9.7Z"/>' +
    '</svg>',
};

/** 存的偏好（'light' | 'dark'）；存的不是这两个值（首次进、被更早的版本写过 'auto'）一律当 light */
function readMode() {
  try {
    const v = localStorage.getItem(KEY);
    return MODES.includes(v) ? v : 'light';
  } catch {
    return 'light'; // 无痕模式禁读：这一趟按默认走
  }
}

/** 把当前偏好写进 `<html data-theme>`，顺带把地址栏那条 theme-color 也换成当前底色 */
function paint() {
  const mode = readMode();
  document.documentElement.setAttribute('data-theme', mode);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    if (bg) meta.setAttribute('content', bg);
  }
  return mode;
}

export function getTheme() {
  return readMode();
}

export function setThemeMode(mode) {
  try {
    localStorage.setItem(KEY, MODES.includes(mode) ? mode : 'light');
  } catch {
    /* 禁写（无痕）：本次照样生效，只是记不住 —— 不值得为它弹个错 */
  }
  return paint();
}

/** 亮 ⇄ 暗。按钮上显示的就是**当前**那一档，点一下切到另一档。 */
export function cycleTheme() {
  return setThemeMode(readMode() === 'light' ? 'dark' : 'light');
}

/** 把主题按钮接上（侧栏品牌行一颗、窄屏顶栏一颗 —— 同一份状态，两颗一起变）。 */
export function mountThemeButtons(btns) {
  const list = (Array.isArray(btns) ? btns : [btns]).filter(Boolean);
  if (!list.length) return;

  function sync() {
    const mode = getTheme();
    const other = LABEL[mode === 'light' ? 'dark' : 'light'];
    const title = `当前${LABEL[mode]}色 —— 点击切到${other}色`;
    for (const b of list) {
      b.innerHTML = ICON[mode];
      b.title = title;
      b.setAttribute('aria-label', title);
    }
  }

  for (const b of list) {
    b.addEventListener('click', () => {
      cycleTheme();
      sync();
    });
  }
  sync();
}
