/**
 * POST /api/convert - Create a new conversion link
 *
 * Request body:
 *   {
 *     "sourceUrl": "https://example.com/sub",      // required
 *     "targetFormat": "clash",                       // required: clash | singbox | base64 | plain
 *     "customPath": "my-sub",                        // optional, auto-generated if omitted
 *     "name": "My Subscription"                      // optional display name
 *   }
 *
 * Response:
 *   {
 *     "id": "my-sub",
 *     "sourceUrl": "...",
 *     "targetFormat": "clash",
 *     "customPath": "my-sub",
 *     "subscriptionUrl": "/sub/my-sub",
 *     "name": "My Subscription",
 *     "createdAt": 1234567890
 *   }
 */

import { createLink, pathExists } from '../_lib/store.js';
import { sanitizePath, generateId } from '../_lib/utils.js';
import { json, error, handleCORS } from '../_lib/response.js';
import { checkAuth } from '../_lib/auth.js';

const VALID_FORMATS = ['clash', 'singbox', 'base64', 'plain'];

export async function onRequestPost(context) {
  const { request, env } = context;

  const auth = checkAuth(request, env);
  if (!auth.ok) {
    return error('Unauthorized: 访问密码错误或缺失', 401);
  }

  if (!env.SUBCONVERT_KV) {
    return error('KV namespace not configured. Set up SUBCONVERT_KV binding in wrangler.toml.', 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return error('Invalid JSON body');
  }

  const { sourceUrl, targetFormat, customPath, name, userAgent } = body;

  // Validate required fields
  if (!sourceUrl || typeof sourceUrl !== 'string') {
    return error('sourceUrl is required');
  }

  // Validate URL format
  try {
    new URL(sourceUrl);
  } catch {
    return error('sourceUrl is not a valid URL');
  }

  // Validate target format
  if (!targetFormat || !VALID_FORMATS.includes(targetFormat)) {
    return error(`targetFormat must be one of: ${VALID_FORMATS.join(', ')}`);
  }

  // Sanitize and validate custom path
  const rawPath = customPath ? String(customPath).trim() : '';
  let path = rawPath ? sanitizePath(rawPath) : generateId(8);

  // Reject unsupported characters explicitly instead of silently
  // generating a random path. Spaces are allowed (auto → hyphen).
  // 不允许 "/"（路由只有单段，含斜杠的链接必然 404）和 "."（会产生
  // "." / ".." 这类畸形路径，浏览器还会对 URL 做规范化，导致链接对不上）。
  if (rawPath && !/^[a-zA-Z0-9\-_ ]+$/.test(rawPath)) {
    return error(
      '自定义路径仅支持英文、数字、连字符、下划线（空格会自动转为连字符）；不支持斜杠和点，请修改或留空由系统自动生成',
      400
    );
  }

  if (!path) {
    path = generateId(8);
  }

  // Check if path already exists
  if (await pathExists(env.SUBCONVERT_KV, path)) {
    return error(`Path "${path}" already exists. Choose a different one.`, 409);
  }

  // Create the link
  let link;
  try {
    link = await createLink(env.SUBCONVERT_KV, {
      sourceUrl,
      targetFormat,
      customPath: path,
      name: name || '',
      userAgent: userAgent || '',
    });
  } catch (e) {
    return error(e.message || 'Failed to create link', 400);
  }

  // Build the subscription URL
  const url = new URL(request.url);
  const subscriptionUrl = `${url.origin}/sub/${path}`;

  return json({
    ...link,
    subscriptionUrl,
  });
}

export async function onRequestOptions() {
  return handleCORS();
}
