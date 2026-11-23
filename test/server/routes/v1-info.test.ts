// /api/v1/info is the one v1 route in front of the password gate, so it is
// tested against a server that HAS a password: the claim is that it answers
// with no session while its siblings still 401.
//
// Env is set before the dynamic import because server/config.ts freezes at
// import time; its own data dir so routes past the gate never touch ./data.
process.env.KOTHAI_PASSWORD = 'hunter2'
const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'kothai-v1-info-test-'))
process.env.KOTHAI_DATA_DIR = DATA_DIR
const { createServer } = await import('../../../server/router.ts')

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { API_VERSION, type Info } from '@kothai/api'
import { listenOnLoopback } from '../../helpers/http.ts'

const server = createServer()
const BASE = `http://127.0.0.1:${await listenOnLoopback(server)}`
after(() => {
  server.close()
  rmSync(DATA_DIR, { recursive: true, force: true })
})

test('info answers without a session when a password is set', async () => {
  const res = await fetch(`${BASE}/api/v1/info`)
  assert.equal(res.status, 200)
  const body = (await res.json()) as Info
  assert.deepEqual(body.signIn, ['password'])
  assert.equal(body.apiVersion, 1)
  assert.equal(body.apiVersion, API_VERSION)
  assert.equal(body.minClientVersion, 1)
  assert.equal(body.cloud, false)
})

test('info never carries counts', async () => {
  const body = (await (await fetch(`${BASE}/api/v1/info`)).json()) as object
  assert.deepEqual(Object.keys(body).sort(), ['apiVersion', 'cloud', 'minClientVersion', 'signIn'])
})

test('the auth gate still answers 401 for /api/v1/notes without a session', async () => {
  assert.equal((await fetch(`${BASE}/api/v1/notes`)).status, 401)
})
