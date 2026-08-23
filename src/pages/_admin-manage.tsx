import { useState } from 'react'

import Head from 'next/head'
import { useRouter } from 'next/router'
import { GetServerSidePropsContext } from 'next'
import { serverSideTranslations } from 'next-i18next/serverSideTranslations'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faCheck,
  faCircleInfo,
  faHardDrive,
  faLock,
  faPlus,
  faRightFromBracket,
  faRotate,
  faShieldHalved,
  faTrashCan,
  faXmark,
} from '@fortawesome/free-solid-svg-icons'

import { verifyAdminSession } from '../utils/adminSessionStore'
import { getTokenFromReq } from '../utils/adminAuth'
import { getProtectedRoutes, getProtectedRoutesOd } from '../utils/protectedRoutesStore'
import siteConfig from '../../config/site.config'

interface ManageProps {
  initialIsAdmin: boolean
  initialSession: { username: string; createdAt: number; lastAccessAt: number } | null
  initialProtectedRoutes: string[]
  initialProtectedRoutesOd: string[]
}

type Section = 'overview' | 'protection' | 'configuration' | 'maintenance'

const navItems: Array<{ id: Section; label: string; icon: typeof faCircleInfo }> = [
  { id: 'overview', label: '状态', icon: faCircleInfo },
  { id: 'protection', label: '访问控制', icon: faShieldHalved },
  { id: 'configuration', label: '运行时配置', icon: faHardDrive },
  { id: 'maintenance', label: '维护', icon: faHardDrive },
]

