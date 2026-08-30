// The other half of the gate's contract, and the one that matters for people
// who already run this: with STASH_PASSWORD unset there is no gate at all.
//
// A characterization test — it passed the moment the gate was written, which is
// the point. Its job is to fail later, if some future change makes auth
// implicitly on and silently locks every existing LAN install out on upgrade.
// Its own process, so it cannot see the password the sibling auth test sets.
delete process.env.STASH_PASSWORD
const { createServer } = await import('../../../server/router.js')

import test, { after } from 'node:test'
import assert from 'node:assert/strict'

const server = createServer()
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`
after(() => server.close())

test('with no password set the API answers directly, with no session anywhere', async () => {
  const res = await fetch(`${BASE}/api/notes`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('set-cookie'), null)
})

test('with no password set a navigation gets the app, not a login page', async () => {
  const res = await fetch(`${BASE}/`)
  assert.doesNotMatch(await res.text(), /name="password"/)
})

test('with no password set the JSON content-type rule does not apply either', async () => {
  // The rule exists to protect a session cookie. With no session to ride,
  // enforcing it would only break clients for no security gain.
  const res = await fetch(`${BASE}/api/notes/nonexistent`, { method: 'DELETE' })
  assert.notEqual(res.status, 415)
})

test('/api/health answers whether or not auth is configured', async () => {
  assert.equal((await fetch(`${BASE}/api/health`)).status, 200)
})

test('/up answers whether or not auth is configured', async () => {
  // Body, not just status — see the sibling assertion in auth-route.test.js:
  // the SPA fallback answers 200 for any unmatched path.
  const res = await fetch(`${BASE}/up`)
  assert.equal(res.status, 200)
  assert.equal((await res.json()).ok, true)
})
