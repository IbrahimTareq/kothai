// The other sign-in state: no KOTHAI_PASSWORD means signIn ['none']. Its own
// file because config.ts freezes the password at import time.
delete process.env.KOTHAI_PASSWORD
const { createServer } = await import('../../../server/router.ts')

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { listenOnLoopback } from '../../helpers/http.ts'

const server = createServer()
const BASE = `http://127.0.0.1:${await listenOnLoopback(server)}`
after(() => server.close())

test('an unknown /api/v1 path is 404 not_found JSON on any method, never the SPA', async () => {
  const get = await fetch(`${BASE}/api/v1/nope`)
  assert.equal(get.status, 404)
  assert.match(get.headers.get('content-type') ?? '', /json/)
  assert.equal(((await get.json()) as { code: string }).code, 'not_found')
  const post = await fetch(`${BASE}/api/v1/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(post.status, 404)
  assert.equal(((await post.json()) as { code: string }).code, 'not_found')
})

test('the router catch-all 500 carries code internal', async () => {
  const res = await fetch(`${BASE}/api/save`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{nope',
  })
  assert.equal(res.status, 500)
  assert.equal(((await res.json()) as { code: string }).code, 'internal')
})

test('info reports signIn none when no password is set', async () => {
  const body = (await (await fetch(`${BASE}/api/v1/info`)).json()) as { signIn: string[] }
  assert.deepEqual(body.signIn, ['none'])
})