export default function AdminManagePage({
  initialIsAdmin,
  initialSession,
  initialProtectedRoutes,
  initialProtectedRoutesOd,
}: ManageProps) {
  const router = useRouter()
  const [section, setSection] = useState<Section>('overview')
  const [tyRoutes, setTyRoutes] = useState(initialProtectedRoutes)
  const [odRoutes, setOdRoutes] = useState(initialProtectedRoutesOd)
  const [newTyRoute, setNewTyRoute] = useState('')
  const [newOdRoute, setNewOdRoute] = useState('')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [saved, setSaved] = useState(false)
  const [runtimeMeta, setRuntimeMeta] = useState<any>(null)
  const [runtimeValues, setRuntimeValues] = useState<Record<string, string>>({})
  const [runtimeSecrets, setRuntimeSecrets] = useState<Record<string, string>>({})
  const [workerStatus, setWorkerStatus] = useState<any>(null)
  const [auditLogs, setAuditLogs] = useState<any[]>([])
  const [connectionTests, setConnectionTests] = useState<any>(null)

  async function callApi(action: string, extra: Record<string, unknown> = {}) {
    setLoading(true)
    setMessage(null)
    try {
      const endpoint = action.startsWith('runtime-') ? '/api/auth/runtime-config/' : action.startsWith('sync-worker') ? '/api/auth/worker/' : '/api/auth/manage/'
      const apiAction = action === 'save-runtime-config' ? 'save' : action === 'generate-runtime-secret' ? 'generate' : action === 'sync-worker-secret' ? 'sync-secret' : action === 'clear-cache' ? 'clear-cache' : action === 'toggle-webdav' ? 'toggle-webdav' : action
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: apiAction, ...extra }),
      })
      const data = await response.json()
      if (!response.ok) {
        setMessage({ type: 'error', text: data.error || '操作失败' })
        return null
      }
      return data
    } catch (error: any) {
      setMessage({ type: 'error', text: error?.message || '网络错误' })
      return null
    } finally {
      setLoading(false)
    }
  }

  async function loadRuntimeConfig() {
    setLoading(true)
    try {
      const response = await fetch('/api/auth/runtime-config/')
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '读取配置失败')
      setRuntimeMeta(data.data)
      const values: Record<string, string> = {}
      for (const item of data.data.values) if (!item.sensitive && item.value !== undefined) values[item.key] = item.value || ''
      setRuntimeValues(values)
    } catch (error: any) {
      setMessage({ type: 'error', text: error?.message || '读取配置失败' })
    } finally {
      setLoading(false)
    }
  }

  async function saveRuntimeConfig() {
    const data = await callApi('save-runtime-config', { values: { ...runtimeValues, ...runtimeSecrets } })
    if (data?.success) {
      setRuntimeMeta(data.data)
      setMessage({ type: 'success', text: '运行时配置已保存。敏感配置只显示配置状态。' })
    }
  }

  async function generateRuntimeSecret(key: string) {
    const data = await callApi('generate-runtime-secret', { key })
    if (!data?.value) return
    setRuntimeSecrets(current => ({ ...current, [key]: data.value }))
    setMessage({ type: 'success', text: `${key} 已生成，请点击保存配置` })
  }

  async function loadWorkerStatus() {
    setLoading(true)
    try {
      const response = await fetch('/api/auth/worker/')
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '读取 Worker 状态失败')
      setWorkerStatus(data.data)
    } catch (error: any) {
      setMessage({ type: 'error', text: error?.message || '读取 Worker 状态失败' })
    } finally {
      setLoading(false)
    }
  }

  async function syncWorkerSecret() {
    const data = await callApi('sync-worker-secret')
    if (data?.success) setMessage({ type: 'success', text: data.message })
  }

  async function toggleWebDav(enabled: boolean) {
    const data = await callApi('toggle-webdav', { enabled })
    if (data?.success) {
      setMessage({ type: 'success', text: data.message })
      loadWorkerStatus()
    }
  }

  async function testConnections() {
    setLoading(true)
    try {
      const response = await fetch('/api/auth/runtime-config/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'test' }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '测试失败')
      setConnectionTests(data.tests)
    } catch (error: any) {
      setMessage({ type: 'error', text: error?.message || '测试失败' })
    } finally {
      setLoading(false)
    }
  }

  async function loadAuditLogs() {
    setLoading(true)
    try {
      const response = await fetch('/api/auth/runtime-config/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'audit', limit: 20 }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '读取审计日志失败')
      setAuditLogs(data.logs || [])
    } catch (error: any) {
      setMessage({ type: 'error', text: error?.message || '读取审计日志失败' })
    } finally {
      setLoading(false)
    }
  }

  async function invalidateCaches() {
    if (!window.confirm('这会清除所有云盘会话和 token，使旧 session 失效。是否继续？')) return
    const data = await callApi('clear-cache')
    if (data?.success) setMessage({ type: 'success', text: data.messages?.join('；') || '缓存已清除' })
  }

  async function saveProtectedRoutes() {
    const data = await callApi('set-protected-routes', { ty: tyRoutes, od: odRoutes })
    if (!data?.success) return
    setSaved(true)
    setMessage({ type: 'success', text: '访问控制规则已保存' })
    window.setTimeout(() => setSaved(false), 1800)
  }

  async function refreshProtectedRoutes() {
    const data = await callApi('get-protected-routes')
    if (!data?.success) return
    setTyRoutes(data.ty)
    setOdRoutes(data.od)
    setMessage({ type: 'success', text: '已重新读取访问控制规则' })
  }

  async function resetProtectedRoutes() {
    if (!window.confirm('这会丢弃尚未保存的访问控制规则，恢复为环境变量配置。是否继续？')) return
    const data = await callApi('reset-protected-routes')
    if (!data?.success) return
    setTyRoutes(siteConfig.protectedRoutes)
    setOdRoutes(siteConfig.protectedRoutesOd)
    setMessage({ type: 'success', text: '已恢复环境变量配置' })
  }

  async function clearCache() {
    if (!window.confirm('清除后，下次访问云盘会重新建立会话。是否继续？')) return
    const data = await callApi('clear-cache')
    if (data?.success) setMessage({ type: 'success', text: data.messages.join('；') })
  }

  async function handleLogout() {
    setLoading(true)
    try {
      await fetch('/api/auth/logout/', { method: 'POST' })
    } finally {
      sessionStorage.removeItem('admin_status')
      ;(window as any).__isAdmin = false
      router.replace('/@login')
    }
  }

  function addRoute(drive: 'ty' | 'od') {
    const value = (drive === 'ty' ? newTyRoute : newOdRoute).trim()
    const routes = drive === 'ty' ? tyRoutes : odRoutes
    if (!value) return
    // 路径格式校验：必须以 / 开头，且不含 .. 段，避免保护规则静默失效或异常匹配
    if (!value.startsWith('/')) {
      setMessage({ type: 'error', text: '路径必须以 / 开头' })
      return
    }
    if (value.split('/').includes('..')) {
      setMessage({ type: 'error', text: '路径不能包含 ".." 段' })
      return
    }
    if (routes.includes(value)) {
      setMessage({ type: 'error', text: '该路径已存在' })
      return
    }
    if (drive === 'ty') {
      setTyRoutes([...tyRoutes, value])
      setNewTyRoute('')
    } else {
      setOdRoutes([...odRoutes, value])
      setNewOdRoute('')
    }
  }

  if (!initialIsAdmin) return null

  const routeEditor = (drive: 'ty' | 'od', label: string, routes: string[], value: string, setValue: (value: string) => void) => (
    <section className="border-b border-slate-200 py-7 last:border-b-0">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-950">{label}</h2>
          <p className="mt-1 text-sm leading-6 text-slate-500">路径相对于对应云盘的挂载目录。</p>
        </div>
        <span className="font-mono text-xs tabular-nums text-slate-400">{routes.length} 条</span>
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={value}
          onChange={event => setValue(event.target.value)}
          onKeyDown={event => event.key === 'Enter' && (event.preventDefault(), addRoute(drive))}
          placeholder="/私密目录/子路径"
          className="min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-blue-600 focus:ring-2 focus:ring-blue-100"
        />
        <button
          type="button"
          onClick={() => addRoute(drive)}
          className="inline-flex min-h-[40px] items-center gap-2 rounded-md bg-blue-600 px-3 text-sm font-medium text-white transition-[background-color,transform] hover:bg-blue-700 active:scale-95"
        >
          <FontAwesomeIcon icon={faPlus} /> 添加
        </button>
      </div>
      <div className="mt-3 divide-y divide-slate-100 border-y border-slate-100">
        {routes.length === 0 ? (
          <p className="py-3 text-sm text-slate-400">暂无受保护路径</p>
        ) : (
          routes.map(route => (
            <div key={route} className="flex min-h-[44px] items-center justify-between gap-3 py-2">
              <code className="min-w-0 truncate text-sm text-slate-700">{route}</code>
              <button
                type="button"
                aria-label={`移除 ${route}`}
                onClick={() => (drive === 'ty' ? setTyRoutes(tyRoutes.filter(item => item !== route)) : setOdRoutes(odRoutes.filter(item => item !== route)))}
                className="inline-flex h-10 w-10 flex-none items-center justify-center rounded-md text-slate-400 transition-[background-color,color,transform] hover:bg-red-50 hover:text-red-600 active:scale-95"
              >
                <FontAwesomeIcon icon={faXmark} />
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  )

  return (
    <>
      <Head>
        <title>管理 - {process.env.NEXT_PUBLIC_SITE_TITLE || 'TianYi-Index'}</title>
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <div className="min-h-screen bg-white text-slate-900 [font-family:-apple-system,BlinkMacSystemFont,'Segoe_UI','PingFang_SC','Noto_Sans_SC',sans-serif]">
        <a href="#admin-content" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-blue-600 focus:px-3 focus:py-2 focus:text-sm focus:text-white">
          跳到主要内容
        </a>
        <div className="mx-auto flex min-h-screen max-w-6xl">
          <aside className="hidden w-52 flex-none border-r border-slate-200 px-4 py-6 md:flex md:flex-col">
            <nav aria-label="管理导航" className="space-y-1">
              {navItems.map(item => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSection(item.id)}
                  className={`flex min-h-[40px] w-full items-center gap-3 rounded-md px-3 text-sm transition-[background-color,color,transform] active:scale-95 ${
                    section === item.id ? 'bg-blue-50 font-medium text-blue-700' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950'
                  }`}
                >
                  <FontAwesomeIcon icon={item.icon} className="w-4" />
                  {item.label}
                </button>
              ))}
            </nav>
            <div className="mt-auto border-t border-slate-200 pt-4">
              <span className="flex items-center gap-2 text-xs text-slate-500">
                <span className="h-2 w-2 rounded-full bg-emerald-500" /> 会话正常
              </span>
            </div>
          </aside>

          <main id="admin-content" className="min-w-0 flex-1 px-5 py-6 sm:px-8 sm:py-10">
            <nav aria-label="管理导航" className="mb-7 flex gap-1 border-b border-slate-200 pb-3 md:hidden">
              {navItems.map(item => (
                <button
                  key={item.id}
                  type="button"
                  aria-label={item.label}
                  onClick={() => setSection(item.id)}
                  className={`inline-flex h-10 w-10 items-center justify-center rounded-md transition-[background-color,color,transform] active:scale-95 ${
                    section === item.id ? 'bg-blue-50 text-blue-700' : 'text-slate-500 hover:bg-slate-100'
                  }`}
                >
                  <FontAwesomeIcon icon={item.icon} />
                </button>
              ))}
            </nav>

            {message && (
              <div
                role="status"
                className={`mb-6 flex items-center gap-2 border-b pb-3 text-sm ${
                  message.type === 'success' ? 'border-emerald-200 text-emerald-700' : 'border-red-200 text-red-700'
                }`}
              >
                <FontAwesomeIcon icon={message.type === 'success' ? faCheck : faCircleInfo} />
                {message.text}
              </div>
            )}

            {section === 'overview' && (
              <div className="max-w-3xl divide-y divide-slate-200">
                <section className="pb-7">
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">运行状态</p>
                  <div className="mt-5 grid grid-cols-1 gap-x-10 gap-y-5 sm:grid-cols-2">
                    <div>
                      <p className="text-sm text-slate-500">天翼云</p>
                      <p className="mt-1 flex items-center gap-2 text-sm font-medium text-slate-900"><span className="h-2 w-2 rounded-full bg-emerald-500" />已配置</p>
                    </div>
                    <div>
                      <p className="text-sm text-slate-500">OneDrive</p>
                      <p className="mt-1 flex items-center gap-2 text-sm font-medium text-slate-900"><span className={`h-2 w-2 rounded-full ${siteConfig.onedriveMountPath ? 'bg-emerald-500' : 'bg-slate-300'}`} />{siteConfig.onedriveMountPath ? '已启用' : '未启用'}</p>
                    </div>
                    <div>
                      <p className="text-sm text-slate-500">受保护路径</p>
                      <p className="mt-1 font-mono text-sm font-medium tabular-nums text-slate-900">{tyRoutes.length + odRoutes.length} 条</p>
                    </div>
                    <div>
                      <p className="text-sm text-slate-500">管理员会话</p>
                      <p className="mt-1 font-mono text-sm font-medium tabular-nums text-slate-900">7 天有效</p>
                    </div>
                  </div>
                </section>
                <section className="py-7">
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">实例</p>
                  <dl className="mt-4 grid gap-x-8 gap-y-3 text-sm sm:grid-cols-[9rem_1fr]">
                    <dt className="text-slate-500">管理员</dt><dd className="text-slate-900">{initialSession?.username || 'admin'}</dd>
                    <dt className="text-slate-500">上次访问</dt><dd className="font-mono tabular-nums text-slate-900">{initialSession ? new Date(initialSession.lastAccessAt).toLocaleString('zh-CN') : '-'}</dd>
                    <dt className="text-slate-500">天翼云挂载</dt><dd><code className="text-slate-900">{siteConfig.tianyiMountPath || '未启用'}</code></dd>
                    <dt className="text-slate-500">OneDrive 挂载</dt><dd><code className="text-slate-900">{siteConfig.onedriveMountPath || '未启用'}</code></dd>
                    <dt className="text-slate-500">构建版本</dt><dd className="font-mono text-xs text-slate-700">{process.env.NEXT_PUBLIC_GIT_COMMIT_HASH || 'unknown'} · {process.env.NEXT_PUBLIC_BUILD_DATE || 'unknown'}</dd>
                  </dl>
                </section>
              </div>
            )}

            {section === 'protection' && (
              <div className="max-w-3xl">
                {routeEditor('ty', '天翼云', tyRoutes, newTyRoute, setNewTyRoute)}
                {routeEditor('od', 'OneDrive', odRoutes, newOdRoute, setNewOdRoute)}
                <div className="mt-6 flex flex-wrap items-center gap-3">
                  <button type="button" onClick={saveProtectedRoutes} disabled={loading} className="inline-flex min-h-[40px] items-center gap-2 rounded-md bg-blue-600 px-4 text-sm font-medium text-white transition-[background-color,transform] hover:bg-blue-700 active:scale-95 disabled:opacity-50">
                    <FontAwesomeIcon icon={saved ? faCheck : faLock} /> {loading ? '保存中' : saved ? '已保存' : '保存规则'}
                  </button>
                  <button type="button" onClick={refreshProtectedRoutes} disabled={loading} className="inline-flex min-h-[40px] items-center gap-2 rounded-md px-3 text-sm text-slate-600 transition-[background-color,color,transform] hover:bg-slate-100 hover:text-slate-950 active:scale-95 disabled:opacity-50">
                    <FontAwesomeIcon icon={faRotate} /> 重新读取
                  </button>
                  <button type="button" onClick={resetProtectedRoutes} disabled={loading} className="inline-flex min-h-[40px] items-center gap-2 rounded-md px-3 text-sm text-slate-600 transition-[background-color,color,transform] hover:bg-slate-100 hover:text-slate-950 active:scale-95 disabled:opacity-50">
                    恢复环境变量
                  </button>
                </div>
              </div>
            )}

            {section === 'configuration' && (
              <div className="max-w-3xl">
                <section className="border-b border-slate-200 py-7 first:pt-0">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h2 className="text-sm font-semibold text-slate-950">运行时配置</h2>
                      <p className="mt-2 text-sm leading-6 text-slate-500">敏感值使用 CONFIG_MASTER_KEY 加密后存入 Redis，只显示是否已配置。未保存的字段不会改变当前服务。</p>
                    </div>
                    <button type="button" onClick={loadRuntimeConfig} disabled={loading} className="inline-flex min-h-[40px] items-center gap-2 rounded-md px-3 text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-50">
                      <FontAwesomeIcon icon={faRotate} /> 读取
                    </button>
                    <button type="button" onClick={testConnections} disabled={loading} className="inline-flex min-h-[40px] items-center gap-2 rounded-md px-3 text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-50">
                      <FontAwesomeIcon icon={faCheck} /> 测试连接
                    </button>
                    <button type="button" onClick={loadAuditLogs} disabled={loading} className="inline-flex min-h-[40px] items-center gap-2 rounded-md px-3 text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-50">
                      <FontAwesomeIcon icon={faCircleInfo} /> 审计日志
                    </button>
                  </div>
                  {runtimeMeta ? (
                    <div className="mt-5 space-y-3">
                      {runtimeMeta.values.map((item: any) => (
                        <div key={item.key} className="grid gap-2 border-b border-slate-100 pb-3 sm:grid-cols-[12rem_1fr_auto] sm:items-center">
                          <label className="text-sm text-slate-600">{item.key}</label>
                          {item.sensitive ? (
                            <span className="text-sm text-slate-500">{item.configured ? `已配置（${item.source}）` : '未配置'}</span>
                          ) : (
                            <input value={runtimeValues[item.key] || ''} onChange={event => setRuntimeValues(current => ({ ...current, [item.key]: event.target.value }))} className="min-w-0 rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-600" />
                          )}
                          {item.sensitive && <button type="button" onClick={() => generateRuntimeSecret(item.key)} disabled={loading} className="text-xs text-blue-700 hover:underline disabled:opacity-50">生成密钥</button>}
                        </div>
                      ))}
                      <button type="button" onClick={saveRuntimeConfig} disabled={loading} className="inline-flex min-h-[40px] items-center gap-2 rounded-md bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"><FontAwesomeIcon icon={faCheck} /> 保存配置</button>
                    </div>
                  ) : <p className="mt-5 text-sm text-slate-400">点击“读取”加载配置状态。</p>}
                  {connectionTests && <div className="mt-4 space-y-2 text-sm text-slate-600">{(Object.entries(connectionTests) as Array<[string, any]>).map(([key, item]: [string, any]) => (<div key={key} className={`border-b border-slate-100 pb-2 ${item.ok ? 'text-emerald-700' : 'text-red-700'}`}><strong>{key}</strong>：{item.message}</div>))}</div>}
                  {auditLogs.length > 0 && <div className="mt-4 max-h-64 overflow-y-auto space-y-2 text-sm text-slate-600">{auditLogs.map((log: any) => (<div key={log.timestamp + log.action} className="border-b border-slate-100 pb-2"><code className="text-xs text-slate-500">{new Date(log.timestamp).toLocaleString()}</code> <strong>{log.action}</strong> {log.key ? `key=${log.key}` : ''} {log.admin ? `admin=${log.admin}` : ''}</div>))}</div>}
                </section>
                <section className="py-7">
                  <div className="flex items-start justify-between gap-4">
                    <div><h2 className="text-sm font-semibold text-slate-950">Cloudflare WebDAV Worker</h2><p className="mt-2 text-sm leading-6 text-slate-500">网页只查询部署状态和同步 Worker Secret。Worker 代码部署继续使用本地 Wrangler。</p></div>
                    <button type="button" onClick={loadWorkerStatus} disabled={loading} className="inline-flex min-h-[40px] items-center gap-2 rounded-md px-3 text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-50"><FontAwesomeIcon icon={faRotate} /> 状态</button>
                  </div>
                  {workerStatus && <div className="mt-4 space-y-2 text-sm text-slate-600"><p>Worker：<code>{workerStatus.workerName}</code></p><p>状态：{workerStatus.configured ? (workerStatus.reachable ? 'Cloudflare API 可访问' : '不可访问') : '未配置 Cloudflare API'}</p><p>Secret：{workerStatus.secretConfigured ? '主站已配置' : '主站未配置'}</p><p>WebDAV 开关：{workerStatus.webdavEnabled ? '已开启' : '已关闭'}</p><p>版本：{workerStatus.latest?.version || '-'}</p><p>最后部署：{workerStatus.latest?.createdAt ? new Date(workerStatus.latest.createdAt).toLocaleString() : '-'}</p>{workerStatus.history?.length > 0 && <div className="mt-2 max-h-40 overflow-y-auto divide-y divide-slate-100"><p className="text-xs text-slate-500">最近部署：</p>{workerStatus.history.map((item: any) => (<div key={item.id} className="py-1 text-xs"><code>{item.id}</code> {item.createdAt ? new Date(item.createdAt).toLocaleString() : ''} {item.status && <span className="text-slate-500">({item.status})</span>}</div>))}</div>}<button type="button" onClick={syncWorkerSecret} disabled={loading || !workerStatus.configured} className="mt-2 inline-flex min-h-[40px] items-center gap-2 rounded-md bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"><FontAwesomeIcon icon={faShieldHalved} /> 同步 Worker 密钥</button><button type="button" onClick={() => toggleWebDav(!workerStatus.webdavEnabled)} disabled={loading || !workerStatus.configured} className="ml-2 inline-flex min-h-[40px] items-center gap-2 rounded-md bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50">{workerStatus.webdavEnabled ? '关闭 WebDAV' : '开启 WebDAV'}</button></div>}
                </section>
              </div>
            )}

            {section === 'maintenance' && (
              <div className="max-w-3xl">
                <section className="border-b border-slate-200 py-7 first:pt-0">
                  <h2 className="text-sm font-semibold text-slate-950">云盘缓存</h2>
                  <p className="mt-2 max-w-xl text-sm leading-6 text-slate-500">清除天翼云会话与 OneDrive access token。refresh token 会被保留，下次请求将自动重新建立连接。</p>
                  <button type="button" onClick={clearCache} disabled={loading} className="mt-4 inline-flex min-h-[40px] items-center gap-2 rounded-md px-3 text-sm font-medium text-red-700 transition-[background-color,transform] hover:bg-red-50 active:scale-95 disabled:opacity-50">
                    <FontAwesomeIcon icon={faTrashCan} /> {loading ? '清除中' : '清除缓存'}
                  </button>
                </section>
                <section className="py-7">
                  <h2 className="text-sm font-semibold text-red-700">危险区域</h2>
                  <p className="mt-2 max-w-xl text-sm leading-6 text-slate-500">退出后将清除当前浏览器的管理员会话，需要重新登录才能继续管理。</p>
                  <button type="button" onClick={handleLogout} disabled={loading} className="mt-4 inline-flex min-h-[40px] items-center gap-2 rounded-md bg-red-600 px-3 text-sm font-medium text-white transition-[background-color,transform] hover:bg-red-700 active:scale-95 disabled:opacity-50">
                    <FontAwesomeIcon icon={faRightFromBracket} /> 退出登录
                  </button>
                </section>
              </div>
            )}
          </main>
        </div>
      </div>
    </>
  )
}

export async function getServerSideProps({ req, locale }: GetServerSidePropsContext) {
  const token = getTokenFromReq(req as any)
  const session = await verifyAdminSession(token)
  if (!session) {
    return { redirect: { destination: '/@login?redirect=/@manage', permanent: false } }
  }

  const [ty, od] = await Promise.all([getProtectedRoutes(), getProtectedRoutesOd()])
  return {
    props: {
      initialIsAdmin: true,
      initialSession: { username: session.username, createdAt: session.createdAt, lastAccessAt: session.lastAccessAt },
      initialProtectedRoutes: ty,
      initialProtectedRoutesOd: od,
      ...(await serverSideTranslations(locale || 'zh-CN', ['common'])),
    },
  }
}
