/**
 * Auth utilities for SubConvert
 */

import { getClientIP, getLockout, recordFailure, clearFailures } from './rate-limit.js';

/**
 * Get password auth configuration from Cloudflare environment
 */
export function getAuthConfig(env) {
  const configuredPassword = (env && (env.ACCESS_PASSWORD || env.ADMIN_PASSWORD)) || '';
  const password = typeof configuredPassword === 'string' ? configuredPassword.trim() : String(configuredPassword);
  return {
    required: password.length > 0,
    password,
  };
}

/**
 * Verify request authentication against configured password
 * @param {Request} request
 * @param {object} env
 * @param {string} [bodyPassword] - 可选：请求体里传来的密码（仅 POST /api/auth 用到）
 */
export function checkAuth(request, env, bodyPassword) {
  const { required, password } = getAuthConfig(env);
  if (!required) {
    return { ok: true, required: false };
  }

  const authHeader = request.headers.get('Authorization') || '';
  const customHeader = request.headers.get('X-Access-Password') || '';

  let providedPassword = '';
  if (customHeader) {
    providedPassword = customHeader.trim();
  } else if (authHeader.toLowerCase().startsWith('bearer ')) {
    providedPassword = authHeader.substring(7).trim();
  } else if (bodyPassword) {
    providedPassword = String(bodyPassword).trim();
  }

  if (providedPassword === password) {
    return { ok: true, required: true };
  }

  return { ok: false, required: true };
}

/**
 * 带失败限流的鉴权，所有需要密码的接口都应使用这个而不是 checkAuth。
 *
 * 流程：先看该 IP 是否被锁定 → 再校验密码 → 失败就记一次并可能触发锁定，
 * 成功就清空计数。
 *
 * KV 没配置时（env.SUBCONVERT_KV 缺失）会跳过限流，但密码校验照常生效，
 * 不会因为限流组件不可用而把接口敞开。
 *
 * @returns {Promise<{ok: boolean, required: boolean, reason?: string, retryAfter?: number}>}
 *   reason: 'locked' 表示触发了锁定；'bad-password' 表示密码错误
 */
export async function authenticate(request, env, bodyPassword) {
  const { required } = getAuthConfig(env);
  if (!required) {
    return { ok: true, required: false };
  }

  const ip = getClientIP(request);
  const kv = env && env.SUBCONVERT_KV;

  const lock = await getLockout(kv, ip);
  if (lock.locked) {
    return { ok: false, required: true, reason: 'locked', retryAfter: lock.retryAfter };
  }

  if (checkAuth(request, env, bodyPassword).ok) {
    await clearFailures(kv, ip);
    return { ok: true, required: true };
  }

  const result = await recordFailure(kv, ip);
  return {
    ok: false,
    required: true,
    reason: result.locked ? 'locked' : 'bad-password',
    retryAfter: result.retryAfter || 0,
  };
}
