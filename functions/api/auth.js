/**
 * GET  /api/auth - Check password auth requirement and status
 * POST /api/auth - Verify provided password
 */

import { checkAuth, authenticate, getAuthConfig } from '../_lib/auth.js';
import { json, error, handleCORS } from '../_lib/response.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const config = getAuthConfig(env);
  const authResult = checkAuth(request, env);

  return json({
    required: config.required,
    authenticated: authResult.ok,
  });
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
