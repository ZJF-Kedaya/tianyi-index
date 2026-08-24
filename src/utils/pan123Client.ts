/**
 * 123 云盘（123pan）客户端：登录、签名、列目录、下载直链。
 *
 * 协议要点（社区逆向，参考 OpenList 系驱动行为自行实现）：
 * - 登录 POST login.123pan.com/api/user/sign_in {passport, password, platform:"web"} → JWT
 * - 业务 API 统一在 yun.123pan.com/b/api，请求需附带 URL 签名参数
 *   （timeSign=timestamp-random-dataSign，均为 CRC32 计算）
 * - 列目录 GET /file/list/new?parentFileId=0&limit=100&...，data.Next="-1" 表示结束
 * - 下载 POST /file/download_info → DownloadUrl（可能带 base64 params 或 302 重定向）
 */

import { createHash } from 'crypto'

import { crc32 } from './crc32'
import {
  getRuntimeConfigValue,
} from './runtimeConfigStore'
import {
  getP123Token, setP123Token,
} from './p123TokenStore'

const MAIN_API = 'https://yun.123pan.com/b/api'
const LOGIN_API = 'https://login.123pan.com/api/user/sign_in'
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) tianyi-index-client'

// 数字→字母映射表（签名算法的一部分），索引即数字
const SIGN_TABLE = ['a', 'd', 'e', 'f', 'g', 'h', 'l', 'm', 'y', 'i', 'j', 'n', 'o', 'p', 'k', 'q', 'r', 's', 't', 'u', 'b', 'c', 'w', 'x', 'z', 'v']

export interface Pan123FileMeta {
  FileId: number
  FileName: string
  Type: number // 1=文件夹 0=文件
  Size: number
  Etag: string
  S3KeyFlag: string
  UpdateAt: string
}

/** 生成 123 云盘的 URL 签名查询串 */
export function signPath(pathname: string): string {
  const random = Math.round(1e7 * Math.random()).toString()
  const now = new Date()
  const timestamp = Math.round((now.getTime() + 8 * 3600000) / 1000).toString()

  // 东八区 YYYYMMDDhhmm 逐位映射后取 CRC32
  const y = now.getUTCFullYear()
  const mo = String(now.getUTCMonth() + 1).padStart(2, '0')
  const d = String(now.getUTCDate()).padStart(2, '0')
  const h = String((now.getUTCHours() + 8) % 24).padStart(2, '0')
  const mi = String(now.getUTCMinutes()).padStart(2, '0')
  const mapped = `${y}${mo}${d}${h}${mi}`
    .split('')
    .map(ch => SIGN_TABLE[parseInt(ch)])
    .join('')
  const timeSign = crc32(mapped).toString()

  const data = [timestamp, random, pathname, 'web', '3', timeSign].join('|')
  const dataSign = crc32(data).toString()
  return `${timeSign}=${timestamp}-${random}-${dataSign}`
}

/** 给业务 API URL 追加签名参数 */
function signedUrl(rawUrl: string): string {
  const qIdx = rawUrl.indexOf('?')
  const existing = qIdx >= 0 ? rawUrl.substring(qIdx + 1) : ''
  const u = new URL(rawUrl)
  const sig = signPath(u.pathname)
  return `${rawUrl}${existing ? '&' : '?'}${sig}`
}

async function getCredential(): Promise<{ username: string; password: string }> {
  const username = await getRuntimeConfigValue('P123_USERNAME')
  const password = await getRuntimeConfigValue('P123_PASSWORD')
  if (!username || !password) {
    throw new Error('未配置 123 云盘账号（P123_USERNAME / P123_PASSWORD）')
  }
  return { username, password }
}

let pendingLoginPromise: Promise<string> | null = null

/** 账号密码登录换取 JWT；成功后持久化到 Redis */
export async function loginPan123(): Promise<string> {
  if (pendingLoginPromise) return pendingLoginPromise
  pendingLoginPromise = (async () => {
    const { username, password } = await getCredential()
    const res = await fetch(LOGIN_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        origin: 'https://yun.123pan.com',
        referer: 'https://yun.123pan.com/',
        'user-agent': USER_AGENT,
        platform: 'web',
        'app-version': '3',
      },
      body: JSON.stringify({ passport: username, password, remember: true }),
    })
    const data: any = await res.json().catch(() => ({}))
    if (data?.code !== 200 || !data?.data?.token) {
      throw new Error(`123 云盘登录失败（${data?.message || `code ${data?.code}`}），请检查账号密码或稍后重试`)
    }
    const token = String(data.data.token)
    await setP123Token(token)
    return token
  })()
  try {
    return await pendingLoginPromise
  } finally {
    pendingLoginPromise = null
  }
}

async function getValidToken(): Promise<string> {
  const cached = await getP123Token()
  if (cached) return cached
  return loginPan123()
}

/**
 * 带签名的业务 API 请求。401/token 失效时自动重登一次。
 * 123 的业务码：0 / 200 成功，401 token 失效。
 */
