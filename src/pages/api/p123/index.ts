/**
 * 123 云盘目录列举路由 —— 响应契约与 /api/ty 一致（Graph 风格），
 * 前端 FileListing 无需感知驱动差异。
 */

import { posix as pathPosix } from 'path'

import type { NextApiRequest, NextApiResponse } from 'next'

import apiConfig from '../../../../config/api.config'
import { getMimeType } from '../../../utils/mime'
import { listPan123Folder, resolvePan123Path } from '../../../utils/pan123Client'
import { isAdminReq } from '../auth/check'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', apiConfig.cacheControlHeader)

  const adminFlag = req.query.admin === '1' || req.body?.admin === true
  if (adminFlag) {
    const isAdmin = await isAdminReq(req)
    if (!isAdmin) {
      res.status(403).json({ error: 'Admin session required.' })
      return
    }
  }

  let rawPath = '/'
  if (req.method === 'GET') {
    rawPath = (req.query.path as string) || '/'
  } else if (req.method === 'POST') {
    rawPath = req.body?.path || '/'
  }
  if (typeof rawPath !== 'string') {
    res.status(400).json({ error: 'Path query invalid.' })
    return
  }

  const cleanPath = pathPosix.resolve('/', pathPosix.normalize(rawPath)).replace(/\/$/, '')
  const segments = cleanPath === '/' ? [] : cleanPath.split('/').filter(Boolean)

  try {
    const resolved = await resolvePan123Path(segments)

    if (resolved.kind === 'not_found') {
      res.status(404).json({ error: '路径未找到' })
      return
    }

    if (resolved.kind === 'file') {
      const m = resolved.meta
      res.status(200).json({
        file: {
          id: String(m.FileId),
          name: m.FileName,
          size: m.Size || 0,
          lastModifiedDateTime: m.UpdateAt,
          file: { mimeType: getMimeType(m.FileName) },
        },
      })
      return
    }

    const children = await listPan123Folder(resolved.id)
    const folderChildren = [
      ...children.filter(c => c.Type === 1).map(f => ({
        id: String(f.FileId),
        name: f.FileName,
        size: 0,
        lastModifiedDateTime: f.UpdateAt,
        folder: { childCount: 0 },
      })),
      ...children.filter(c => c.Type !== 1).map(f => ({
        id: String(f.FileId),
        name: f.FileName,
        size: f.Size || 0,
        lastModifiedDateTime: f.UpdateAt,
        file: { mimeType: getMimeType(f.FileName) },
      })),
    ]

    res.status(200).json({
      folder: {
        '@odata.count': folderChildren.length,
        value: folderChildren,
      },
    })
  } catch (error: any) {
    console.error('[p123/index] 异常:', error?.message || error)
    // 凭据类错误对客户端表现为临时不可用（502），避免被当成"网盘不存在"
    const message = String(error?.message || '')
    const status = message.includes('未配置') ? 503 : 502
    res.status(status).json({ error: message || '获取目录失败' })
  }
}
