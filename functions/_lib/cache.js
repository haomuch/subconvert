/**
 * 订阅响应在边缘缓存里的 key 构造。
 *
 * 生成和失效（删除链接时）必须使用同一个 key，否则删掉链接后旧内容
 * 还会继续被返回。这里统一只保留 origin + /sub/{path}，忽略查询串，
 * 避免 ?a=1 / ?b=2 这类无意义参数造成同一份内容被缓存成多份。
 *
 * @param {string} origin - 例如 https://xxx.pages.dev
 * @param {string} path - 链接的自定义路径
 * @returns {Request} 可直接用于 cache.match / cache.put / cache.delete 的 key
 */
export function subscriptionCacheKey(origin, path) {
  return new Request(`${origin}/sub/${path}`);
}
