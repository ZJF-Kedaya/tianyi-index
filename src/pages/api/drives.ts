/**
 * 公开的网盘可用性查询：返回各网盘是否已配置（布尔值，不含任何凭据信息）。
 * 前端文件列表用它决定是否在根目录渲染对应网盘的虚拟入口。
 */

import type { NextApiRequest, NextApiResponse } from 'next'

import { getDrivesAvailability } from '../../utils/driveAvailability'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }
  try {
    const availability = await getDrivesAvailability()
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).json({ availability })
  } catch (error: any) {
    console.error('[api/drives] 查询失败:', error?.message)
    // 查询失败时按"全部已配置"处理，保持原有展示行为
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).json({ availability: { tianyi: true, onedrive: true, pan123: true } })
  }
}
