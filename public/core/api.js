'use strict';
/**
 * 后端接口封装：一律 JSON。
 * 非 2xx 抛错，错误文案取响应体的 `error`（后端各模块都是这个约定）——
 * 页面里统一用 try/catch + toast 处理，不必各自判 res.ok。
 */
import { onUnauthorized } from './auth.js';

export async function api(path, { method = 'GET', body = null } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (res.status === 401) {
    /* 会话过期 / 还没登录：把登录框弹出来（不逐条弹 toast —— 那会刷屏） */
    onUnauthorized((data && data.error) || '需要登录面板');
    throw new Error('需要登录面板');
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || 'HTTP ' + res.status);
    /* 业务码一并带出：如 503 MIGRATION_REQUIRED（启动迁移向导用，见 core/migration.js） */
    err.code = (data && data.code) || '';
    err.status = res.status;
    throw err;
  }
  return data;
}
