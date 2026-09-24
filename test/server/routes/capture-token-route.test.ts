// The capture token, driven through a REAL listening server for the same
// reason auth-route.test.ts is: its claim is about what the gate lets past,
// and calling handlers directly would skip the gate entirely.
//
// "Let past" is read off /api/save's own answer to a non-link body: 400
// links_only means the request reached the handler, 401 means the gate
// stopped it. Nothing is ever saved.
//
// Both env vars are set before the dynamic import because server/config.ts
// freezes at import time; node --test gives each file its own process.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
process.env.KOTHAI_PASSWORD = 'hunter2'
process.env.KOTHAI_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'kothai-capture-route-'))
const { createServer } = await import('../../../server/router.ts')

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { jsonBody, listenOnLoopback } from '../../helpers/http.ts'

const server = createServer()
const BASE = `http://127.0.0.1:${await listenOnLoopback(server)}`
after(() => server.close())

const JSON_TYPE = { 'Content-Type': 'application/json' }

async function session() {
  const res = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: JSON_TYPE,
    body: JSON.stringify({ password: 'hunter2' }),
  })
  return (res.headers.get('set-cookie') ?? '').split(';')[0]
}

const tokenRoute = async (method: string) =>
  fetch(`${BASE}/api/capture-token`, { method, headers: { ...JSON_TYPE, cookie: await session() } })

const saveWith = (token: string) =>
  fetch(`${BASE}/api/save`, {
    method: 'POST',
    headers: { ...JSON_TYPE, Authorization: `Bearer ${token}` },
    body: JSON.stringify({ text: 'not a link' }),
  })

test('with no token created, a bearer token is refused at the gate', async () => {
  assert.equal((await saveWith('anything')).status, 401)
  assert.deepEqual(await jsonBody(await tokenRoute('GET')), { exists: false, gated: true })
})

test('a created token is returned once, and never again', async () => {
  const created = await jsonBody(await tokenRoute('POST'))
  assert.equal(typeof created.token, 'string')
  assert.ok((created.token as string).length >= 43, '32 random bytes, base64url')
  const state = await jsonBody(await tokenRoute('GET'))
  assert.deepEqual(state, { exists: true, gated: true })
})

test('the token opens POST /api/save and nothing else', async () => {
  const { token } = (await jsonBody(await tokenRoute('POST'))) as { token: string }
  const save = await saveWith(token)
  assert.equal(save.status, 400)
  assert.equal((await jsonBody(save)).code, 'links_only')

  const auth = { Authorization: `Bearer ${token}` }
  assert.equal((await fetch(`${BASE}/api/notes`, { headers: auth })).status, 401)
  assert.equal((await fetch(`${BASE}/api/export`, { headers: auth })).status, 401)
  // A leaked token must not be able to mint its own replacement or revoke yours.
  for (const method of ['GET', 'POST', 'DELETE']) {
    const res = await fetch(`${BASE}/api/capture-token`, { method, headers: { ...JSON_TYPE, ...auth } })
    assert.equal(res.status, 401, method)
  }
})

test('a wrong token is refused', async () => {
  const { token } = (await jsonBody(await tokenRoute('POST'))) as { token: string }
  assert.equal((await saveWith(`${token}x`)).status, 401)
})

test('regenerating revokes the old token', async () => {
  const { token: first } = (await jsonBody(await tokenRoute('POST'))) as { token: string }
  const { token: second } = (await jsonBody(await tokenRoute('POST'))) as { token: string }
  assert.equal((await saveWith(first)).status, 401)
  assert.equal((await saveWith(second)).status, 400)
})

test('revoking stops the token working', async () => {
  const { token } = (await jsonBody(await tokenRoute('POST'))) as { token: string }
  assert.deepEqual(await jsonBody(await tokenRoute('DELETE')), { exists: false, gated: true })
  assert.equal((await saveWith(token)).status, 401)
})

test('the token does not lift the JSON rule — it is not a way round the CSRF check', async () => {
  const { token } = (await jsonBody(await tokenRoute('POST'))) as { token: string }
  const res = await fetch(`${BASE}/api/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', Authorization: `Bearer ${token}` },
    body: 'text=https://example.com',
  })
  assert.equal(res.status, 415)
})
