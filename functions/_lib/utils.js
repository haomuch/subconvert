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

/** Generate a random short ID */
export function generateId(length = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  for (const b of bytes) result += chars[b % chars.length];
  return result;
}
