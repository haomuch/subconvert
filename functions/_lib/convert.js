/**
 * Main conversion pipeline: fetch source subscription → parse → convert → output.
 * All processing happens locally on Cloudflare's edge — no third-party conversion services.
 */

import { parseSubscription } from './sub-parse.js';
import { generateSubscription } from './sub-generate.js';
import { getLink } from './store.js';
import { validatePublicUrl } from './utils.js';

/** Default User-Agent for fetching subscriptions (many providers require a specific UA) */
const DEFAULT_UA = 'clash-verge/v2.5.1';

/** 源订阅最多等 15 秒，超时就放弃，避免慢源把整个服务拖死（含读取响应体） */
const FETCH_TIMEOUT_MS = 15000;
/** 源订阅最多读 5MB，避免超大响应把 Worker 内存撑爆 */
const MAX_SUBSCRIPTION_BYTES = 5 * 1024 * 1024;
/** 手动跟随重定向的上限。用 'follow' 的话中间每一跳都拦不住，SSRF 防护等于虚设。 */
const MAX_REDIRECTS = 5;

/** 把字节数格式化成易读的单位（用于错误提示） */
function formatBytes(bytes) {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(0)}MB`
    : `${Math.round(bytes / 1024)}KB`;
}

/**
 * 读取响应体，并限制最大字节数。
 * 流式累积读取，超限时立刻中断连接，而不是先把整个 body 读进内存再判断。
 * @param {Response} resp
 * @param {number} maxBytes
 * @param {string} label - 用于错误提示
 */
async function readBodyLimited(resp, maxBytes, label) {
  const tooLarge = () =>
    new Error(`${label} 体积超过 ${formatBytes(maxBytes)}，已放弃读取`);

  const declaredLength = resp.headers.get('content-length');
  if (declaredLength && parseInt(declaredLength, 10) > maxBytes) {
    throw tooLarge();
  }

  if (!resp.body) {
    const text = await resp.text();
    if (text.length > maxBytes) throw tooLarge();
    return text;
  }

  const reader = resp.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* 锁已释放或流已取消 */ }
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/** 发一次（不自动跟随重定向）请求，把网络层异常翻成可读的中文错误 */
async function fetchOnce(url, ua, signal) {
  try {
    return await fetch(url, {
      headers: {
        'User-Agent': ua,
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
      },
      redirect: 'manual',
      signal,
    });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw new Error(`获取源订阅超时（超过 ${FETCH_TIMEOUT_MS / 1000} 秒）`);
    }
    throw new Error(`无法连接源订阅：${e && e.message ? e.message : e}`);
  }
}

/**
 * Fetch source subscription content.
 * @param {string} url - Source subscription URL
 * @param {string} userAgent - Optional custom User-Agent
 * @returns {Promise<{content: string, headers: object}>} Raw subscription content
 *   plus any subscription-metadata headers carried by the source (e.g.
 *   Subscription-Userinfo, profile-web-page-url).
 */
export async function fetchSubscription(url, userAgent) {
  const ua = userAgent || DEFAULT_UA;

  let target = url;
  let resp;
  let content;

  // 每一跳都重新做地址校验：redirect: 'follow' 会让源站把请求导到内网而
  // 我们看不到，所以改成手动跟随并对 Location 再校验一次。
  for (let hop = 0; ; hop++) {
    const guard = validatePublicUrl(target);
    if (!guard.ok) {
      throw new Error(`源订阅地址不被允许：${guard.reason}`);
    }

    // 超时覆盖"建立连接 + 读取响应体"全过程
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      resp = await fetchOnce(guard.url.href, ua, controller.signal);

      const location = resp.headers.get('location');
      if (resp.status >= 300 && resp.status < 400 && location) {
        if (hop >= MAX_REDIRECTS) {
          throw new Error(`源订阅重定向次数超过 ${MAX_REDIRECTS} 次`);
        }
        target = new URL(location, guard.url).href;
        continue;
      }

      // 不回显上游响应体：那会变成一个探测内网服务的回显通道，
      // 状态码本身已经够排障了。
      if (!resp.ok) {
        throw new Error(`Failed to fetch subscription: ${resp.status} ${resp.statusText}`);
      }

      content = await readBodyLimited(resp, MAX_SUBSCRIPTION_BYTES, '源订阅');
    } catch (e) {
      if (e && e.name === 'AbortError') {
        throw new Error(`获取源订阅超时（超过 ${FETCH_TIMEOUT_MS / 1000} 秒）`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
    break;
  }

  if (!content || !content.trim()) {
    throw new Error('Subscription content is empty');
  }

  // Capture subscription metadata from the source response. Standard proxy
  // providers report traffic usage and expiry via the `Subscription-Userinfo`
  // header; some also expose a management page via `profile-web-page-url`.
  // Re-emitting these on our own output keeps the information intact after
  // conversion instead of being discarded.
  const headers = {};
  const userInfo = resp.headers.get('Subscription-Userinfo');
  if (userInfo) headers.userInfo = userInfo;
  const webPageUrl = resp.headers.get('profile-web-page-url');
  if (webPageUrl) headers.webPageUrl = webPageUrl;

  return { content, headers };
}

/**
 * Convert subscription content from one format to another.
 * @param {string} content - Raw subscription content
 * @param {string} targetFormat - Target output format
 * @param {object} options - Additional options
 * @returns {{content: string, contentType: string, sourceFormat: string, nodeCount: number}}
 */
export function convertSubscription(content, targetFormat, options = {}) {
  // Auto-detect and parse source format
  const { nodes, format: sourceFormat, meta } = parseSubscription(content);

  if (nodes.length === 0) {
    throw new Error(`No proxy nodes found in subscription (detected format: ${sourceFormat})`);
  }

  // Generate target format, threading the source config (rules / proxy groups /
  // dns / clash-api) so we preserve them instead of overwriting with defaults.
  const { content: output, contentType } = generateSubscription(nodes, targetFormat, { ...options, meta });

  return {
    content: output,
    contentType,
    sourceFormat,
    nodeCount: nodes.length,
  };
}

/**
 * Full conversion pipeline: fetch → parse → convert.
 * Fetches the source subscription and converts it to the target format.
 *
 * 这里刻意不写任何 KV：订阅链接是高频只读路径，任何对 links:all 的写入
 * 都要"读全量 → 改一条 → 写回全量"，而 KV 既没有事务又是最终一致的，
 * 并发下会整份覆盖，把刚创建的链接丢掉。
 *
 * @param {KVNamespace} kv
 * @param {string} path - Custom path of the link
 * @returns {Promise<{content: string, contentType: string, nodeCount: number, sourceFormat: string}>}
 */
export async function processSubscriptionRequest(kv, path) {
  // Get link config from KV
  const link = await getLink(kv, path);
  if (!link) {
    return { error: 404, message: 'Subscription link not found' };
  }

  // Fetch source subscription
  let sourceContent;
  let sourceHeaders = {};
  try {
    const fetched = await fetchSubscription(link.sourceUrl, link.userAgent);
    sourceContent = fetched.content;
    sourceHeaders = fetched.headers;
  } catch (e) {
    return { error: 502, message: `Failed to fetch source: ${e.message}` };
  }

  // Convert
  let result;
  try {
    result = convertSubscription(sourceContent, link.targetFormat, { name: link.name });
  } catch (e) {
    return { error: 500, message: `Conversion failed: ${e.message}` };
  }

  return {
    content: result.content,
    contentType: result.contentType,
    nodeCount: result.nodeCount,
    sourceFormat: result.sourceFormat,
    userInfo: sourceHeaders.userInfo || null,
    webPageUrl: sourceHeaders.webPageUrl || null,
  };
}
