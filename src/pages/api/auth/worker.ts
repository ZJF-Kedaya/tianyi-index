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

function cloudflareHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

function apiUrl(accountId: string, workerName: string, suffix: string) {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}${suffix}`
}

async function cloudflareFetch(url: string, init: RequestInit = {}) {
  const { token } = cloudflareConfig()
  return fetch(url, {
    ...init,
    headers: { ...cloudflareHeaders(token), ...(init.headers || {}) },
  })
}

function deploymentSummary(deployment: any) {
  return {
    id: deployment?.id || '-',
    createdAt: deployment?.created_on || deployment?.createdAt || '-',
    source: deployment?.source || '-',
    strategy: deployment?.strategy || '-',
    version: deployment?.version || null,
    status: deployment?.status || 'unknown',
  }
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
      const [deploymentsRes, settingsRes] = await Promise.all([
        cloudflareFetch(apiUrl(config.accountId, config.workerName, '/deployments')),
        cloudflareFetch(apiUrl(config.accountId, config.workerName, '/settings')),
      ])
      const [deploymentsData, settingsData] = await Promise.all([deploymentsRes.json(), settingsRes.json()])
      if (!deploymentsRes.ok || !deploymentsData.success) throw new Error('读取 Worker 部署失败')
      if (!settingsRes.ok || !settingsData.success) throw new Error('读取 Worker 设置失败')
      const latest = Array.isArray(deploymentsData.result) ? deploymentSummary(deploymentsData.result[0]) : null
      const history = (Array.isArray(deploymentsData.result) ? deploymentsData.result : []).slice(0, 10).map(deploymentSummary)
      const explicitWebDav = settingsData.result?.env_vars?.WEBDAV_ENABLED ?? settingsData.result?.vars?.WEBDAV_ENABLED
      const webdavEnabled = explicitWebDav === 'false' || explicitWebDav === false ? false : true
      res.status(200).json({
        success: true,
        data: {
          configured: true,
          reachable: true,
          workerName: config.workerName,
          secretConfigured: Boolean(process.env.WEBDAV_WORKER_SECRET || process.env.CONFIG_MASTER_KEY),
          webdavEnabled,
          latest,
          history,
          settings: {
            env_vars: settingsData.result?.env_vars || settingsData.result?.vars || {},
          },
        },
      })
      return
    }

    if (req.body?.action === 'sync-secret') {
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
      return
    }

    if (req.body?.action === 'toggle-webdav') {
      const enabled = req.body.enabled === true
      const settingsResponse = await cloudflareFetch(apiUrl(config.accountId, config.workerName, '/settings'), {
        method: 'PUT',
        body: JSON.stringify({ env_vars: { WEBDAV_ENABLED: enabled ? 'true' : 'false' } }),
      })
      const settingsData = await settingsResponse.json()
      if (!settingsResponse.ok || !settingsData.success) throw new Error('更新 Worker 设置失败')
      res.status(200).json({ success: true, message: enabled ? '已开启 WebDAV' : '已关闭 WebDAV' })
      return
    }

    res.status(400).json({ error: '不支持的 Worker 操作' })
  } catch (error) {
    console.error('[worker] Cloudflare API failed:', error)
    res.status(502).json({ error: error instanceof Error ? error.message : 'Cloudflare API 请求失败' })
  }
}
