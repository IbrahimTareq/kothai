// The optional password gate: one shared password, a signed session cookie, and
// the login screen. Kothai is single-user, so this exists to make a public URL
// safe to expose — not to model identity.
//
// Off unless STASH_PASSWORD is set. Every LAN and Tailscale install keeps
// working exactly as before an upgrade.
import path from 'node:path'
import { json, readBody } from '../lib/http.js'
import {
  COOKIE_NAME, clearedCookie, createThrottle, isSecureRequest, issueSession,
  parseCookies, passwordMatches, sessionCookie, verifySession,
} from '../lib/auth.js'

const MUTATIONS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
// The login screen's only dependency. Font files carry no data, and the
// alternative is a gate that renders in a fallback face on a design-led app.
const PUBLIC_ASSET = /^\/vendor\/fonts\//
// Bounds what an unauthenticated caller can make the server buffer.
const LOGIN_BODY_LIMIT = 4096

const loginThrottle = createThrottle()

// The socket address, deliberately NOT x-forwarded-for: without a
// trusted-proxy list XFF is caller-supplied, so keying on it lets an attacker
// rotate the header and skip the throttle entirely. The cost is that behind a
// reverse proxy every client shares one bucket — for a single-user app that is
// nearly free, and a 15-minute self-healing lockout is the worst case.
const clientKey = (req) => req.socket?.remoteAddress || 'unknown'

export function hasSession(req, password) {
  return verifySession(parseCookies(req.headers.cookie)[COOKIE_NAME], password)
}

// A path the SPA would route client-side (no file extension), as opposed to an
// asset request. Serving login HTML in answer to a request for a .js bundle
// surfaces as a syntax error in the console instead of a login form.
const isNavigation = (p) => !p.startsWith('/api/') && !path.extname(p)

const isJson = (req) => (req.headers['content-type'] || '').toLowerCase().startsWith('application/json')

function send(res, code, headers, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers })
  res.end(JSON.stringify(body))
}

async function handleLogin(req, res, { password, secure }) {
  const key = clientKey(req)
  const gate = loginThrottle.check(key)
  if (!gate.allowed) {
    return send(res, 429, { 'Retry-After': String(gate.retryAfterSec) },
      { error: 'Too many attempts. Try again shortly.', code: 'rate_limited' })
  }
  let body = {}
  try {
    body = await readBody(req, LOGIN_BODY_LIMIT)
  } catch {
    /* an unparseable body is just a failed attempt */
  }
  if (!passwordMatches(body?.password ?? '', password)) {
    loginThrottle.fail(key)
    return json(res, 401, { error: 'Incorrect password.', code: 'bad_password' })
  }
  loginThrottle.succeed(key)
  send(res, 200, { 'Set-Cookie': sessionCookie(issueSession(password), { secure }) }, { ok: true })
}

// Returns true when it has answered the request and the router must stop.
//
// Order matters: the content-type check runs before anything else so it also
// covers /api/login, and login/logout are handled whatever the session state
// is (logging in while already holding a session is not an error).
export async function authGate(req, res, pathname, { password }) {
  const secure = isSecureRequest(req)

  if (MUTATIONS.has(req.method) && !isJson(req)) {
    // CSRF. SameSite=Lax on the cookie blocks the cross-SITE case, but "site"
    // ignores the port — a page on http://localhost:3000 is same-site with a
    // Kothai on :5173 and its cookie would ride along. application/json is not
    // a CORS-safelisted content type, so requiring it forces a preflight that
    // the router answers with 405, and an HTML form cannot produce it at all.
    json(res, 415, { error: 'Requests that change data must be sent as application/json.', code: 'content_type_required' })
    return true
  }
  if (req.method === 'POST' && pathname === '/api/login') {
    await handleLogin(req, res, { password, secure })
    return true
  }
  if (req.method === 'POST' && pathname === '/api/logout') {
    send(res, 200, { 'Set-Cookie': clearedCookie({ secure }) }, { ok: true })
    return true
  }

  if (hasSession(req, password)) return false
  if (req.method === 'GET' && PUBLIC_ASSET.test(pathname)) return false
  if (req.method === 'GET' && isNavigation(pathname)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(LOGIN_PAGE)
    return true
  }
  json(res, 401, { error: 'Sign in to continue.', code: 'auth_required' })
  return true
}

// Served from here rather than from ./dist so the gate needs no exception for
// hashed Vite assets — this page depends on nothing but the font.
const LOGIN_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kothai</title>
<style>
@font-face{font-family:"Geist";font-style:normal;font-weight:300 700;font-display:swap;src:url("/vendor/fonts/Geist-latin.woff2") format("woff2")}
:root{color-scheme:dark light;--bg:#0a0a0a;--ink:#fff;--dim:rgba(255,255,255,.6);--line:rgba(255,255,255,.14);--panel:rgba(255,255,255,.03)}
@media (prefers-color-scheme:light){:root{--bg:#fff;--ink:#0a0a0a;--dim:rgba(10,10,10,.6);--line:rgba(10,10,10,.14);--panel:rgba(10,10,10,.03)}}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--ink);
  font-family:"Geist",ui-sans-serif,system-ui,-apple-system,sans-serif;font-size:15px;
  letter-spacing:-.02em;line-height:1.5;-webkit-font-smoothing:antialiased}
form{width:100%;max-width:320px}
h1{margin:0 0 4px;font-size:28px;font-weight:500;letter-spacing:-.03em}
p{margin:0 0 24px;color:var(--dim);font-size:14px}
label{display:block;margin-bottom:8px;font-size:10px;font-weight:500;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)}
input{width:100%;padding:11px 13px;border:1px solid var(--line);border-radius:9px;background:var(--panel);
  color:var(--ink);font:inherit;letter-spacing:normal}
input:focus{outline:none;border-color:var(--ink)}
button{width:100%;margin-top:12px;padding:11px;border:0;border-radius:9px;background:var(--ink);color:var(--bg);
  font:inherit;font-weight:500;letter-spacing:-.02em;cursor:pointer}
button:disabled{opacity:.5;cursor:default}
.err{min-height:20px;margin-top:12px;font-size:13px;color:#ef4444}
</style>
</head>
<body>
<form id="f">
  <h1>Kothai</h1>
  <p>This stash is password protected.</p>
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
  <button type="submit">Unlock</button>
  <div class="err" id="err" role="alert"></div>
</form>
<script>
const f = document.getElementById('f'), err = document.getElementById('err')
f.addEventListener('submit', async (e) => {
  e.preventDefault()
  const btn = f.querySelector('button')
  btn.disabled = true
  err.textContent = ''
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: f.password.value }),
    })
    if (r.ok) { location.replace(location.pathname + location.search) ; return }
    const d = await r.json().catch(() => ({}))
    err.textContent = d.error || 'Sign in failed.'
  } catch {
    err.textContent = 'Could not reach the server.'
  }
  btn.disabled = false
  f.password.select()
})
</script>
</body>
</html>`
