interface Env {
  WEBDAV_WORKER_SECRET: string
  /** 可选：回源地址覆盖（默认 https://pan.xiegao.top），便于本地联调 */
  UPSTREAM_ORIGIN?: string
}

const DEFAULT_UPSTREAM_ORIGIN = 'https://pan.xiegao.top'
const FORWARDED_HEADERS = [
  'accept',
  'authorization',
  'content-type',
  'depth',
  'if',
  'lock-token',
  'range',
  'timeout',
  'user-agent',
]
const PASSWORD_CACHE_TTL_MS = 5 * 60_000
/** 上游最多内部跟随的重定向次数（Next.js trailingSlash 会产生 308） */
const MAX_REDIRECT_HOPS = 3
const passwordCache = new Map<string, number>()

function getUpstreamOrigin(env: Env): string {
  return (env.UPSTREAM_ORIGIN || DEFAULT_UPSTREAM_ORIGIN).replace(/\/+$/, '')
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'WWW-Authenticate': 'Basic realm="WebDAV"',
    },
  })
}

function getBasicCredentials(request: Request): { username: string; password: string } | null {
  const authorization = request.headers.get('Authorization')
  if (!authorization?.startsWith('Basic ')) return null

  try {
    const decoded = atob(authorization.slice(6).trim())
    const separator = decoded.indexOf(':')
    if (separator < 0) return null
    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    }
  } catch {
    return null
  }
}

async function sign(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))
  const bytes = new Uint8Array(signature)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

async function passwordCacheKey(password: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password))
  const bytes = new Uint8Array(digest)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

async function isValidAdminPassword(password: string, origin: string): Promise<boolean> {
  const cacheKey = await passwordCacheKey(password)
  if ((passwordCache.get(cacheKey) || 0) > Date.now()) {
    return true
  }

  try {
    const response = await fetch(new URL('/api/auth/login/', origin), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        Referer: `${origin}/@login`,
      },
      body: JSON.stringify({ password }),
      redirect: 'manual',
    })
    if (response.status !== 200) return false

    passwordCache.set(cacheKey, Date.now() + PASSWORD_CACHE_TTL_MS)
    return true
  } catch {
    return false
  }
}

function toDavPath(pathname: string): string | null {
  if (pathname === '/') return '/dav/'
  if (pathname !== '/dav' && !pathname.startsWith('/dav/')) {
    return `/dav${pathname}`
  }
  return pathname === '/dav' ? '/dav/' : pathname
}

/**
 * 把上游（Vercel）路径映射回 Worker 的 dav 路径空间，无法映射时返回 null。
 * 例如 /api/dav/OneDrive/ -> /dav/OneDrive/
 */
function davPathFromUpstreamPathname(pathname: string): string | null {
  if (pathname === '/api/dav') return '/dav/'
  if (pathname.startsWith('/api/dav/')) return '/dav' + pathname.slice('/api/dav'.length)
  return null
}

/**
 * 把内部 dav 空间路径转成对客户端暴露的形式。
 * 对外命名空间以 / 为根（/天翼云盘/*、/OneDrive/*），
 * /dav 只是 Worker 内部映射前缀，绝不能出现在返回给客户端的 URL 里。
 * 例如 /dav/OneDrive/ -> /OneDrive/，/dav/ -> /
 */
function externalFromDavPath(davPath: string): string {
  if (davPath === '/dav' || davPath === '/dav/') return '/'
  return davPath.slice('/dav'.length)
}

function getOriginUrl(origin: string, davPath: string, search: string): URL {
  const davPrefix = '/dav'
  const suffix = davPath === davPrefix ? '/' : davPath.slice(davPrefix.length)
  return new URL(`/api/dav${suffix}${search}`, origin)
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const origin = getUpstreamOrigin(env)
    const workerPath = toDavPath(url.pathname)
    if (!workerPath) {
      return new Response('Not found', { status: 404 })
    }

    if (request.method !== 'OPTIONS') {
      const credentials = getBasicCredentials(request)
      if (!credentials || credentials.username !== 'admin' || !(await isValidAdminPassword(credentials.password, origin))) {
        return unauthorized()
      }
    }

    // 缓冲请求体：跟随重定向重放时需要复用（PROPFIND 的请求体通常只有几 KB）
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
    const bodyBuffer = hasBody ? await request.arrayBuffer() : undefined

    /**
     * 在 Worker 内部跟随上游重定向，而不是把 3xx 原样丢给客户端：
     * - 很多 WebDAV 客户端不会对 PROPFIND 跟随重定向；
     * - 即便跟随，Next.js 返回的 Location 指向源站域名，
     *   客户端跳过去后丢失 Worker 签名/认证，最终表现为 401/404。
     */
    let currentDavPath = workerPath
    let currentSearch = url.search
    let upstream: Response | null = null

    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
      const timestamp = String(Date.now())
      const signaturePayload = `${timestamp}\n${request.method}\n${currentDavPath}`
      const headers = new Headers()
      for (const name of FORWARDED_HEADERS) {
        const value = request.headers.get(name)
        if (value) headers.set(name, value)
      }
      headers.set('X-WebDAV-Worker-Time', timestamp)
      headers.set('X-WebDAV-Worker-Path', currentDavPath)
      headers.set('X-WebDAV-Worker-Signature', await sign(signaturePayload, env.WEBDAV_WORKER_SECRET))

      upstream = await fetch(getOriginUrl(origin, currentDavPath, currentSearch), {
        method: request.method,
        headers,
        body: bodyBuffer,
        redirect: 'manual',
      })

      if (!isRedirect(upstream.status)) break

      const location = upstream.headers.get('location')
      if (!location) break
      const next = new URL(location, getOriginUrl(origin, currentDavPath, currentSearch))
      const mapped = next.origin === origin ? davPathFromUpstreamPathname(next.pathname) : null
      if (!mapped) break
      currentDavPath = mapped
      currentSearch = next.search
    }

    if (!upstream) {
      return new Response('Upstream fetch failed', { status: 502 })
    }

    const responseHeaders = new Headers(upstream.headers)
    responseHeaders.set('Cache-Control', 'no-store')
    responseHeaders.delete('Set-Cookie')

    // 兜底：仍有未跟随的 3xx 时，把 Location 改写成对外的根命名空间形式
    // （不带 /dav 内部前缀），且绝不把源站域名泄漏给客户端
    if (isRedirect(upstream.status) && responseHeaders.has('location')) {
      try {
        const location = responseHeaders.get('location') as string
        const next = new URL(location, getOriginUrl(origin, currentDavPath, currentSearch))
        const mapped = next.origin === origin ? davPathFromUpstreamPathname(next.pathname) : null
        if (mapped) {
          responseHeaders.set('location', `${externalFromDavPath(mapped)}${next.search}`)
        } else {
          responseHeaders.delete('location')
        }
      } catch {
        responseHeaders.delete('location')
      }
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    })
  },
}
