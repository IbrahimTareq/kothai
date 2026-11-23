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

test('info reports signIn none when no password is set', async () => {
  const body = (await (await fetch(`${BASE}/api/v1/info`)).json()) as { signIn: string[] }
  assert.deepEqual(body.signIn, ['none'])
})
