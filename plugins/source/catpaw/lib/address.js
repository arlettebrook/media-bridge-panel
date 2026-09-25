'use strict';
/**
 * 播放地址的**最后一公里**：把"源自己回的地址"变成"客户端真能连上的地址"。
 *
 * 为什么需要这一步：本地部署的源，它的 HTTP 服务会按"谁访问它"回填 host —— 插件是用
 * `http://127.0.0.1:<端口>` 打它的，于是它回的播放地址也是 `127.0.0.1:<端口>/proxy/…`。
 * 那个地址对**客户端**毫无意义（客户端上的 127.0.0.1 是客户端自己），302 过去必然连不上。
 * 所以换成 `http://<客户端访问面板用的域名>:<源端口>/…` —— 端口原样保留
 * （部署时已把源端口发布到宿主，所以"用哪个域名进的，就用哪个域名 + 那个端口"够得着）。
 *
 * 只在**地址确实是回环**时才改：源给的是真直链（CDN 域名那种）就不动它。
 * 外部地址的实例一律原样 —— 那种源在别的机器上，它给的地址本来就该是客户端够得着的。
 * 相对地址（源只回 `/proxy/…`）按同一个域 + 源端口补全，否则客户端会把它拼到**面板**身上。
 *
 * **这一段是从面板的 `emby/service.js` 搬过来的**（原来叫 `redirectUrl()`）：`ref` 转交之后，
 * 面板不再需要知道实例端口，也就没法再做这一步 —— 而插件本来就知道自己这个实例是本地还是外部、
 * 端口是多少。客户端访问用的域名由面板在「解析地址」时一起传进来（`clientHost`）。
 */

/** 回环地址的各种写法：源按「谁访问它」回填 host，插件从 127.0.0.1 打过去，源就回这些 */
const LOOPBACK_HOST = /^(127\.\d+\.\d+\.\d+|0\.0\.0\.0|localhost|\[::1\]|::1)$/i;

/** 从 `Host` 头里取"客户端用来访问的那台机器"（去掉端口；IPv6 保留方括号） */
function clientHostName(host) {
  const h = String(host || '').trim();
  if (!h) return '';
  if (h.startsWith('[')) {
    const i = h.indexOf(']');
    return i > 0 ? h.slice(0, i + 1) : '';
  }
  return h.split(':')[0];
}

/**
 * @param rawUrl  源回的地址（可能是绝对地址，也可能是 `/proxy/…` 这种相对地址）
 * @param opts    `{clientHost, local, port}` —— `local` = 这个实例是**本地部署**的（才需要改写）
 * @returns `{url, rewrote, note}`；`note` 是给日志的说明（没改写但原因值得记时才有值）
 */
function toClientReachable(rawUrl, { clientHost, local, port } = {}) {
  const url = String(rawUrl || '').trim();
  if (!local) return { url, rewrote: false, note: '' };
  const host = clientHostName(clientHost);
  if (!host) return { url, rewrote: false, note: '没拿到客户端 Host（302 只能原样回源地址）' };
  const p = port ? String(port) : '';

  if (url.startsWith('/')) {
    if (!p) return { url, rewrote: false, note: '源只回了相对地址，但它的端口未知（没法补全）' };
    return { url: `http://${host}:${p}${url}`, rewrote: true, note: '' };
  }

  const m = /^(https?):\/\/([^/?#]+)([\s\S]*)$/i.exec(url);
  if (!m) return { url, rewrote: false, note: '播放地址认不出（不是 http 绝对地址）' };
  const at = m[2].lastIndexOf('@');
  const userinfo = at >= 0 ? m[2].slice(0, at + 1) : '';
  const hostport = at >= 0 ? m[2].slice(at + 1) : m[2];
  let hostOnly = hostport;
  let portInUrl = '';
  if (hostport.startsWith('[')) {
    const i = hostport.indexOf(']');
    hostOnly = hostport.slice(0, i + 1);
    portInUrl = hostport.slice(i + 1);
  } else {
    const i = hostport.indexOf(':');
    if (i >= 0) {
      hostOnly = hostport.slice(0, i);
      portInUrl = hostport.slice(i);
    }
  }
  if (!LOOPBACK_HOST.test(hostOnly)) return { url, rewrote: false, note: '' }; // 真直链，别动
  const tailPort = portInUrl || (p ? ':' + p : '');
  return { url: `${m[1]}://${userinfo}${host}${tailPort}${m[3]}`, rewrote: true, note: '' };
}

module.exports = { LOOPBACK_HOST, clientHostName, toClientReachable };
