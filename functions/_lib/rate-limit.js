/**
 * 登录失败限流（防暴力破解密码）。
 *
 * 计数必须存在服务端（KV），不能放在浏览器里：放浏览器的话，刷新页面、
 * 换个浏览器、开个无痕窗口计数就清零了，等于没锁。
 *
 * 按来源 IP 记录：同一个 IP 连续输错 MAX_FAILURES 次，就锁 LOCKOUT_MS。
 *
 * 说明：换 IP（代理池）可以绕过限流，所以它只是"把试密码的成本抬高
 * 几百倍"，不是绝对防线。真正兜底的还是密码本身够强。
 */

const PREFIX = 'ratelimit:';

/** 连续失败多少次后锁定 */
const MAX_FAILURES = 5;
/** 锁定时长 */
const LOCKOUT_MS = 10 * 60 * 1000;
/** 未锁定时，失败计数的保留时长（过期自动清理，避免 KV 里堆垃圾） */
const COUNTER_TTL_SECONDS = 30 * 60;

/**
 * 取客户端 IP。
 * CF-Connecting-IP 由 Cloudflare 注入，不可伪造，优先用它；
 * X-Forwarded-For 只在没有前者时兜底（本地开发时通常为空）。
 */
export function getClientIP(request) {
  const cf = request.headers.get('CF-Connecting-IP');
  if (cf) return cf.trim();
  const xff = request.headers.get('X-Forwarded-For') || '';
  const first = xff.split(',')[0].trim();
  return first || 'unknown';
}

async function readRecord(kv, key) {
  try {
    const raw = await kv.get(key);
    if (!raw) return null;
    const rec = JSON.parse(raw);
    return rec && typeof rec === 'object' ? rec : null;
  } catch {
    return null;
  }
}

/**
 * 查询某个 IP 当前是否处于锁定状态。
 * @returns {{locked: boolean, retryAfter: number}} retryAfter 为剩余秒数
 */
export async function getLockout(kv, ip) {
  if (!kv) return { locked: false, retryAfter: 0 };

  const rec = await readRecord(kv, PREFIX + ip);
  if (!rec || !rec.lockedUntil) return { locked: false, retryAfter: 0 };

  const remaining = rec.lockedUntil - Date.now();
  if (remaining <= 0) return { locked: false, retryAfter: 0 };
  return { locked: true, retryAfter: Math.ceil(remaining / 1000) };
}

/**
 * 记录一次失败。达到阈值时转为锁定。
 * @returns {{locked: boolean, retryAfter: number, attemptsLeft: number}}
 */
export async function recordFailure(kv, ip) {
  if (!kv) return { locked: false, retryAfter: 0, attemptsLeft: MAX_FAILURES };

  const key = PREFIX + ip;
  const rec = (await readRecord(kv, key)) || { count: 0 };
  rec.count = (rec.count || 0) + 1;

  if (rec.count >= MAX_FAILURES) {
    rec.count = 0;
    rec.lockedUntil = Date.now() + LOCKOUT_MS;
    const retryAfter = Math.ceil(LOCKOUT_MS / 1000);
    // 到期自动删除，不用手动清理
    await kv.put(key, JSON.stringify(rec), { expirationTtl: retryAfter });
    return { locked: true, retryAfter, attemptsLeft: 0 };
  }

  await kv.put(key, JSON.stringify(rec), { expirationTtl: COUNTER_TTL_SECONDS });
  return { locked: false, retryAfter: 0, attemptsLeft: MAX_FAILURES - rec.count };
}

/** 验证成功后清掉该 IP 的失败计数 */
export async function clearFailures(kv, ip) {
  if (!kv) return;
  try {
    await kv.delete(PREFIX + ip);
  } catch { /* 清理失败无所谓 */ }
}
