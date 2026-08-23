import { strict as assert } from 'node:assert'
import { createHmac } from 'node:crypto'
import test from 'node:test'

import { parseProtectedToken, signProtectedToken } from '../src/utils/protectedTokenSigner'

process.env.PROTECTED_TOKEN_SECRET = 'regression-test-secret'

function encodePayload(payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = createHmac('sha256', process.env.PROTECTED_TOKEN_SECRET as string).update(JSON.stringify(payload)).digest('base64url')
  return `${body}.${signature}`
}

test('signs and parses the current protected token format', () => {
  const token = signProtectedToken('/private')
  assert.ok(token)
  assert.deepEqual(parseProtectedToken(token), { path: '/private', valid: true })
})

test('rejects legacy tokens without the version marker', () => {
  const legacyToken = encodePayload({ exp: Date.now() + 60_000, path: '/', nonce: 'legacy' })
  assert.deepEqual(parseProtectedToken(legacyToken), { path: '', valid: false })
})
