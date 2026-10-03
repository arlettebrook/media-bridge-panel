'use strict';
/**
 * 插件自带的 UI（`plugin.json` 的 `webui`）在面板里的那一页。
 *
 * 侧栏「元数据 / 片源 / 首页 / 输出」四栏下每个**启用中且带 webui** 的插件都是一个子项，
 * 它们共用这一个渲染器（见 core/registry.js 的 setPluginUiRenderer）——
 * 插件不必往面板登记任何渲染函数，面板也不解析插件 UI 的内容。
 *
 * 插件 UI 是它自己的 HTML：这里只给它一个铺满的 iframe，src 指到
 * `/api/plugins/<类型>/<插件id>/ui/`（与「插件 → 管理」页那个「设置」按钮同一个地址，
 * 同样受面板门禁保护）。插件想跟自己的子进程说话，走它自己那份 webui 后端
 * （面板把 `/api/plugins/<类型>/<插件id>/api/**` 原样转成动作 `http`）。
 *
 * 页 id 形如 `pui-<类型>-<插件id>`，类型与插件 id 从 id 里反解。
 */
import { el } from './dom.js';
import { S } from './state.js';
import { parsePluginUiPage } from './registry.js';

export function renderPluginUi(v) {
  const info = parsePluginUiPage(S.page);
  if (!info) {
    /* 正常到不了这儿：rendererOf 只在 id 能反解时才把这一页交给本渲染器 */
    v.append(el('div', { class: 'hint warn', text: '认不出这一页属于哪个插件：' + S.page }));
    return;
  }
  const list = (S.plugins && S.plugins.plugins) || [];
  /* 身份是 id；再确认这个包确实声明了当前类型（多类型包在多栏各有一页，见 docs/adr/0046） */
  const plugin = list.find((p) => p && p.id === info.id && Array.isArray(p.types) && p.types.includes(info.type));
  /* webuiPaths[type] 由后端给（它才知道这个角色的入口是哪个文件）；没到手就自己拼。
   * 带上 ?role= —— 转发消息与 iframe 路径天然含角色段，插件 http 处理器据此分发。 */
  const base =
    (plugin && plugin.webuiPaths && plugin.webuiPaths[info.type]) ||
    `/api/plugins/${info.type}/${encodeURIComponent(info.id)}/ui/`;
  const src = base + '?role=' + encodeURIComponent(info.type);
  const frame = el('iframe', {
    class: 'plugin-ui-frame',
    src,
    title: (plugin && plugin.name) || info.id,
  });
  v.append(frame);
}