import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'
import Redis from 'ioredis'
import siteConfig from '../../config/site.config'

export const RUNTIME_CONFIG_KEY = `${siteConfig.kvPrefix}runtime:config`
export const CONFIG_AUDIT_KEY = `${siteConfig.kvPrefix}admin:config:audit`

export const RUNTIME_CONFIG_KEYS = [
  'TIANYI_USERNAME',
  'TIANYI_PASSWORD',
  'ADMIN_PASSWORD',
  'CLIENT_ID',
  'CLIENT_SECRET',
  'USER_PRINCIPAL_NAME',
  'BASE_DIRECTORY',
  'DEFAULT_FOLDER_ID',
  'NEXT_PUBLIC_SITE_TITLE',
  'NEXT_PUBLIC_EMAIL',
  'PROTECTED_TOKEN_SECRET',
  'WEBDAV_WORKER_SECRET',
  'P123_USERNAME',
  'P123_PASSWORD',
] as const

export type RuntimeConfigKey = (typeof RUNTIME_CONFIG_KEYS)[number]

const SENSITIVE_KEYS = new Set<RuntimeConfigKey>([
  'TIANYI_USERNAME',
  'TIANYI_PASSWORD',
  'ADMIN_PASSWORD',
  'CLIENT_SECRET',
  'PROTECTED_TOKEN_SECRET',
  'WEBDAV_WORKER_SECRET',
  'P123_USERNAME',
  'P123_PASSWORD',
])

let redis: Redis | null = null
try {
  if (process.env.REDIS_URL) {
    redis = new Redis(process.env.REDIS_URL, {
      retryStrategy: times => (times > 2 ? null : Math.min(times * 200, 1000)),
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      lazyConnect: false,
    })
  }
} catch {
  redis = null
}

function encryptionKey(): Buffer {
  const secret = process.env.CONFIG_MASTER_KEY?.trim()
  if (!secret) throw new Error('CONFIG_MASTER_KEY 未配置')
  return createHash('sha256').update(secret).digest()
}

