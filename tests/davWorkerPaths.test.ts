/**
 * WebDAV Worker 路径映射回归测试。
 *
 * 背景：下载走"上游 302 → 外部直链（Graph / 天翼文件服务器）"的流程，
 * Worker 的 Location 消毒逻辑曾把跨域 Location 当成泄漏删掉，
 * 导致客户端收到没有目的地的 302、所有文件都无法下载。
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

async function loadWorkerPaths() {
  const mod: any = await import('../workers/webdav/src/index.ts')
  // tsx 把 ESM 转 CJS 后，命名导出挂在 module.exports 上，default 另有其物
  const source = typeof mod.davPathFromUpstreamPathname === 'function' ? mod : (mod.default ?? mod)
  return { davPathFromUpstreamPathname: source.davPathFromUpstreamPathname, externalFromDavPath: source.externalFromDavPath }
}

test('maps upstream /api/dav/* paths back to internal dav space', async () => {
  const { davPathFromUpstreamPathname } = await loadWorkerPaths()
  assert.equal(davPathFromUpstreamPathname('/api/dav'), '/dav/')
  assert.equal(davPathFromUpstreamPathname('/api/dav/OneDrive/'), '/dav/OneDrive/')
  assert.equal(
    davPathFromUpstreamPathname('/api/dav/%E5%A4%A9%E7%BF%BC%E4%BA%91%E7%9B%98/docs/'),
    '/dav/%E5%A4%A9%E7%BF%BC%E4%BA%91%E7%9B%98/docs/',
  )
})

test('rejects upstream paths outside the DAV mount', async () => {
  const { davPathFromUpstreamPathname } = await loadWorkerPaths()
  assert.equal(davPathFromUpstreamPathname('/api/ty/'), null)
  assert.equal(davPathFromUpstreamPathname('/@login'), null)
  assert.equal(davPathFromUpstreamPathname('/'), null)
})

test('strips the internal /dav prefix for client-facing URLs', async () => {
  const { externalFromDavPath } = await loadWorkerPaths()
  assert.equal(externalFromDavPath('/dav'), '/')
  assert.equal(externalFromDavPath('/dav/'), '/')
  assert.equal(externalFromDavPath('/dav/OneDrive/'), '/OneDrive/')
})
