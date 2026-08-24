/**
 * 天翼云盘上传支持：加密上传接口的服务端封装。
 * 客户端计算 MD5 → 本接口创建会话/取分片直链/提交，字节流直传天翼 CDN。
 */

import type { NextApiRequest, NextApiResponse } from 'next'
import type { IncomingMessage } from 'http'

import axios from 'axios'

import { isAdminReq } from '../auth/check'
import { isSameOriginReq } from '../../../utils/adminAuth'
import {
  commitTianyiUpload,
  currentSessionKey,
  getTianyiPartUrl,
  initTianyiUpload,
} from '../../../utils/tianyiUpload'

// 中继分片需要超过 Next 默认 1mb 的请求体上限（Vercel 硬顶约 4.5MB，留余量取 4MB）
export const config = {
  api: {
    bodyParser: { sizeLimit: '5mb' },
  },
}

/** 进行中的中继分片缓冲（协议分片 10MB，由多个 ~4MB 片段拼成） */
const relayBuffers = new Map<string, { chunks: Buffer[]; received: number; total: number }>()

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 6 * 1024 * 1024) {
        reject(new Error('fragment too large'))
        req.destroy()
        return
      }
      parts.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(parts)))
    req.on('error', reject)
  })
}

/** 中继一个协议分片：片段收齐后由服务端 PUT 到天翼 CDN */
async function relayPart(req: NextApiRequest, res: NextApiResponse) {
  const uploadFileId = String(req.query.uploadFileId || '')
  const partNumber = Number(req.query.partNumber || 0)
  const partMd5Base64 = String(req.query.partMd5Base64 || '')
  const fragIndex = Number(req.query.fragIndex || 0)
  const fragTotal = Number(req.query.fragTotal || 1)

  const key = `${uploadFileId}:${partNumber}`
  let entry = relayBuffers.get(key)
  if (!entry || fragIndex === 0) {
    entry = { chunks: [], received: 0, total: fragTotal }
    relayBuffers.set(key, entry)
  }
  const body = await readRawBody(req)
  entry.chunks.push(body)
  entry.received += body.length

  if (fragIndex < fragTotal - 1) {
    res.status(200).json({ success: true, data: { received: entry.received, completed: false } })
    return
  }

  // 收齐：取直链并整片上传
  const ctx = await currentSessionKey()
  const part = await getTianyiPartUrl(
    { uploadFileId, partNumber, partMd5Base64 },
    { cookies: ctx.cookies, sessionKey: ctx.key },
  )
  const buffer = Buffer.concat(entry.chunks)
  relayBuffers.delete(key)

  await axios.put(part.requestURL, buffer, {
    headers: { ...(part.headers || {}), 'Content-Length': String(buffer.length) },
    maxBodyLength: Infinity,
    timeout: 120_000,
  })
  res.status(200).json({ success: true, data: { completed: true, bytes: buffer.length } })
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }
  if (!isSameOriginReq(req)) {
    res.status(403).json({ error: '跨站请求被拒绝' })
    return
  }
  const isAdmin = await isAdminReq(req)
  if (!isAdmin) {
    res.status(401).json({ error: '未登录或会话已过期' })
    return
  }

  const { action } = req.body || {}

  // 中继分片走 octet-stream 原始体，参数在 query 上
  if (req.headers['content-type'] === 'application/octet-stream') {
    return relayPart(req, res)
  }

  try {
    if (action === 'create-session') {
      const result = await initTianyiUpload({
        dirPath: String(req.body.path || '/'),
        fileName: String(req.body.fileName || ''),
        fileSize: Number(req.body.size || 0),
        fileMd5: req.body.fileMd5 ? String(req.body.fileMd5) : undefined,
        sliceMd5: req.body.sliceMd5 ? String(req.body.sliceMd5) : undefined,
      })
      if (result.session.fileDataExists) {
        // 秒传：服务端内容已存在，直接提交
        await commitTianyiUpload(
          {
            uploadFileId: result.session.uploadFileId,
            // 秒传时前端已带全量 MD5
            fileMd5: String(req.body.fileMd5 || ''),
            sliceMd5: String(req.body.sliceMd5 || req.body.fileMd5 || ''),
          },
          { cookies: result.cookies, sessionKey: result.sessionKey },
        )
        res.status(200).json({ success: true, data: { rapidUpload: true } })
        return
      }
      res.status(200).json({
        success: true,
        data: {
          uploadFileId: result.session.uploadFileId,
          sliceSize: result.session.sliceSize,
          rapidUpload: false,
        },
      })
      return
    }

    if (action === 'get-part-url') {
      const ctx = await currentSessionKey()
      const part = await getTianyiPartUrl(
        {
          uploadFileId: String(req.body.uploadFileId || ''),
          partNumber: Number(req.body.partNumber || 0),
          partMd5Base64: String(req.body.partMd5Base64 || ''),
        },
        { cookies: ctx.cookies, sessionKey: ctx.key },
      )
      res.status(200).json({ success: true, data: part })
      return
    }

    if (action === 'commit') {
      const ctx = await currentSessionKey()
      await commitTianyiUpload(
        {
          uploadFileId: String(req.body.uploadFileId || ''),
          fileMd5: String(req.body.fileMd5 || ''),
          sliceMd5: String(req.body.sliceMd5 || ''),
        },
        { cookies: ctx.cookies, sessionKey: ctx.key },
      )
      res.status(200).json({ success: true })
      return
    }

    res.status(400).json({ error: `未知操作: ${action}` })
  } catch (error: any) {
    console.error('[ty/upload] 异常:', error?.message)
    res.status(502).json({ error: error?.message || '天翼云盘上传失败' })
  }
}