function encrypt(value: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${ciphertext.toString('base64url')}`
}

function decrypt(value: string): string {
  const [version, ivText, tagText, ciphertextText] = value.split(':')
  if (version !== 'v1' || !ivText || !tagText || !ciphertextText) throw new Error('配置密文格式无效')
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivText, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(ciphertextText, 'base64url')), decipher.final()]).toString('utf8')
}

function envValue(key: RuntimeConfigKey): string {
  return process.env[key] || ''
}

function assertKey(key: string): asserts key is RuntimeConfigKey {
  if (!(RUNTIME_CONFIG_KEYS as readonly string[]).includes(key)) throw new Error(`不支持的配置项: ${key}`)
}

export async function getRuntimeConfigValue(key: RuntimeConfigKey): Promise<string> {
  try {
    const encrypted = redis ? await redis.hget(RUNTIME_CONFIG_KEY, key) : null
    if (encrypted) return decrypt(encrypted)
  } catch (error) {
    console.error(`[runtimeConfig] 读取 ${key} 失败:`, error instanceof Error ? error.message : error)
  }
  return envValue(key)
}

export async function setRuntimeConfig(values: Record<string, unknown>): Promise<void> {
  if (!redis) throw new Error('Redis 不可用')
  const entries = Object.entries(values)
  for (const [key, value] of entries) {
    assertKey(key)
    if (typeof value !== 'string' || value.length > 4096) throw new Error(`配置项 ${key} 无效`)
    if (value === '') {
      await redis.hdel(RUNTIME_CONFIG_KEY, key)
    } else {
      await redis.hset(RUNTIME_CONFIG_KEY, key, encrypt(value))
    }
  }
  await redis.hset(RUNTIME_CONFIG_KEY, '_updatedAt', String(Date.now()))
}

export async function getRuntimeConfigMetadata() {
  const stored = redis ? await redis.hgetall(RUNTIME_CONFIG_KEY) : {}
  return {
    redisConfigured: Boolean(redis),
    masterKeyConfigured: Boolean(process.env.CONFIG_MASTER_KEY),
    updatedAt: stored._updatedAt ? Number(stored._updatedAt) : null,
    values: await Promise.all(RUNTIME_CONFIG_KEYS.map(async key => ({
      key,
      sensitive: SENSITIVE_KEYS.has(key),
      configured: Boolean(stored[key] || envValue(key)),
      source: stored[key] ? 'runtime' : envValue(key) ? 'environment' : 'unset',
      value: SENSITIVE_KEYS.has(key) ? undefined : stored[key] ? await getRuntimeConfigValue(key) : envValue(key),
    }))),
  }
}

export function isSensitiveRuntimeConfigKey(key: RuntimeConfigKey): boolean {
  return SENSITIVE_KEYS.has(key)
}

export function generateRuntimeSecret(bytes = 32): string {
  return randomBytes(bytes).toString('hex')
}

export interface ConfigAuditEntry {
  timestamp: number
  action: string
  key?: string
  oldValue?: string
  newValue?: string
  admin?: string
}

export async function recordConfigAudit(entry: Omit<ConfigAuditEntry, 'timestamp'>) {
  try {
    if (!redis) return
    const log: ConfigAuditEntry = { timestamp: Date.now(), ...entry }
    await redis.lpush(CONFIG_AUDIT_KEY, JSON.stringify(log))
    await redis.ltrim(CONFIG_AUDIT_KEY, 0, 199)
  } catch (error) {
    console.error('[runtimeConfig] 审计日志写入失败:', error instanceof Error ? error.message : error)
  }
}

export async function getConfigAuditLogs(limit = 50) {
  try {
    if (!redis) return []
    const raw = await redis.lrange(CONFIG_AUDIT_KEY, 0, Math.max(1, limit) - 1)
    return raw.map(item => {
      try {
        return JSON.parse(item) as ConfigAuditEntry
      } catch {
        return null
      }
    }).filter(Boolean) as ConfigAuditEntry[]
  } catch (error) {
    console.error('[runtimeConfig] 审计日志读取失败:', error instanceof Error ? error.message : error)
    return []
  }
}

export async function invalidateConfigCaches(admin = 'admin') {
  const results: string[] = []
  try {
    if (!redis) throw new Error('Redis 不可用')
    const patterns = [
      `${siteConfig.kvPrefix}ty:session:*`,
      `${siteConfig.kvPrefix}od:token:*`,
      `${siteConfig.kvPrefix}admin:session:*`,
      `${siteConfig.kvPrefix}protected:token:*`,
      `rate_limit:*`,
    ]
    for (const pattern of patterns) {
      let cursor = '0'
      let count = 0
      while (cursor !== '0') {
        const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', '100')
        cursor = next
        if (keys.length) {
          await redis.del(...keys)
          count += keys.length
        }
      }
      results.push(`${pattern}:${count}`)
    }
    await recordConfigAudit({ action: 'invalidate-cache', admin })
  } catch (error) {
    console.error('[runtimeConfig] 缓存失效失败:', error instanceof Error ? error.message : error)
    throw error
  }
  return results
}

export async function testRuntimeConfigConnections() {
  const results: Record<string, { ok: boolean; message?: string }> = {}
  try {
    if (!redis) throw new Error('Redis 未配置')
    await redis.ping()
    results.redis = { ok: true, message: 'Redis 连接正常' }
  } catch (error: any) {
    results.redis = { ok: false, message: error?.message || 'Redis 连接失败' }
  }

  const tianyiUsername = await getRuntimeConfigValue('TIANYI_USERNAME')
  const tianyiPassword = await getRuntimeConfigValue('TIANYI_PASSWORD')
  if (tianyiUsername && tianyiPassword) {
    try {
      const { cloud189Login } = await import('./tianyiAuth')
      const loginResult = await cloud189Login(tianyiUsername, tianyiPassword)
      if (loginResult.status === 'success' && loginResult.data?.cookies) {
        results.tianyi = { ok: true, message: '天翼云登录正常' }
      } else {
        results.tianyi = { ok: false, message: loginResult.message || '天翼云登录失败' }
      }
    } catch (error: any) {
      results.tianyi = { ok: false, message: error?.message || '天翼云登录异常' }
    }
  } else {
    results.tianyi = { ok: false, message: '未配置天翼云账号' }
  }

  const clientId = await getRuntimeConfigValue('CLIENT_ID')
  const clientSecret = await getRuntimeConfigValue('CLIENT_SECRET')
  if (clientId && clientSecret) {
    // 有凭据时做一次真实校验：能否拿到 access token 并访问 drive 根
    try {
      const { getAccessToken } = await import('../pages/api/od/index')
      const accessToken = await getAccessToken()
      if (!accessToken) {
        results.onedrive = { ok: false, message: 'OneDrive 未授权或 token 刷新失败' }
      } else {
        results.onedrive = { ok: true, message: 'OneDrive 连接正常（token 有效）' }
      }
    } catch (error: any) {
      results.onedrive = { ok: false, message: error?.message || 'OneDrive 连接失败' }
    }
  } else {
    results.onedrive = { ok: false, message: '未配置 OneDrive 凭据' }
  }

  const p123Username = await getRuntimeConfigValue('P123_USERNAME')
  const p123Password = await getRuntimeConfigValue('P123_PASSWORD')
  if (p123Username && p123Password) {
    try {
      const { testPan123Connection } = await import('./pan123Client')
      results.p123 = await testPan123Connection()
    } catch (error: any) {
      results.p123 = { ok: false, message: error?.message || '123 云盘连接异常' }
    }
  } else {
    results.p123 = { ok: false, message: '未配置 123 云盘账号' }
  }

  return results
}
