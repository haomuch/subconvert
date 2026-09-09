/**
 * GET  /api/auth - Check password auth requirement and status
 * POST /api/auth - Verify provided password
 */

import { authenticate, getAuthConfig, getProvidedPassword } from '../_lib/auth.js';
import { json, error, handleCORS } from '../_lib/response.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const config = getAuthConfig(env);

  if (!config.required) {
    return json({ required: false, authenticated: true });
  }

  // 没带密码只是前端首屏在问"要不要弹登录框"，不能算一次失败 —— 否则
  // 每刷新一次页面就白白消耗一次重试机会。
  // 但带了密码就必须走限流校验：否则这个接口就是 POST /api/auth 的
  // 免限制旁路，可以无限次撞密码。
  if (!getProvidedPassword(request)) {
    return json({ required: true, authenticated: false });
  }

  const auth = await authenticate(request, env);

  if (auth.ok) {
    return json({ required: true, authenticated: true });
  }

  if (auth.reason === 'locked') {
    return error(
      `密码错误次数过多，请 ${Math.ceil(auth.retryAfter / 60)} 分钟后再试`,
      429,
      { 'Retry-After': String(auth.retryAfter) }
    );
  }

  return error('访问密码错误', 401);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const config = getAuthConfig(env);

  if (!config.required) {
    return json({ required: false, authenticated: true });
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    // Body is optional if password is passed via header
  }

  // 用带限流的鉴权：失败会计入该 IP 的失败次数，达到阈值即锁定
  const auth = await authenticate(request, env, body.password);

  if (auth.ok) {
    return json({ required: true, authenticated: true });
  }

  if (auth.reason === 'locked') {
    return error(
      `密码错误次数过多，请 ${Math.ceil(auth.retryAfter / 60)} 分钟后再试`,
      429,
      { 'Retry-After': String(auth.retryAfter) }
    );
  }

  return error('访问密码错误', 401);
}

export async function onRequestOptions() {
  return handleCORS();
}
