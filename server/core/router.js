'use strict';
/**
 * 极简路由表：模块自己登记端点，server.js 不再写 if 链
 *
 *   add('GET',  '/api/settings', handler)
 *   add('ANY',  '/api/base/upstream', handler)
 *   add('GET',  '/api/sources/:id', handler)
 *   add('ANY',  '/website/*rest', handler)     // 通配剩余路径
 *
 * handler(req, res, ctx)；ctx = { params, query, pathname }
 *
 * **字面段比对不区分大小写**（对齐真机 Emby 的 .NET 路由，也是 HTTP 路径的通行做法）：
 * 客户端把 `/Users/AuthenticateByName` 写成小写 `authenticatebyname` 也算命中
 * （实测 AfuseKt/3.2.0 就这么发，此前落在 501 通配）。`*wildcard` 与 `:param` 的**取值照原样**给。
 */
const { sendError } = require('./http');

const routes = [];

function add(method, pattern, handler) {
  if (typeof handler !== 'function') throw new Error('路由缺少 handler：' + pattern);
  routes.push({
    method: String(method || 'ANY').toUpperCase(),
    segs: String(pattern).split('/').filter(Boolean),
    handler,
  });
}

/** 路径匹配：支持 :param 与末尾 *wildcard；字面段**不区分大小写** */
function match(patternSegs, reqSegs) {
  const params = {};
  for (let i = 0; i < patternSegs.length; i++) {
    const p = patternSegs[i];
    if (p.startsWith('*')) {
      params[p.slice(1) || 'rest'] = reqSegs.slice(i).map(decodeURIComponent).join('/');
      return params;
    }
    if (i >= reqSegs.length) return null;
    if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(reqSegs[i]);
    else if (p.toLowerCase() !== reqSegs[i].toLowerCase()) return null;
  }
  return patternSegs.length === reqSegs.length ? params : null;
}

async function handle(req, res, { pathname, searchParams }) {
  const reqSegs = pathname.split('/').filter(Boolean);
  let pathMatched = false;
  for (const r of routes) {
    const params = match(r.segs, reqSegs);
    if (!params) continue;
    pathMatched = true;
    if (r.method !== 'ANY' && r.method !== req.method) continue;
    return r.handler(req, res, { params, query: searchParams, pathname });
  }
  if (pathMatched) return sendError(res, 405, '不支持的方法');
  return sendError(res, 404, '接口不存在');
}

function list() {
  return routes.map((r) => ({ method: r.method, path: '/' + r.segs.join('/') }));
}

module.exports = { add, handle, list };
