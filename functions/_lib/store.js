/**
 * KV storage helpers for managing conversion links.
 *
 * 存储结构：
 *   Key: "links:all"   → { v: 2, links: [ 全部链接记录 ] }   ← 唯一数据源
 *   Key: "link:{path}" → 单条记录（v1 旧格式，仅为兼容老数据保留）
 *
 * 为什么从"一条链接一个 key"改成"全部放一个 key"：
 * 旧做法是 kv.list() 拿 key 列表，再对每条 key 各发一次 kv.get()，
 * 列一次列表就是 1+N 次请求。平台对"单次访问最多能发多少个子请求"
 * 有硬限制（免费版约 50 次），链接攒到几十条时管理页就会直接报错打不开。
 * 现在一次读取就能拿到全部链接。
 */

const INDEX_KEY = 'links:all';
const PREFIX = 'link:';        // v1 遗留前缀
const META_PREFIX = 'meta:';   // v1 遗留前缀

/** 安全上限：避免单个 KV value 无限膨胀 */
const MAX_LINKS = 2000;

/**
 * 读取全部链接。
 * 老版本部署在首次调用时会把 v1 的 "link:{path}" 数据迁移到新结构。
 */
async function loadAll(kv) {
  const raw = await kv.get(INDEX_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      const links = Array.isArray(parsed) ? parsed : (parsed && parsed.links);
      if (Array.isArray(links)) return links;
    } catch { /* 数据损坏：落到下面的重建流程 */ }
  }

  // 首次运行，或来自 v1 的旧数据：扫描一次旧 key，之后都走 index。
  const legacy = await readLegacyLinks(kv);
  await saveAll(kv, legacy);
  return legacy;
}

/** 写回全部链接 */
async function saveAll(kv, links) {
  await kv.put(INDEX_KEY, JSON.stringify({ v: 2, links }));
}

/**
 * 扫描 v1 遗留的 "link:{path}" key。
 * 用 cursor 翻完全部页，分批并发读取，尽量降低触发子请求上限的概率。
 */
async function readLegacyLinks(kv) {
  const names = [];
  let cursor;
  try {
    do {
      const page = await kv.list(cursor ? { prefix: PREFIX, cursor } : { prefix: PREFIX });
      for (const k of page.keys || []) names.push(k.name);
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  } catch {
    return [];
  }

  const links = [];
  const BATCH = 20;
  for (let i = 0; i < names.length; i += BATCH) {
    const batch = names.slice(i, i + BATCH);
    const values = await Promise.all(batch.map(n => kv.get(n).catch(() => null)));
    for (const raw of values) {
      if (!raw) continue;
      try {
        const obj = JSON.parse(raw);
        if (obj && obj.customPath) links.push(obj);
      } catch { /* 跳过坏数据 */ }
    }
  }
  return links;
}

/**
 * Create or update a conversion link.
 * @param {KVNamespace} kv
 * @param {object} link - { sourceUrl, targetFormat, customPath, name }
 * @returns {Promise<object>} The stored link object
 */
export async function createLink(kv, link) {
  const links = await loadAll(kv);

  if (links.length >= MAX_LINKS) {
    throw new Error(`链接数量已达上限（${MAX_LINKS} 条），请先删除一些再创建`);
  }

  const now = Date.now();
  const record = {
    id: link.id || link.customPath,
    sourceUrl: link.sourceUrl,
    targetFormat: link.targetFormat,
    customPath: link.customPath,
    name: link.name || '',
    userAgent: link.userAgent || '',
    createdAt: now,
  };

  links.push(record);
  await saveAll(kv, links);
  return record;
}

/**
 * Get a conversion link by its custom path.
 * @param {KVNamespace} kv
 * @param {string} path
 * @returns {Promise<object|null>}
 */
export async function getLink(kv, path) {
  const links = await loadAll(kv);
  return links.find(l => l && l.customPath === path) || null;
}

/**
 * List all conversion links (newest first).
 * 现在只是一次 KV 读取，不再随链接数量线性增长请求数。
 * @param {KVNamespace} kv
 * @returns {Promise<Array>}
 */
export async function listLinks(kv) {
  const links = await loadAll(kv);
  return links.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/**
 * Delete a conversion link by its custom path.
 * @param {KVNamespace} kv
 * @param {string} path
 * @returns {Promise<boolean>}
 */
export async function deleteLink(kv, path) {
  const links = await loadAll(kv);
  const idx = links.findIndex(l => l && l.customPath === path);
  if (idx < 0) return false;

  links.splice(idx, 1);
  await saveAll(kv, links);

  // 清理 v1 遗留的 key（如果存在）
  await kv.delete(PREFIX + path).catch(() => {});
  await kv.delete(META_PREFIX + path).catch(() => {});
  return true;
}

/**
 * Check if a custom path already exists.
 * @param {KVNamespace} kv
 * @param {string} path
 * @returns {Promise<boolean>}
 */
export async function pathExists(kv, path) {
  const links = await loadAll(kv);
  return links.some(l => l && l.customPath === path);
}
