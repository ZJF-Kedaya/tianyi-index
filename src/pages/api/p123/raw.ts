/**
 * 123 云盘文件下载路由：解析路径 → 取直链 → 302 给客户端。
 */

import { posix as pathPosix } from 'path'

import type { NextApiRequest, NextApiResponse } from 'next'

import { getPan123DownloadLink, resolvePan123Path } from '../../../utils/pan123Client'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const rawPath = (req.query.path as string) || '/'
  const cleanPath = pathPosix.resolve('/', pathPosix.normalize(rawPath)).replace(/\/$/, '')
  const segments = cleanPath === '/' ? [] : cleanPath.split('/').filter(Boolean)

  if (segments.length === 0) {
    res.status(400).json({ error: 'Cannot download a folder' })
    return
  }

  try {
    const resolved = await resolvePan123Path(segments)
    if (resolved.kind !== 'file') {
      res.status(404).json({ error: '文件未找到' })
      return
    }
    const link = await getPan123DownloadLink(resolved.meta)
    // 跨域下载直链，直接让客户端跳转到文件服务器
    res.redirect(302, link)
  } catch (error: any) {
    console.error('[p123/raw] 异常:', error?.message || error)
    res.status(502).json({ error: '获取下载链接失败' })
  }
}
