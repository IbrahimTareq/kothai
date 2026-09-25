// /api/drive on an install with no usable Google client: the id set but not
// the secret, which must count as no client at all rather than a sign-in that
// fails at Google. Its own file because drive.ts reads the environment once, at
// import, and node --test gives each file its own process.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { jsonBody, listenOnLoopback } from '../../helpers/http.ts'

const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'kothai-drive-unconfigured-test-'))
process.env.KOTHAI_DATA_DIR = DATA_DIR
process.env.KOTHAI_GOOGLE_CLIENT_ID = 'client.apps.googleusercontent.com'
delete process.env.KOTHAI_GOOGLE_CLIENT_SECRET

const { createServer } = await import('../../../server/router.ts')
const server = createServer()
const BASE = `http://127.0.0.1:${await listenOnLoopback(server)}`
after(() => {
  server.close()
  rmSync(DATA_DIR, { recursive: true, force: true })
})

test('Settings is told Drive is not set up, so it can say so rather than offer a button that fails', async () => {
  const body = await jsonBody(await fetch(`${BASE}/api/drive`))
  assert.equal(body.configured, false)
  assert.equal(body.connected, false)
})

test('connecting is refused with a code the client can explain', async () => {
  const res = await fetch(`${BASE}/api/drive/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  assert.equal(res.status, 409)
  assert.equal((await jsonBody(res)).code, 'drive_not_configured')
})
