import Redis from 'ioredis'
import siteConfig from '../../config/site.config'

/**
 * 基于 Redis INCR + EXPIRE 的分布式限流。
 *
 * 替代原 /api/auth/login 中的内存 Map 限流：
 * - 内存限流在 serverless 多实例下为近似值（每实例独立计数）；
 * - Redis 限流全局共享计数，并能跨实例生效。
 *
 * 容错策略：普通业务调用可在 Redis 不可用时降级放行；认证入口可显式要求 fail-closed，
 * 避免 Redis 故障时管理员密码限流完全失效。
 */

let kv: Redis | null = null
let initError: string | null = null

try {
  if (process.env.REDIS_URL) {
    kv = new Redis(process.env.REDIS_URL, {
      retryStrategy: times => (times > 2 ? null : Math.min(times * 200, 1000)),
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      lazyConnect: false,
    })
  } else {
    initError = 'REDIS_URL 未配置'
  }
} catch (e: any) {
  initError = `Redis 初始化失败: ${e?.message || '未知错误'}`
  kv = null
}

const PREFIX = `${siteConfig.kvPrefix}ratelimit:`

export interface RateLimitResult {
  /** 是否允许通过 */
  allowed: boolean
  /** 当前窗口内已使用次数 */
  count: number
  /** 触发限流时建议的重试等待秒数（用于 Retry-After 头） */
  retryAfter: number
  /** Redis 是否真实生效（false 表示降级放行） */
  enforced: boolean
}

/**
 * 检查是否允许通过限流。
 *
 * 实现要点：
 * - INCR 是原子的，第一次访问时 count=1，此时设置 EXPIRE；
 * - 即使 INCR 之后 EXPIRE 失败（网络/重启），key 也会自然过期内存回收，
 *   不会永久卡死用户；
 * - 不用 Lua 脚本：INCR + EXPIRE 两步在极少数并发场景下窗口可能略长，
 *   对登录限流这种粗粒度场景可接受，换取更简单的实现与更好的 Upstash 兼容性。
 *
 * @param key 限流维度标识（如 `login:ip:1.2.3.4`）
 * @param max 窗口内最大允许次数
 * @param windowSec 窗口大小（秒）
 */
export async function checkRateLimit(
  key: string,
  max: number,
  windowSec: number,
  failClosed = false,
): Promise<RateLimitResult> {
  if (!kv) {
    // Authentication callers can reject while the shared limiter is unavailable.
    return failClosed
      ? { allowed: false, count: 0, retryAfter: windowSec, enforced: false }
      : { allowed: true, count: 0, retryAfter: 0, enforced: false }
  }
  try {
    const k = `${PREFIX}${key}`
    const count = await kv.incr(k)
    if (count === 1) {
      // 第一次访问，设置过期时间。即使后续 EXPIRE 失败，下一次 incr 仍会重试 expire。
      await kv.expire(k, windowSec)
    }
    if (count > max) {
      const ttl = await kv.ttl(k)
      return {
        allowed: false,
        count,
        retryAfter: ttl > 0 ? ttl : windowSec,
        enforced: true,
      }
    }
    return { allowed: true, count, retryAfter: 0, enforced: true }
  } catch {
    // Authentication callers reject on Redis errors; ordinary callers preserve availability.
    return failClosed
      ? { allowed: false, count: 0, retryAfter: windowSec, enforced: false }
      : { allowed: true, count: 0, retryAfter: 0, enforced: false }
  }
}

export function getRateLimiterStatus(): { initialized: boolean; error: string | null } {
  return { initialized: Boolean(kv), error: initError }
}
