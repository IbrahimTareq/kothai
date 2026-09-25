// Integration tests for the password gate, driven through a REAL listening
// server. The gate's whole claim is that it sits in front of everything the
// router can reach, so testing it by calling handlers directly would test the
// opposite of what matters.
//
// KOTHAI_PASSWORD is set before the dynamic import because server/config.ts
// freezes its resolved config at import time; node --test gives each file its
// own process, so this env var cannot leak into any other test.
process.env.KOTHAI_PASSWORD = 'hunter2'
const { createServer } = await import('../../../server/router.ts')

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { jsonBody, listenOnLoopback } from '../../helpers/http.ts'

const server = createServer()
const BASE = `http://127.0.0.1:${await listenOnLoopback(server)}`
after(() => server.close())

const json = (body: unknown) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const login = (password: string, extra: RequestInit = {}) =>
  fetch(`${BASE}/api/login`, { method: 'POST', ...json({ password }), ...extra })

// Grab the session cookie out of a login response.
async function sessionOf(password = 'hunter2') {
  const res = await login(password)
  const setCookie = res.headers.get('set-cookie')
  assert.ok(setCookie, 'a successful login must set a session cookie')
  return setCookie.split(';')[0]
}

// ---- what is reachable without a session --------------------------------

test('an API request without a session is refused with a machine-readable 401', async () => {
  const res = await fetch(`${BASE}/api/notes`)
  assert.equal(res.status, 401)
  assert.equal((await jsonBody(res)).code, 'auth_required')
})

test('the gate covers uploads too — user content is not served to strangers', async () => {
  const res = await fetch(`${BASE}/uploads/meta-anything.jpg`)
  assert.notEqual(res.status, 200)
})

test('a navigation without a session gets the login page, not a 401 — the SPA shell must not leak either', async () => {
  for (const path of ['/', '/settings', '/space/abc123']) {
    const res = await fetch(`${BASE}${path}`)
    assert.equal(res.status, 200, path)
    const contentType = res.headers.get('content-type')
    assert.ok(contentType, path)
    assert.match(contentType, /text\/html/)
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
  // The claim is about the GATE — that PUBLIC_ASSET lets this one path past
  // unauthenticated — not about whether the bytes are on disk. Those are
  // served out of ./dist, which only exists after a build, so asserting 200
  // made this the single test in the suite that failed on a clean clone, for
  // a reason with nothing to do with authentication.
  //
  // So: a 401 is the regression this test exists to catch (drop PUBLIC_ASSET
  // and the gate renders in a fallback face). A 404 is an unbuilt tree, which
  // is a fact about the checkout. serveStatic's own behaviour is covered
  // against a temp directory in test/server/lib/static-cache.test.ts.
  assert.notEqual(res.status, 401, 'the gate must let the login font through unauthenticated')
})

test('/api/health answers without a session — the container healthcheck has no credentials', async () => {
  // A 401 here would make every orchestrator mark the container unhealthy and
  // restart-loop it forever.
  const res = await fetch(`${BASE}/api/health`)
  assert.equal(res.status, 200)
  assert.equal((await jsonBody(res)).ok, true)
})

test('/api/status stays behind the gate — it reports model config and note count', async () => {
  assert.equal((await fetch(`${BASE}/api/status`)).status, 401)
})

test('/api/checkpoint stays behind the gate — it writes to the database', async () => {
  // A backup tool running inside the container has KOTHAI_PASSWORD in its
  // environment and logs in like any other client. Leaving this endpoint open
  // so it could skip that would hand an unauthenticated stranger a repeatable
  // write and disk-flush.
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
  assert.ok(cookie)
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
  const res = await fetch(`${BASE}/api/notes`, { headers: { cookie: `${cookie.slice(0, -3)}AAA` } })
  assert.equal(res.status, 401)
})

test('logging out clears the cookie', async () => {
  const res = await fetch(`${BASE}/api/logout`, {
    method: 'POST',
    ...json({}),
    headers: { 'Content-Type': 'application/json', cookie: await sessionOf() },
  })
  assert.equal(res.status, 200)
  const cleared = res.headers.get('set-cookie')
  assert.ok(cleared, 'logout must send a cookie that expires the session')
  assert.match(cleared, /Max-Age=0/)
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

test('a backup upload (application/octet-stream) passes the rule — it forces the same preflight JSON does', async () => {
  // A restore body is an archive, not JSON. What the rule protects is the
  // preflight, and octet-stream is no more CORS-safelisted than JSON is.
  const res = await fetch(`${BASE}/api/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', cookie: await sessionOf() },
    body: 'not a backup',
  })
  assert.equal(res.status, 400, 'reached the route, which refused the body itself')
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
  // Twelve attempts, with the first outside the loop so `res` is a Response
  // rather than one that might never have been assigned.
  let res = await login('wrong')
  for (let i = 1; i < 12; i++) res = await login('wrong')
  assert.equal(res.status, 429)
  assert.ok(Number(res.headers.get('retry-after')) > 0)
  // And the lockout is not bypassable by suddenly knowing the password.
  assert.equal((await login('hunter2')).status, 429)
})
