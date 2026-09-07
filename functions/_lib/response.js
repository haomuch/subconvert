/** Shared response helpers for API endpoints */

/**
 * 所有响应都不输出 CORS 头。
 * 本项目前端和接口同源（同一个域名），本来就用不到跨域；
 * 放开跨域会让任意第三方网页的脚本都能读取你的链接列表和订阅内容。
 */
export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...extraHeaders,
    },
  });
}

export function text(content, contentType = 'text/plain; charset=utf-8', status = 200) {
  return new Response(content, {
    status,
    headers: {
      'Content-Type': contentType,
    },
  });
}

export function error(message, status = 400, extraHeaders = {}) {
  return json({ error: message }, status, extraHeaders);
}

/**
 * 回应 OPTIONS 预检。
 * 不返回任何 CORS 头，所以跨源请求会被浏览器直接拦下 —— 这正是我们想要的。
 * 同源请求不会触发预检，因此不影响自身功能。
 */
export function handleCORS() {
  return new Response(null, { status: 204 });
}
