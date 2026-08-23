import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'
import Redis from 'ioredis'
import siteConfig from '../../config/site.config'

export const RUNTIME_CONFIG_KEY = `${siteConfig.kvPrefix}runtime:config`

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
] as const

export type RuntimeConfigKey = (typeof RUNTIME_CONFIG_KEYS)[number]

const SENSITIVE_KEYS = new Set<RuntimeConfigKey>([
  'TIANYI_USERNAME',
  'TIANYI_PASSWORD',
  'ADMIN_PASSWORD',
  'CLIENT_SECRET',
  'PROTECTED_TOKEN_SECRET',
  'WEBDAV_WORKER_SECRET',
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
