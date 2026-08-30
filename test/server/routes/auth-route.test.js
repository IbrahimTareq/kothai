// Integration tests for the password gate, driven through a REAL listening
// server. The gate's whole claim is that it sits in front of everything the
// router can reach, so testing it by calling handlers directly would test the
// opposite of what matters.
//
// STASH_PASSWORD is set before the dynamic import because server/config.js
// freezes its resolved config at import time; node --test gives each file its
// own process, so this env var cannot leak into any other test.
process.env.STASH_PASSWORD = 'hunter2'
const { createServer } = await import('../../../server/router.js')

import test, { after } from 'node:test'
import assert from 'node:assert/strict'

const server = createServer()
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`
after(() => server.close())

const json = (body) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const login = (password, extra = {}) =>
  fetch(`${BASE}/api/login`, { method: 'POST', ...json({ password }), ...extra })

// Grab the session cookie out of a login response.
async function sessionOf(password = 'hunter2') {
  const res = await login(password)
  const setCookie = res.headers.get('set-cookie')
  return setCookie.split(';')[0]
}

// ---- what is reachable without a session --------------------------------

test('an API request without a session is refused with a machine-readable 401', async () => {
  const res = await fetch(`${BASE}/api/notes`)
  assert.equal(res.status, 401)
  assert.equal((await res.json()).code, 'auth_required')
})

test('the gate covers uploads too — user content is not served to strangers', async () => {
  const res = await fetch(`${BASE}/uploads/meta-anything.jpg`)
  assert.notEqual(res.status, 200)
})

test('a navigation without a session gets the login page, not a 401 — the SPA shell must not leak either', async () => {
  for (const path of ['/', '/settings', '/space/abc123']) {
    const res = await fetch(`${BASE}${path}`)
    assert.equal(res.status, 200, path)
    assert.match(res.headers.get('content-type'), /text\/html/)
    assert.match(await res.text(), /name="password"/)
  }
})

test('a hashed asset without a session is refused rather than answered with login HTML', async () => {
  // Serving the login page here would hand the browser HTML where it asked for
  // JavaScript, which surfaces as a confusing syntax error instead of a login.
  const res = await fetch(`${BASE}/assets/index-abc12345.js`)
  assert.equal(res.status, 401)
})

test('the login page can load its font, so the gate does not have to be ugly', async () => {
  const res = await fetch(`${BASE}/vendor/fonts/Geist-latin.woff2`)
  assert.equal(res.status, 200)
})

test('/api/health answers without a session — the container healthcheck has no credentials', async () => {
  // A 401 here would make every orchestrator mark the container unhealthy and
  // restart-loop it forever.
  const res = await fetch(`${BASE}/api/health`)
  assert.equal(res.status, 200)
  assert.equal((await res.json()).ok, true)
})

test('/up answers without a session — ONCE probes it with no credentials', async () => {
  // ONCE (basecamp/once) requires a /up endpoint returning success, and polls
  // it to decide whether the app came up.
  //
  // Asserting the JSON body, not just the 200: every unmatched path already
  // returns 200 via the SPA fallback, so a status-only assertion would pass
  // against the login page and prove nothing. A health probe answered with an
  // HTML login form is not a health probe — and it would stop being a 200 at
  // all the moment dist/ is missing.
  const res = await fetch(`${BASE}/up`)
  assert.equal(res.status, 200)
  assert.equal((await res.json()).ok, true)
})

test('/api/status stays behind the gate — it reports model config and note count', async () => {
  assert.equal((await fetch(`${BASE}/api/status`)).status, 401)
})

test('/api/checkpoint stays behind the gate — it writes to the database', async () => {
  // The ONCE pre-backup hook runs inside the container, so it has STASH_PASSWORD
  // in its environment and logs in like any other client. Leaving this endpoint
  // open so the hook could skip that would hand an unauthenticated stranger a
  // repeatable write and disk-flush.
  const res = await fetch(`${BASE}/api/checkpoint`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })
  assert.equal(res.status, 401)
})

test('/api/backup stays behind the gate — it hands over the entire database', async () => {
  assert.equal((await fetch(`${BASE}/api/backup`)).status, 401)
})

// ---- logging in ---------------------------------------------------------

test('the wrong password is refused and sets no cookie', async () => {
  const res = await login('wrong')
  assert.equal(res.status, 401)
  assert.equal(res.headers.get('set-cookie'), null)
})

test('the right password returns a hardened session cookie', async () => {
  const res = await login('hunter2')
  assert.equal(res.status, 200)
  const cookie = res.headers.get('set-cookie')
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /SameSite=Lax/)
  // Plain HTTP here, so Secure must be absent or the browser drops the cookie.
  assert.doesNotMatch(cookie, /Secure/)
})

test('a session cookie unlocks the API', async () => {
  const res = await fetch(`${BASE}/api/notes`, { headers: { cookie: await sessionOf() } })
  assert.equal(res.status, 200)
})

test('a tampered session cookie is refused', async () => {
  const cookie = await sessionOf()
  const res = await fetch(`${BASE}/api/notes`, { headers: { cookie: cookie.slice(0, -3) + 'AAA' } })
  assert.equal(res.status, 401)
})

test('logging out clears the cookie', async () => {
  const res = await fetch(`${BASE}/api/logout`, {
    method: 'POST', ...json({}), headers: { 'Content-Type': 'application/json', cookie: await sessionOf() },
  })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('set-cookie'), /Max-Age=0/)
})

// ---- CSRF ---------------------------------------------------------------

test('a mutation without a JSON content-type is refused even with a valid session', async () => {
  // SameSite=Lax is site-based and ignores the port, so http://localhost:3000
  // counts as same-site with a Kothai on :5173 and its cookie WOULD ride along.
  // Requiring application/json is what actually stops that: it is not a
  // CORS-safelisted content type, so the browser must preflight, and an HTML
  // form can never produce it at all.
  const res = await fetch(`${BASE}/api/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', cookie: await sessionOf() },
    body: 'text=pwned',
  })
  assert.equal(res.status, 415)
})

test('the same rule covers DELETE and PATCH, which carry no body of their own', async () => {
  const cookie = await sessionOf()
  for (const method of ['DELETE', 'PATCH']) {
    const res = await fetch(`${BASE}/api/notes/whatever`, { method, headers: { cookie } })
    assert.equal(res.status, 415, method)
  }
})

test('GET is never blocked by the content-type rule — it changes nothing', async () => {
  const res = await fetch(`${BASE}/api/notes`, { headers: { cookie: await sessionOf() } })
  assert.equal(res.status, 200)
})

// ---- brute force --------------------------------------------------------

test('repeated wrong passwords lock the source out with a Retry-After', async () => {
  // Kept last: it exhausts this source address's budget for the window.
  let res
  for (let i = 0; i < 12; i++) res = await login('wrong')
  assert.equal(res.status, 429)
  assert.ok(Number(res.headers.get('retry-after')) > 0)
  // And the lockout is not bypassable by suddenly knowing the password.
  assert.equal((await login('hunter2')).status, 429)
})
