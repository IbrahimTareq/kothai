// The public demo's gate, driven through a REAL listening server for the same
// reason as the password gate's tests: its claim is about everything the router
// can reach, which calling handlers directly cannot test.
//
// KOTHAI_DEMO is set before the dynamic import because server/config.ts freezes
// its resolved config at import time; node --test gives each file its own
// process, so it cannot leak into any other test. The data dir is a temp one so
// that a request slipping past the gate could never write to a real library.
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.KOTHAI_DEMO = '1'
process.env.KOTHAI_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'kothai-demo-gate-'))
const { createServer } = await import('../../../server/router.ts')

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { jsonBody, listenOnLoopback } from '../../helpers/http.ts'

const server = createServer()
const BASE = `http://127.0.0.1:${await listenOnLoopback(server)}`
after(() => server.close())

const call = (method: string, p: string) =>
  fetch(`${BASE}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : '{}',
  })

// Every one of these either rewrites the shared library, spends the operator's
// inference budget, hands over the whole library, or makes the server fetch a
// URL the visitor chose.
const REFUSED: [string, string][] = [
  ['POST', '/api/wipe'],
  ['POST', '/api/import'],
  ['POST', '/api/settings'],
  ['POST', '/api/setup'],
  ['POST', '/api/setup/test'],
  ['POST', '/api/setup/endpoint'],
  ['POST', '/api/settings/endpoint'],
  ['DELETE', '/api/settings/endpoint'],
  ['POST', '/api/telegram'],
  ['GET', '/api/telegram'],
  ['GET', '/api/export'],
  ['GET', '/api/backup'],
  ['POST', '/api/checkpoint'],
  ['POST', '/api/enrich/retag-all'],
  ['POST', '/api/enrich/backlog'],
  ['POST', '/api/availability/scan'],
  ['PATCH', '/api/notes/abc'],
  ['DELETE', '/api/notes/abc'],
  ['POST', '/api/notes/abc/retag'],
  ['PATCH', '/api/collections/abc'],
  ['POST', '/api/collections/abc/items'],
  ['DELETE', '/api/collections/abc/items/x'],
  ['DELETE', '/api/chats/abc'],
  ['DELETE', '/api/models/files/x.gguf'],
]

for (const [method, p] of REFUSED) {
  test(`the demo refuses ${method} ${p}`, async () => {
    const res = await call(method, p)
    assert.equal(res.status, 403)
    assert.equal((await jsonBody(res)).code, 'demo')
  })
}

test('the demo still serves the library', async () => {
  assert.equal((await call('GET', '/api/notes')).status, 200)
})

test('the demo lets a save and a question through to their handlers', async () => {
  // An empty body is the handlers' own 400, which proves the gate passed the
  // request on without making either one do any work.
  assert.equal((await call('POST', '/api/save')).status, 400)
  assert.equal((await call('POST', '/api/ask')).status, 400)
})

test('the demo lets a visitor make a space and delete one', async () => {
  // Both reach their handlers: an empty body is creation's own 400, and whose
  // space it is — here, nobody's — is the delete handler's own 404.
  assert.equal((await call('POST', '/api/collections')).status, 400)
  assert.equal((await call('DELETE', '/api/collections/abc')).status, 404)
})

test('the demo still answers the healthcheck', async () => {
  assert.equal((await call('GET', '/api/health')).status, 200)
})

test('the demo gives each new visitor their own id', async () => {
  const res = await call('GET', '/api/notes')
  assert.match(res.headers.get('set-cookie') ?? '', /^kothai_visitor=[0-9a-f-]{36};/)
})
