/**
 * OneDrive 上传支持：创建 Graph 分片上传会话。
 *
 * 流程：
 * 1. 前端请求本接口 action=create-session，携带目标目录与文件信息；
 * 2. 后端校验管理员身份后调用 Graph createUploadSession；
 * 3. 前端拿到的 uploadUrl 是微软直链，分片 PUT 不经过 Vercel，
 *    从而绕开 Serverless 约 4.5MB 的请求体上限。
 */

import type { NextApiRequest, NextApiResponse } from 'next'

import apiConfig from '../../../../config/api.config'
import axios from 'axios'
import { isAdminReq } from '../auth/check'
import { isSameOriginReq } from '../../../utils/adminAuth'
import { graphGet, getAccessToken } from '.'

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

  try {
    if (action === 'create-session') {
      const dirPath = String(req.body.path || '/')
      const fileName = String(req.body.fileName || '')
      const fileSize = Number(req.body.size || 0)
      if (!fileName) {
        res.status(400).json({ error: '缺少文件名' })
        return
      }

      // 目录必须存在且是文件夹（顺带校验 token 可用）
      const accessToken = await getAccessToken()
      if (!accessToken) {
        res.status(502).json({ error: 'OneDrive 未授权' })
        return
      }
      const cleanDir = dirPath === '/' ? '' : dirPath.replace(/\/$/, '')
      const encodedDir = cleanDir
        .split('/')
        .filter(Boolean)
        .map(seg => encodeURIComponent(seg))
        .join('/')

      const base = `${apiConfig.driveApi}/root`
      const sessionApi = encodedDir ? `${base}:${encodedDir}:/${encodeURIComponent(fileName)}:/createUploadSession` : `${base}:/${encodeURIComponent(fileName)}:/createUploadSession`

      const { data } = await axios.post(
        sessionApi,
        {
          item: {
            '@microsoft.graph.conflictBehavior': 'rename',
            name: fileName,
            size: fileSize,
          },
        },
        { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 20000 },
      )

      res.status(200).json({ success: true, data: { uploadUrl: data.uploadUrl, fileName } })
      return
    }

    if (action === 'check-folder') {
      // 校验目标目录存在（上传前预检）
      const dirPath = String(req.body.path || '/')
      const cleanDir = dirPath === '/' ? '' : dirPath.replace(/\/$/, '')
      const encodedDir = cleanDir
        .split('/')
        .filter(Boolean)
        .map(seg => encodeURIComponent(seg))
        .join('/')
      const url = encodedDir ? `${apiConfig.driveApi}/root:${encodedDir}:` : `${apiConfig.driveApi}/root`
      await graphGet(url, { params: { select: 'name,folder' } })
      res.status(200).json({ success: true })
      return
    }

    res.status(400).json({ error: `未知操作: ${action}` })
  } catch (error: any) {
    console.error('[od/upload] 异常:', error?.response?.status, error?.message)
    const status = error?.response?.status === 404 ? 404 : 502
    res.status(status).json({ error: error?.response?.data?.error?.message || error?.message || 'OneDrive 上传会话创建失败' })
  }
}
