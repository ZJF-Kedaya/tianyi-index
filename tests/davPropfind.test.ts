/**
 * WebDAV PROPFIND 协议修复的回归测试。
 *
 * 背景：DAV 路径曾把所有 OneDrive 后端故障（token 过期 401、上游 5xx、网络抖动）
 * 统一伪装成 HTTP 404 返回，客户端表现为
 * `NoSuchFileException: /OneDrive: HTTP 404` 或网盘直接消失；
 * 同时 PROPFIND 响应缺少请求资源自身条目且忽略 Depth 头，违反 RFC 4918 §9.1，
 * 导致不同客户端挂载行为不一致（有的只显示一个网盘）。
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import { buildPropfindXml, listingErrorStatus, parseDavDepth, parseDavPath } from '../src/pages/api/dav/[[...path]].ts'

test('parseDavPath resolves the encoded Chinese drive name', () => {
  assert.deepEqual(parseDavPath(['%E5%A4%A9%E7%BF%BC%E4%BA%91%E7%9B%98', 'docs']), {
    drive: 'ty',
    subPath: '/docs',
  })
})

test('parseDavPath resolves decoded drive names too (Next.js passes them decoded)', () => {
  assert.deepEqual(parseDavPath(['天翼云盘']), { drive: 'ty', subPath: '/' })
  assert.deepEqual(parseDavPath(['OneDrive', 'a b', 'c.txt']), { drive: 'od', subPath: '/a b/c.txt' })
})

test('parseDavPath rejects unknown drive names; empty segment maps to root', () => {
  assert.deepEqual(parseDavPath(['']), { drive: 'root', subPath: '/' })
  assert.equal(parseDavPath(['google-drive']), null)
})

test('parseDavDepth defaults to 1 and honors explicit 0', () => {
  assert.equal(parseDavDepth(undefined), 1)
  assert.equal(parseDavDepth('1'), 1)
  // RFC 默认 infinity，本服务有界化为 1
  assert.equal(parseDavDepth('infinity'), 1)
  assert.equal(parseDavDepth('0'), 0)
  assert.equal(parseDavDepth(['0']), 0)
})

test('only genuine not-found maps to 404; backend faults must be 5xx', () => {
  assert.equal(listingErrorStatus('not_found'), 404)
  assert.equal(listingErrorStatus('transient'), 502)
})

test('PROPFIND XML includes the request resource itself before children', () => {
  const self = {
    href: '/',
    displayName: '.',
    isCollection: true,
    contentType: 'httpd/unix-directory',
    lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
  }
  const child = {
    href: '/OneDrive/',
    displayName: 'OneDrive',
    isCollection: true,
    contentType: 'httpd/unix-directory',
    lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
  }
  const xml = buildPropfindXml([self, child])
  const hrefs = [...xml.matchAll(/<href>([^<]+)<\/href>/g)].map(m => m[1])
  assert.deepEqual(hrefs, ['/', '/OneDrive/'])
  assert.ok(xml.includes('<collection/>'))
})

test('PROPFIND XML omits missing optional props instead of emitting blank lines', () => {
  const resource = {
    href: '/%E5%A4%A9%E7%BF%BC%E4%BA%91%E7%9B%98/',
    displayName: '天翼云盘',
    isCollection: true,
    contentType: 'httpd/unix-directory',
    lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
  }
  const xml = buildPropfindXml([resource])
  assert.ok(!xml.includes('\n\n'), 'should not contain blank lines from dropped props')
  assert.ok(!xml.includes('getcontentlength'))
})
