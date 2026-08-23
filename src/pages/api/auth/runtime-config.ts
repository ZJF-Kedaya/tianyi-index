import type { NextApiRequest, NextApiResponse } from 'next'
import { isAdminReq } from './check'
import { isSameOriginReq } from '../../../utils/adminAuth'
import {
  generateRuntimeSecret,
  getConfigAuditLogs,
  getRuntimeConfigMetadata,
  invalidateConfigCaches,
  isSensitiveRuntimeConfigKey,
  recordConfigAudit,
  RUNTIME_CONFIG_KEYS,
  setRuntimeConfig,
  testRuntimeConfigConnections,
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
    if (body.action === 'audit') {
      const logs = await getConfigAuditLogs(typeof body.limit === 'number' ? body.limit : 50)
      res.status(200).json({ success: true, logs })
      return
    }
    if (body.action === 'test') {
      const result = await testRuntimeConfigConnections()
      res.status(200).json({ success: true, tests: result })
      return
    }
    if (body.action === 'clear-cache') {
      const results = await invalidateConfigCaches(body.admin || 'admin')
      await recordConfigAudit({ action: 'clear-cache', admin: body.admin || 'admin' })
      res.status(200).json({ success: true, messages: results })
      return
    }
    if (body.action !== 'save' || !body.values || typeof body.values !== 'object' || Array.isArray(body.values)) {
      res.status(400).json({ error: '无效的配置请求' })
      return
    }
    const oldValues: Record<string, string> = {}
    const newValues: Record<string, string> = {}
    for (const [key, value] of Object.entries(body.values)) {
      if (RUNTIME_CONFIG_KEYS.includes(key as RuntimeConfigKey)) {
        oldValues[key] = await (await import('../../../utils/runtimeConfigStore')).getRuntimeConfigValue(key as RuntimeConfigKey)
        newValues[key] = typeof value === 'string' ? value : ''
      }
    }
    await setRuntimeConfig(body.values as Record<string, unknown>)
    for (const key of Object.keys(newValues)) {
      await recordConfigAudit({ action: 'save', key, oldValue: oldValues[key], newValue: newValues[key], admin: body.admin || 'admin' })
    }
    res.status(200).json({ success: true, data: await getRuntimeConfigMetadata() })
  } catch (error) {
    console.error('[runtime-config] POST failed:', error)
    res.status(400).json({ error: error instanceof Error ? error.message : '保存运行时配置失败' })
  }
}
