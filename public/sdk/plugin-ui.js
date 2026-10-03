/*
 * 插件 UI 公共脚本 —— 主题跟随
 *
 * 插件只引用这一个文件：
 *     <script src="/sdk/plugin-ui.js" defer></script>
 *
 * 插件页与面板同源，共享同一份 localStorage（键 mbp-theme）。
 * 面板里切换主题时，storage 事件会在本 iframe 触发，实时跟随。
 */
(function () {
  var root = document.documentElement;
  function apply() {
    root.setAttribute(
      'data-theme',
      localStorage.getItem('mbp-theme') === 'dark' ? 'dark' : 'light'
    );
  }
  apply();
  window.addEventListener('storage', function (e) {
    if (e.key === 'mbp-theme') apply();
  });
})();
