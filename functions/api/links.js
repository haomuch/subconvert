/**
 * GET  /api/links      - List all conversion links
 * DELETE /api/links    - Delete a link by path (query: ?path=xxx)
 *
 * GET response:
 *   { "links": [ { id, sourceUrl, targetFormat, customPath, name, createdAt } ] }
 *
 * DELETE response:
 *   { "success": true, "deleted": "path" }
 */

import { listLinks, deleteLink } from '../_lib/store.js';
import { json, error, handleCORS } from '../_lib/response.js';
import { authenticate } from '../_lib/auth.js';
import { subscriptionCacheKey } from '../_lib/cache.js';

/** 鉴权失败时的统一响应（含限流锁定提示） */
function authError(auth) {
  if (auth.reason === 'locked') {
    return error(
      `密码错误次数过多，请 ${Math.ceil(auth.retryAfter / 60)} 分钟后再试`,
      429,
      { 'Retry-After': String(auth.retryAfter) }
    );
  }
  return error('Unauthorized: 访问密码错误或缺失', 401);
}

export async function onRequestGet(context) {
  const { request, env } = context;

  const auth = await authenticate(request, env);
  if (!auth.ok) {
    return authError(auth);
  }

  if (!env.SUBCONVERT_KV) {
    return error('KV namespace not configured', 500);
  }

  const links = await listLinks(env.SUBCONVERT_KV);

  // Build full subscription URLs
  const origin = new URL(request.url).origin;

  const linksWithUrl = links.map(link => ({
    ...link,
    subscriptionUrl: `${origin}/sub/${link.customPath}`,
  }));

  return json({ links: linksWithUrl });
}

export async function onRequestDelete(context) {
  const { request, env } = context;

  const auth = await authenticate(request, env);
  if (!auth.ok) {
    return authError(auth);
  }

  if (!env.SUBCONVERT_KV) {
    return error('KV namespace not configured', 500);
  }

  const url = new URL(request.url);
  const path = url.searchParams.get('path');

  if (!path) {
    return error('path query parameter is required');
  }

  const deleted = await deleteLink(env.SUBCONVERT_KV, path);
  if (!deleted) {
    return error('Link not found', 404);
  }

  // 清掉边缘缓存，否则删掉的链接在缓存过期前仍然能返回订阅内容。
  // 注意：边缘缓存是按数据中心分布的，这里只能清理当前数据中心的那份，
  // 其他边缘节点上的副本仍会存活到 TTL 到期（最多 CACHE_TTL_SECONDS）。
  try {
    await caches.default.delete(subscriptionCacheKey(url.origin, path));
  } catch { /* 清缓存失败不影响删除结果 */ }

  return json({ success: true, deleted: path });
}

export async function onRequestOptions() {
  return handleCORS();
}
