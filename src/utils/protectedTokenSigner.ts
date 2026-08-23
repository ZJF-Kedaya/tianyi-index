import { createHmac, randomBytes } from 'crypto'
import { constantTimeEqual } from './constantTimeEqual'

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000

async function getSigningKey(): Promise<string> {
  // Use a dedicated key so rotating or exposing another application secret does
  // not invalidate OneDrive credentials or enable token forgery.
  const { getRuntimeConfigValue } = await import('./runtimeConfigStore')
  const runtimeSecret = await getRuntimeConfigValue('PROTECTED_TOKEN_SECRET')
  if (runtimeSecret) return runtimeSecret
  if (process.env.PROTECTED_TOKEN_SECRET) return process.env.PROTECTED_TOKEN_SECRET
  if (process.env.CRYPTO_SECRET) return process.env.CRYPTO_SECRET
  if (process.env.ADMIN_PASSWORD) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[protectedTokenSigner] 使用 ADMIN_PASSWORD 作为签名密钥。建议配置独立 PROTECTED_TOKEN_SECRET。')
    }
    return process.env.ADMIN_PASSWORD
  }
  return ''
}

export function isSignedToken(token: string): boolean {
  return token.length > 64 && token.includes('.')
}

export async function signProtectedToken(path: string): Promise<string | null> {
  const key = await getSigningKey()
  if (!key) return null

  const payload = JSON.stringify({
    v: 2,
    exp: Date.now() + TOKEN_TTL_MS,
    path,
    nonce: randomBytes(8).toString('hex'),
  })
  const sig = createHmac('sha256', key).update(payload).digest('base64url')
  return Buffer.from(payload).toString('base64url') + '.' + sig
}

export async function parseProtectedToken(token: string): Promise<{ path: string; valid: boolean }> {
  const dot = token.lastIndexOf('.')
  if (dot === -1) return { path: '', valid: false }

  const payloadB64 = token.slice(0, dot)
  const sig = token.slice(dot + 1)

  const key = await getSigningKey()
  if (!key) return { path: '', valid: false }

  const payloadStr = Buffer.from(payloadB64, 'base64url').toString()
  const expectedSig = createHmac('sha256', key).update(payloadStr).digest('base64url')
  if (!constantTimeEqual(sig, expectedSig)) return { path: '', valid: false }

  let data: any
  try {
    data = JSON.parse(payloadStr)
  } catch {
    return { path: '', valid: false }
  }

  if (data.v !== 2 || typeof data.exp !== 'number' || Date.now() > data.exp) return { path: '', valid: false }
  if (typeof data.path !== 'string') return { path: '', valid: false }

  return { path: data.path, valid: true }
}
