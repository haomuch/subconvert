/**
 * Utility functions for base64 encoding/decoding with UTF-8 support
 * and URL-safe base64 variants used by proxy protocols.
 */

/** Standard base64 encode with UTF-8 support */
export function b64Encode(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Standard base64 decode with UTF-8 support */
export function b64Decode(str) {
  try {
    const binary = atob(str.trim().replace(/\s/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** URL-safe base64 encode (no padding, - and _ instead of + and /) */
export function b64UrlEncode(str) {
  return b64Encode(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** URL-safe base64 decode */
export function b64UrlDecode(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return b64Decode(s);
}

/**
 * Try to decode a string that might be base64 encoded.
 * Returns the decoded string if it looks like valid base64, otherwise null.
 */
export function tryBase64Decode(str) {
  const trimmed = str.trim();
  // Check if it looks like base64 (no whitespace, valid chars, correct length)
  if (!/^[A-Za-z0-9+/\-_]+={0,2}$/.test(trimmed.replace(/\s/g, ''))) return null;
  // b64UrlDecode also handles standard base64 and missing padding, so it
  // correctly decodes url-safe (-/_) and unpadded subscriptions too.
  const decoded = b64UrlDecode(trimmed);
  if (decoded && /:\/\//.test(decoded)) return decoded;
  return null;
}

/** Parse a URL's query string into an object */
export function parseQueryString(qs) {
  const params = {};
  if (!qs) return params;
  const searchParams = new URLSearchParams(qs.startsWith('?') ? qs.slice(1) : qs);
  for (const [k, v] of searchParams) params[k] = v;
  return params;
}

/** Decode a URL fragment (used for node names in proxy URIs) */
export function decodeName(fragment) {
  if (!fragment) return '';
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

/** Encode a node name for use in a URL fragment */
export function encodeName(name) {
  if (!name) return '';
  return encodeURIComponent(name);
}

/** Sanitize a path for use as a custom URL path */
export function sanitizePath(path) {
  if (!path) return '';
  // Remove leading/trailing slashes, keep only safe characters
  let cleaned = path.replace(/^\/+|\/+$/g, '');
  // Replace spaces with hyphens, remove dangerous characters.
  // 不允许 "/" 和 "."：前者让生成的 URL 多出一级路由而必然 404，
  // 后者会产生 "." / ".." 这类畸形路径。
  cleaned = cleaned.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9\-_]/g, '');
  return cleaned;
}

// ─── SSRF 防护：出网地址校验 ────────────────────────────────

/**
 * 不允许出网请求打到的保留 / 私有 IPv4 网段。
 * 源订阅 URL 由用户填写，若不加限制，服务端就成了任意地址的抓取代理
 * （云元数据 169.254.169.254、内网 10/8 等）。
 */
const BLOCKED_V4 = [
  ['0.0.0.0', 8],        // "this network"
  ['10.0.0.0', 8],       // 私有
  ['100.64.0.0', 10],    // CGNAT
  ['127.0.0.0', 8],      // 回环
  ['169.254.0.0', 16],   // 链路本地 / 云元数据
  ['172.16.0.0', 12],    // 私有
  ['192.168.0.0', 16],   // 私有
  ['198.18.0.0', 15],    // 基准测试
  ['224.0.0.0', 4],      // 组播
  ['240.0.0.0', 4],      // 保留 / 广播
];

/** 指向内部的主机名（含常见云元数据域名） */
const BLOCKED_HOSTS = ['localhost', 'metadata.google.internal', 'instance-data', 'metadata'];
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.internal', '.local', '.home.arpa'];

function v4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

function inBlockedV4(ip) {
  const n = v4ToInt(ip);
  if (n === null) return false;
  return BLOCKED_V4.some(([base, bits]) => {
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    return (n & mask) === (v4ToInt(base) & mask);
  });
}

/** 把 IPv6 字面量展开成 8 个 16 位组；解析不了返回 null */
function expandV6(h) {
  if (h.indexOf('::') !== h.lastIndexOf('::')) return null; // 只允许出现一次 ::
  const compressed = h.includes('::');
  const [head, tail = ''] = compressed ? h.split('::') : [h];
  const hp = head.split(':').filter(Boolean);
  const tp = tail.split(':').filter(Boolean);
  const total = hp.length + tp.length;
  if (compressed ? total > 7 : total !== 8) return null;

  const groups = [...hp, ...Array(8 - total).fill('0'), ...tp];
  const nums = groups.map(g => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return nums.some(Number.isNaN) ? null : nums;
}

/** IPv6 字面量（可带方括号）是否属于保留地址 */
function isBlockedV6(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  const g = expandV6(h);
  if (!g) return false;

  const allZero = g.every(x => x === 0);
  if (allZero) return true;                 // ::
  if (g.slice(0, 7).every(x => x === 0) && g[7] === 1) return true; // ::1

  // ::ffff:a.b.c.d / ::ffff:7f00:1 —— WHATWG URL 会把前者规范化成后者
  if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) {
    const v4 = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
    return inBlockedV4(v4);
  }
  // IPv4-compatible ::a.b.c.d（已废弃，但仍可能被拿来绕过）
  if (g.slice(0, 6).every(x => x === 0)) {
    const v4 = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
    return inBlockedV4(v4);
  }

  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 唯一本地
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 链路本地
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 组播
  return false;
}

/**
 * 校验一个 URL 是否可以安全地由服务端发起请求。
 *
 * 注意：WHATWG URL 解析会把 http://2130706433/ 这类十进制写法规范化成
 * 127.0.0.1，所以只看规范化后的 hostname 就能覆盖各种绕过写法。
 * 仍挡不住 DNS rebinding（域名解析到内网 IP），Workers 环境下无法在
 * 发起请求前做 DNS 解析，只能靠源订阅地址本身可信来兜底。
 *
 * @returns {{ok: true, url: URL} | {ok: false, reason: string}}
 */
export function validatePublicUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return { ok: false, reason: '不是合法的 URL' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `不支持的协议：${url.protocol}` };
  }

  const host = url.hostname;
  if (!host) return { ok: false, reason: '缺少主机名' };

  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTS.includes(h) || BLOCKED_HOST_SUFFIXES.some(s => h.endsWith(s))) {
    return { ok: false, reason: `主机名 ${host} 指向内部网络` };
  }

  if (host.includes(':') ? isBlockedV6(host) : inBlockedV4(h)) {
    return { ok: false, reason: `地址 ${host} 属于保留 / 私有网段` };
  }

  return { ok: true, url };
}

/** Generate a random short ID */
export function generateId(length = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  for (const b of bytes) result += chars[b % chars.length];
  return result;
}
