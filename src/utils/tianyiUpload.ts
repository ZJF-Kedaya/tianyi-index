/**
 * 天翼云盘上传（普通 189 网页协议，upload.cloud.189.cn 加密接口）。
 *
 * 协议流程（服务端只做"签名 + 会话管理"，字节流由客户端直传 CDN）：
 * 1. getSessionKey：从 cloud.189.cn 用户信息接口拿 SessionKey
 * 2. generateRsaKey：拿上传接口的 RSA 公钥（带过期缓存）
 * 3. uploadRequest(uri, form)：加密 GET 封装 ——
 *    params 按 key 排序拼串 → AES-128-ECB(随机密钥前16位) 得密文 hex；
 *    HMAC-SHA1(SessionKey 串 | 随机密钥) 得 Signature；
 *    随机密钥用 RSA PKCS#1 v1.5 加密放 EncryptionText 头
 * 4. /person/initMultiUpload → uploadFileId（fileDataExists=1 即秒传）
 * 5. /person/getMultiUploadUrls {partInfo: "n-{md5base64}"} → 分片直链
 * 6. /person/commitMultiUploadFile 提交（fileMd5/sliceMd5 大写 hex）
 */

import { createCipheriv, createHmac, createHash, publicEncrypt, randomUUID, constants } from 'crypto'

import { getOrCreateTianyiSession } from './tianyiSession'

const UPLOAD_BASE = 'https://upload.cloud.189.cn'

function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')
}

/** AES-128-ECB PKCS7 加密，输出 hex（天翼上传参数加密） */
function aes128EcbEncryptHex(text: string, key: string): string {
  const cipher = createCipheriv('aes-128-ecb', Buffer.from(key.slice(0, 16), 'utf8'), null)
  return Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]).toString('hex').toUpperCase()
}

interface RsaCache {
  pubKey: string
  pkId: string
  expire: number
}
let rsaCache: RsaCache | null = null

async function fetchWithCookies(url: string, cookies: Record<string, string>): Promise<any> {
  const res = await fetch(url, { headers: { Referer: 'https://cloud.189.cn/', Cookie: cookieHeader(cookies) } })
  if (!res.ok) throw new Error(`天翼云接口 HTTP ${res.status}`)
  return res.json()
}

export async function getSessionKey(cookies: Record<string, string>): Promise<string> {
  const data = await fetchWithCookies('https://cloud.189.cn/v2/getUserBriefInfo.action', cookies)
  const sessionKey = String(data?.sessionKey || '')
  if (!sessionKey) throw new Error('获取上传 SessionKey 失败')
  return sessionKey
}

/** SessionKey 进程内缓存（随天翼会话有效，5 分钟过期重新取） */
let cachedSessionKey: { key: string; expire: number } | null = null

/** 取当前登录态的 SessionKey（带进程内缓存） */
export async function currentSessionKey(): Promise<{ key: string; cookies: Record<string, string>; username: string; password: string }> {
  const session = await getOrCreateTianyiSession()
  if ('error' in session) throw new Error(session.error)
  if (cachedSessionKey && cachedSessionKey.expire > Date.now()) {
    return { key: cachedSessionKey.key, cookies: session.cookies, username: session.username, password: session.password }
  }
  const key = await getSessionKey(session.cookies)
  cachedSessionKey = { key, expire: Date.now() + 5 * 60_000 }
  return { key, cookies: session.cookies, username: session.username, password: session.password }
}

async function getRsaKey(cookies: Record<string, string>): Promise<RsaCache> {
  if (rsaCache && rsaCache.expire > Date.now()) return rsaCache
  const data = await fetchWithCookies('https://cloud.189.cn/api/security/generateRsaKey.action', cookies)
  const pubKey = String(data?.pubKey || '')
  const pkId = String(data?.pkId || '')
  if (!pubKey || !pkId) throw new Error('获取上传 RSA 公钥失败')
  rsaCache = { pubKey, pkId, expire: Number(data?.expire) || Date.now() + 5 * 60_000 }
  return rsaCache
}

