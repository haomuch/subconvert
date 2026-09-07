/**
 * GET /sub/:path - Subscription output endpoint
 *
 * Fetches the source subscription, converts to the target format,
 * and returns the result. Responses are cached at the edge for
 * CACHE_TTL_SECONDS, so a source change becomes visible within that window
 * rather than instantly.
 *
 * The conversion happens entirely on Cloudflare's edge — no third-party
 * conversion services are used, ensuring subscription data never leaves
 * your own infrastructure.
 */

import { processSubscriptionRequest } from '../_lib/convert.js';
import { incrementAccess } from '../_lib/store.js';
import { handleCORS } from '../_lib/response.js';
import { subscriptionCacheKey } from '../_lib/cache.js';

/** 边缘缓存时长（秒）。源订阅变更最长在这个时间后可见。 */
const CACHE_TTL_SECONDS = 300;

export async function onRequestGet(context) {
  const { params, env, request } = context;

  if (!env.SUBCONVERT_KV) {
    return new Response('KV namespace not configured', { status: 500 });
  }

  // The splat parameter gives us the full path after /sub/
  const path = params.path;
  if (!path) {
    return new Response('Subscription path is required', { status: 400 });
  }

  // Serve from the edge cache when possible. This avoids re-fetching and
  // re-converting the source on every client refresh (the main cause of
  // slow loads / timeouts when the source is slow or rate-limited).
  const cache = caches.default;
  const cacheKey = subscriptionCacheKey(new URL(request.url).origin, path);
  const cached = await cache.match(cacheKey);
  if (cached) {
    // Still bump the access counter in the background.
    context.waitUntil(incrementAccess(env.SUBCONVERT_KV, path));
    return cached;
  }

  // Cache miss: do the full pipeline (fetch source → convert → count).
  const result = await processSubscriptionRequest(env.SUBCONVERT_KV, path);

  if (result.error) {
    return new Response(result.message, { status: result.error });
  }

  // Build response with appropriate headers
  const headers = {
    'Content-Type': result.contentType,
    // 缓存 5 分钟：既避免每次访问都去回源（源订阅慢时会拖慢/拖垮服务），
    // 又不会像默认的 2 小时边缘 TTL 那样让源订阅的变更迟迟不生效。
    // 注意不要设 no-store —— 那会让 cache.put() 失败、边缘缓存彻底失效。
    'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
    // 不输出 Access-Control-Allow-Origin：不开放跨域，避免第三方网页的
    // 脚本把订阅内容读走。代理客户端（Clash 等）不是浏览器，不受影响。
  };

  // Subscription-Userinfo: forwarded verbatim from the source subscription so the
  // client keeps seeing traffic usage / expiry in EXACTLY the source's unit and
  // decimal format (GB, bytes, whatever the provider reports). We do NOT reformat
  // or re-round the numbers, and we do NOT invent placeholder values: if the
  // source does not report this header we simply omit it, so the output stays
  // strictly consistent with the source instead of showing misleading zeros.
  if (result.userInfo) {
    headers['Subscription-Userinfo'] = result.userInfo;
  }

  // Carry the source's management-page URL through (if any), so clients can
  // open the subscription's dashboard directly.
  if (result.webPageUrl) {
    headers['profile-web-page-url'] = result.webPageUrl;
  }

  const response = new Response(result.content, {
    status: 200,
    headers,
  });

  // Store a clone in the cache for subsequent requests.
  // 缓存写入失败不能影响本次响应，所以必须 catch（否则会产生未处理的
  // Promise rejection，整个请求可能被判定为异常）。
  context.waitUntil(cache.put(cacheKey, response.clone()).catch(() => {}));
  return response;
}

export async function onRequestOptions() {
  return handleCORS();
}
