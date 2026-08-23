import type { NextApiRequest, NextApiResponse } from 'next'
import { isAdminReq } from './check'
import { isSameOriginReq } from '../../../utils/adminAuth'
import {
  generateRuntimeSecret,
  getRuntimeConfigMetadata,
  isSensitiveRuntimeConfigKey,
  RUNTIME_CONFIG_KEYS,
  setRuntimeConfig,
  type RuntimeConfigKey,
} from '../../../utils/runtimeConfigStore'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!(await isAdminReq(req))) {
    res.status(401).json({ error: 'Admin session required.' })
    return
  }
  if (req.method === 'GET') {
    try {
      res.status(200).json({ success: true, data: await getRuntimeConfigMetadata() })
    } catch (error) {
      console.error('[runtime-config] GET failed:', error)
      res.status(500).json({ error: '读取运行时配置失败' })
    }
    return
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }
  if (!isSameOriginReq(req)) {
    res.status(403).json({ error: '跨站请求被拒绝' })
    return
  }

  try {
    const body = req.body || {}
    if (body.action === 'generate') {
      const key = body.key as RuntimeConfigKey
      if (!(RUNTIME_CONFIG_KEYS as readonly string[]).includes(key) || !isSensitiveRuntimeConfigKey(key)) {
        res.status(400).json({ error: '只能为敏感配置生成密钥' })
        return
      }
      res.status(200).json({ success: true, key, value: generateRuntimeSecret() })
      return
    }
    if (body.action !== 'save' || !body.values || typeof body.values !== 'object' || Array.isArray(body.values)) {
      res.status(400).json({ error: '无效的配置请求' })
      return
    }
    await setRuntimeConfig(body.values as Record<string, unknown>)
    res.status(200).json({ success: true, data: await getRuntimeConfigMetadata() })
  } catch (error) {
    console.error('[runtime-config] POST failed:', error)
    res.status(400).json({ error: error instanceof Error ? error.message : '保存运行时配置失败' })
  }
}