async function request(url: string, method: 'GET' | 'POST', body?: unknown, skipLoginRetry = false): Promise<any> {
  const doReq = async (): Promise<any> => {
    const token = await getValidToken()
    const res = await fetch(signedUrl(url), {
      method,
      headers: {
        origin: 'https://yun.123pan.com',
        referer: 'https://yun.123pan.com/',
        authorization: `Bearer ${token}`,
        'user-agent': USER_AGENT,
        platform: 'web',
        'app-version': '3',
        Accept: 'application/json',
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
      body: method === 'POST' && body !== undefined ? JSON.stringify(body) : undefined,
    })
    return res.json().catch(() => ({}))
  }

  let data = await doReq()
  const code = data?.code
  if (code !== 0 && code !== 200) {
    if ((code === 401 || code === -10001) && !skipLoginRetry) {
      // token 失效：清掉缓存强制重登后重试一次
      await setP123Token('')
      data = await doReq()
      const retryCode = data?.code
      if (retryCode !== 0 && retryCode !== 200) {
        throw new Error(data?.message || `123 云盘接口错误 code ${retryCode}`)
      }
      return data
    }
    throw new Error(data?.message || `123 云盘接口错误 code ${code}`)
  }
  return data
}

/** 列出某文件夹下的全部子项（自动翻页） */
export async function listPan123Folder(parentId: number | string): Promise<Pan123FileMeta[]> {
  const files: Pan123FileMeta[] = []
  let nextToken = '-1'
  for (let page = 1; page < 200; page++) {
    const query = new URLSearchParams({
      driveId: '0',
      limit: '100',
      next: nextToken,
      orderBy: 'file_id',
      orderDirection: 'desc',
      parentFileId: String(parentId),
      trashed: 'false',
      SearchData: '',
      Page: String(page),
      OnlyLookAbnormalFile: '0',
      event: 'homeListFile',
      operateType: '4',
      inDirectSpace: 'false',
    })
    const resp = await request(`${MAIN_API}/file/list/new?${query.toString()}`, 'GET')
    const list: Pan123FileMeta[] = resp?.data?.InfoList || []
    files.push(...list)
    const nextVal = String(resp?.data?.Next ?? '-1')
    if (!resp?.data || list.length === 0 || nextVal === '-1') break
    nextToken = nextVal
  }
  return files
}

/**
 * 把路径段解析成文件夹 FileId 或文件元数据。
 * 根目录固定为 0。
 */
export async function resolvePan123Path(segments: string[]): Promise<
  { kind: 'folder'; id: string } | { kind: 'file'; meta: Pan123FileMeta } | { kind: 'not_found' }
> {
  let parentId: string = '0'
  for (let i = 0; i < segments.length; i++) {
    const children = await listPan123Folder(parentId)
    const hit = children.find(c => c.FileName === segments[i])
    if (!hit) return { kind: 'not_found' }
    if (i === segments.length - 1) {
      return hit.Type === 1 ? { kind: 'folder', id: String(hit.FileId) } : { kind: 'file', meta: hit }
    }
    if (hit.Type !== 1) return { kind: 'not_found' }
    parentId = String(hit.FileId)
  }
  return { kind: 'folder', id: parentId }
}

/** 获取文件下载直链（处理 base64 params 与 302 两层跳转） */
export async function getPan123DownloadLink(meta: Pan123FileMeta): Promise<string> {
  const resp = await request(`${MAIN_API}/file/download_info`, 'POST', {
    driveId: 0,
    etag: meta.Etag,
    fileId: meta.FileId,
    fileName: meta.FileName,
    s3keyFlag: meta.S3KeyFlag,
    size: meta.Size,
    type: meta.Type,
  })
  let downloadUrl = String(resp?.data?.DownloadUrl || '')
  if (!downloadUrl) throw new Error('123 云盘未返回下载地址')

  try {
    const u = new URL(downloadUrl)
    const encoded = u.searchParams.get('params')
    if (encoded) downloadUrl = new URL(atob(encoded)).toString()
  } catch {
    // 解析失败就用原始地址
  }

  // 部分直链会再 302 到真实 CDN 地址，服务端先解一层
  const res = await fetch(downloadUrl, {
    method: 'GET',
    redirect: 'manual',
    headers: { Referer: 'https://yun.123pan.com/' },
  }).catch(() => null)
  if (res && res.status === 302) {
    return res.headers.get('location') || downloadUrl
  }
  return downloadUrl
}

/** 校验当前凭据是否可用（管理台"测试连接"用） */
export async function testPan123Connection(): Promise<{ ok: boolean; message: string }> {
  try {
    const token = await getValidToken()
    const res = await fetch(signedUrl(`${MAIN_API}/user/info`), {
      headers: {
        origin: 'https://yun.123pan.com',
        referer: 'https://yun.123pan.com/',
        authorization: `Bearer ${token}`,
        'user-agent': USER_AGENT,
        platform: 'web',
        'app-version': '3',
      },
    })
    const data: any = await res.json().catch(() => ({}))
    if (data?.code === 0 || data?.code === 200) {
      const nickname = data?.data?.Nickname || data?.data?.Mail || '已连接'
      return { ok: true, message: `123 云盘连接正常（${nickname}）` }
    }
    return { ok: false, message: `123 云盘凭据无效：${data?.message || `code ${data?.code}`}` }
  } catch (e: any) {
    return { ok: false, message: e?.message || '123 云盘连接失败' }
  }
}

/** 内容哈希工具（上传分片校验预留） */
export function md5Hex(input: string | Buffer): string {
  return createHash('md5').update(input).digest('hex')
}
