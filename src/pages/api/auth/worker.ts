import type { NextApiRequest, NextApiResponse } from 'next'
import { isAdminReq } from './check'
import { isSameOriginReq } from '../../../utils/adminAuth'
import { getRuntimeConfigValue } from '../../../utils/runtimeConfigStore'

function cloudflareConfig() {
  return {
    token: process.env.CF_API_TOKEN || '',
    accountId: process.env.CF_ACCOUNT_ID || '',
    workerName: process.env.CF_WORKER_NAME || 'tianyi-webdav',
  }
}

function apiUrl(accountId: string, workerName: string, suffix: string) {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}${suffix}`
}

async function cloudflareFetch(url: string, init: RequestInit = {}) {
  const { token } = cloudflareConfig()
  return fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  })
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!(await isAdminReq(req))) {
    res.status(401).json({ error: 'Admin session required.' })
    return
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }
  if (req.method === 'POST' && !isSameOriginReq(req)) {
    res.status(403).json({ error: '跨站请求被拒绝' })
    return
  }

  const config = cloudflareConfig()
  if (!config.token || !config.accountId) {
    const workerSecret = await getRuntimeConfigValue('WEBDAV_WORKER_SECRET')
    res.status(200).json({ success: true, data: { configured: false, workerName: config.workerName, secretConfigured: Boolean(workerSecret) } })
    return
  }

  try {
    if (req.method === 'GET') {
      const response = await cloudflareFetch(apiUrl(config.accountId, config.workerName, '/deployments'))
      const data = await response.json()
      if (!response.ok || !data.success) throw new Error('Cloudflare API 请求失败')
      const latest = Array.isArray(data.result) ? data.result[0] : null
      const workerSecret = await getRuntimeConfigValue('WEBDAV_WORKER_SECRET')
      res.status(200).json({
        success: true,
        data: {
          configured: true,
          reachable: true,
          workerName: config.workerName,
          secretConfigured: Boolean(process.env.WEBDAV_WORKER_SECRET || process.env.CONFIG_MASTER_KEY),
          latest: latest ? { id: latest.id, createdAt: latest.created_on || latest.createdAt, source: latest.source, strategy: latest.strategy } : null,
        },
      })
      return
    }

    if (req.body?.action !== 'sync-secret') {
      res.status(400).json({ error: '不支持的 Worker 操作' })
      return
    }
    const secret = await getRuntimeConfigValue('WEBDAV_WORKER_SECRET')
    if (!secret) {
      res.status(503).json({ error: 'WEBDAV_WORKER_SECRET 未配置' })
      return
    }
    const response = await cloudflareFetch(apiUrl(config.accountId, config.workerName, '/secrets'), {
      method: 'PUT',
      body: JSON.stringify({ name: 'WEBDAV_WORKER_SECRET', text: secret, type: 'secret_text' }),
    })
    const data = await response.json()
    if (!response.ok || !data.success) throw new Error('Cloudflare Worker 密钥同步失败')
    res.status(200).json({ success: true, message: 'WebDAV Worker 密钥已同步。代码部署仍需使用 Wrangler。' })
  } catch (error) {
    console.error('[worker] Cloudflare API failed:', error)
    res.status(502).json({ error: error instanceof Error ? error.message : 'Cloudflare API 请求失败' })
  }
}