/**
 * 调用 upload.cloud.189.cn 的加密 GET 接口。
 * 返回 JSON；业务失败（code !== 'SUCCESS'）抛错。
 */
async function uploadRequest<T = any>(uri: string, form: Record<string, string>, cookies: Record<string, string>, sessionKey: string): Promise<T> {
  const requestDate = String(Date.now())
  const requestId = randomUUID()
  const randomKeyLen = 16 + Math.floor(Math.random() * 17)
  const randomKey = randomUUID().replace(/-/g, 'x').slice(0, randomKeyLen)

  const params = Object.keys(form)
    .sort()
    .map(key => `${key}=${form[key]}`)
    .join('&')
  const encryptedParams = aes128EcbEncryptHex(params, randomKey)
  const signature = createHmac('sha1', randomKey)
    .update(`SessionKey=${sessionKey}&Operate=GET&RequestURI=${uri}&Date=${requestDate}&params=${encryptedParams}`)
    .digest('hex')

  const { pubKey, pkId } = await getRsaKey(cookies)
  const encryptionText = publicEncrypt(
    { key: `-----BEGIN PUBLIC KEY-----\n${pubKey}\n-----END PUBLIC KEY-----`, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(randomKey, 'utf8'),
  ).toString('base64')

  const res = await fetch(`${UPLOAD_BASE}${uri}?params=${encryptedParams}`, {
    method: 'GET',
    headers: {
      accept: 'application/json;charset=UTF-8',
      Referer: 'https://cloud.189.cn/',
      Cookie: cookieHeader(cookies),
      SessionKey: sessionKey,
      Signature: signature,
      'X-Request-Date': requestDate,
      'X-Request-ID': requestId,
      EncryptionText: encryptionText,
      PkId: pkId,
    },
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`天翼上传接口 HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  let data: any
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`天翼上传接口返回无效响应: ${text.slice(0, 200)}`)
  }
  if (data?.code !== 'SUCCESS') {
    throw new Error(String(data?.msg || data?.message || `天翼上传接口失败: ${uri}`))
  }
  return data as T
}

/** 解析目标目录路径为天翼 folderId（复用公共 resolveTianyiPath），返回可能刷新过的 cookies */
async function resolveFolderId(dirPath: string, username: string, password: string, cookies: Record<string, string>): Promise<{ folderId: string; cookies: Record<string, string> }> {
  if (dirPath === '/' || dirPath === '') return { folderId: '-11', cookies }
  const segments = dirPath.split('/').filter(Boolean)
  const { resolveTianyiPath } = await import('./tianyiPath')
  const result = await resolveTianyiPath(cookies, segments, username, password, '-11')
  if (result.status === 'not_found') throw new Error('目标目录不存在')
  if (result.status === 'need_refresh') {
    // 会话已自动重登过一次，这里直接返回新 cookies 让上层重取 SessionKey
    const retry = await resolveTianyiPath(result.cookies, segments, username, password, '-11')
    if (retry.status === 'ok' && retry.folderId) return { folderId: retry.folderId, cookies: retry.cookies }
    throw new Error('目标目录解析失败（会话失效）')
  }
  if (result.status !== 'ok' || !result.folderId) throw new Error('目标目录解析失败')
  return { folderId: result.folderId, cookies: result.cookies }
}

/** 上传会话信息（不透明地返回给前端保存，后续请求原样带回） */
export interface TianyiUploadSession {
  uploadFileId: string
  fileDataExists: boolean
  sliceSize: number
}

export async function initTianyiUpload(opts: {
  dirPath: string
  fileName: string
  fileSize: number
  fileMd5?: string
  sliceMd5?: string
}): Promise<{ session: TianyiUploadSession; folderId: string; cookies: Record<string, string>; sessionKey: string }> {
  const session = await getOrCreateTianyiSession()
  if ('error' in session) throw new Error(session.error)
  let sessionKey = await getSessionKey(session.cookies)

  // 解析目录（可能触发自动重登并刷新 cookies）
  let { folderId, cookies } = await resolveFolderId(opts.dirPath, session.username, session.password, session.cookies)
  if (cookies !== session.cookies && Object.keys(cookies).length > 0) {
    // cookies 被刷新，重新取 SessionKey 保证后续签名一致
    try {
      sessionKey = await getSessionKey(cookies)
    } catch {
      cookies = session.cookies
      sessionKey = await getSessionKey(session.cookies)
    }
  } else {
    cookies = session.cookies
  }

  // 天翼分片大小固定 10MB（协议约定值）
  const sliceSize = 10 * 1024 * 1024
  const baseParams: Record<string, string> = {
    parentFolderId: folderId,
    fileName: encodeURIComponent(opts.fileName).replace(/%20/g, '+'),
    fileSize: String(opts.fileSize),
    sliceSize: String(sliceSize),
  }

  const doInit = async (extra: Record<string, string>) => {
    return uploadRequest<{ data?: { uploadFileId?: string; fileDataExists?: string } }>(
      '/person/initMultiUpload',
      { ...baseParams, ...extra },
      cookies,
      sessionKey,
    )
  }

  let resp: { data?: { uploadFileId?: string; fileDataExists?: string } }
  try {
    // 先尝试带 MD5（可命中秒传）
    resp = await doInit({ fileMd5: opts.fileMd5 || '', sliceMd5: opts.sliceMd5 || '' })
  } catch (error: any) {
    const message = String(error?.message || error)
    // 内容安全审查拒绝/黑名单 MD5 时，按 OpenList 同款策略省略 MD5 延迟校验重试
    if (!/InfoSecurityErrorCode|black list|security check not pass/i.test(message)) throw error
    resp = await doInit({ lazyCheck: '1' })
  }

  const uploadFileId = String(resp.data?.uploadFileId || '')
  if (!uploadFileId) throw new Error('创建上传会话失败：缺少 uploadFileId')
  return {
    session: { uploadFileId, fileDataExists: String(resp.data?.fileDataExists || '0') === '1', sliceSize },
    folderId,
    cookies: session.cookies,
    sessionKey,
  }
}

/** 获取某个分片的直传地址（客户端 PUT 该地址，不经 Vercel） */
export async function getTianyiPartUrl(opts: {
  uploadFileId: string
  partNumber: number
  /** 分片内容的 MD5（Base64 编码，协议要求） */
  partMd5Base64: string
}, ctx: { cookies: Record<string, string>; sessionKey: string }): Promise<{ requestURL: string; headers?: Record<string, string> }> {
  const resp = await uploadRequest<{ uploadUrls?: Record<string, { requestURL?: string; headers?: Record<string, string> }> }>(
    '/person/getMultiUploadUrls',
    {
      partInfo: `${opts.partNumber}-${opts.partMd5Base64}`,
      uploadFileId: opts.uploadFileId,
    },
    ctx.cookies,
    ctx.sessionKey,
  )
  const part = resp.uploadUrls?.[`partNumber_${opts.partNumber}`]
  if (!part?.requestURL) {
    throw new Error(`获取第 ${opts.partNumber} 个分片上传地址失败`)
  }
  return { requestURL: part.requestURL, headers: part.headers }
}

/** 提交上传完成 */
export async function commitTianyiUpload(opts: { uploadFileId: string; fileMd5: string; sliceMd5: string }, ctx: { cookies: Record<string, string>; sessionKey: string }): Promise<void> {
  await uploadRequest(
    '/person/commitMultiUploadFile',
    {
      uploadFileId: opts.uploadFileId,
      fileMd5: opts.fileMd5.toUpperCase(),
      sliceMd5: opts.sliceMd5.toUpperCase(),
      lazyCheck: '1',
      isLog: '0',
      opertype: '3',
    },
    ctx.cookies,
    ctx.sessionKey,
  )
}

export function md5UpperHex(input: string): string {
  return createHash('md5').update(input).digest('hex').toUpperCase()
}
