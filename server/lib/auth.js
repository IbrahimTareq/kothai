// Primitives for the optional password gate. Kothai is single-user, so this is
// deliberately one shared password rather than an account system — the goal is
// to make a public URL safe to expose, not to model identity.
//
// Everything here is pure or takes its clock and secret as arguments, so the
// router can hold the policy and the tests never touch process.env or real time.
import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto'

export const COOKIE_NAME = 'stash_session'
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
const HKDF_SALT = 'kothai-session-v1'

// ---- session tokens -----------------------------------------------------

// The signing key is DERIVED FROM THE PASSWORD rather than being a separate
// random secret kept on disk. Two things fall out of that for free: there is no
// extra secret to generate, persist or lose (so a container restart does not
// log you out, which a server-side session table would), and changing the
// password invalidates every outstanding session without any revocation list.
function signingKey(password) {
  return Buffer.from(hkdfSync('sha256', password, HKDF_SALT, 'session-signing', 32))
}

function sign(exp, password) {
  return createHmac('sha256', signingKey(password)).update(String(exp)).digest('base64url')
}

// Token is `<expiry>.<signature>`. The expiry travels in the clear — the
// client can read it, and the signature is what stops it being edited.
export function issueSession(password, { now = Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
  const exp = now + ttlMs
  return `${exp}.${sign(exp, password)}`
}

export function verifySession(token, password, { now = Date.now() } = {}) {
  if (typeof token !== 'string') return false
  const parts = token.split('.')
  if (parts.length !== 2) return false
  const [exp, sig] = parts
  // Checked before signing so a garbage expiry can never reach Number() and
  // come back NaN (NaN > now is false, but only by luck — better to reject).
  if (!/^\d{1,15}$/.test(exp)) return false
  const expected = sign(exp, password)
  // timingSafeEqual throws on a length mismatch, which would itself be a
  // (useless, but avoidable) signal; a wrong-length signature is wrong anyway.
  if (sig.length !== expected.length) return false
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false
  return Number(exp) > now
}

// Both sides are hashed first so the comparison is over two 32-byte digests.
// timingSafeEqual requires equal lengths, and comparing the raw strings would
// throw on a wrong-length guess — leaking the password's length through the
// error path, and only for that guess.
export function passwordMatches(input, password) {
  if (typeof input !== 'string' || typeof password !== 'string') return false
  const digest = (s) => createHash('sha256').update(s).digest()
  return timingSafeEqual(digest(input), digest(password))
}

// ---- cookies ------------------------------------------------------------

export function parseCookies(header) {
  const out = {}
  if (typeof header !== 'string') return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue // a bare flag is not a cookie
    const name = part.slice(0, eq).trim()
    // Split on the FIRST '=' only: base64 padding puts '=' inside the value.
    if (name) out[name] = part.slice(eq + 1).trim()
  }
  return out
}

function cookie(value, { secure, maxAgeSec }) {
  // SameSite=Lax is the primary CSRF defence: a cross-site POST carries no
  // cookie at all under it. It is not the only one — see the JSON content-type
  // requirement in the router, which covers same-site-different-port, a case
  // SameSite does not distinguish.
  const bits = [`${COOKIE_NAME}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`]
  // Never unconditional: a Secure cookie is silently dropped over plain HTTP,
  // which would make login fail with no visible error on every LAN install
  // that is not behind TLS.
  if (secure) bits.push('Secure')
  return bits.join('; ')
}

export function sessionCookie(token, { secure = false, maxAgeSec = DEFAULT_TTL_MS / 1000 } = {}) {
  return cookie(token, { secure, maxAgeSec })
}

export function clearedCookie({ secure = false } = {}) {
  return cookie('', { secure, maxAgeSec: 0 })
}

// Trusting x-forwarded-proto is safe for this one decision: the header is
// spoofable when there is no proxy, but the worst a spoofer achieves is making
// their OWN cookie Secure — a self-inflicted denial, not an escalation.
export function isSecureRequest(req) {
  if (req.socket?.encrypted) return true
  const proto = req.headers?.['x-forwarded-proto']
  return typeof proto === 'string' && proto.split(',')[0].trim().toLowerCase() === 'https'
}

// ---- login throttle -----------------------------------------------------

// A single password on a public URL is exactly the shape brute force likes, and
// there is no rate limiting anywhere else in this server. Sliding window over
// failures per key (the client IP), in memory — a restart forgives everyone,
// which is the right trade for a single-user app.
const MAX_KEYS = 5000

export function createThrottle({ max = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const hits = new Map()

  const prune = (key, now) => {
    const kept = (hits.get(key) || []).filter((t) => now - t < windowMs)
    if (kept.length) hits.set(key, kept)
    else hits.delete(key)
    return kept
  }

  // Per-key pruning only ever touches keys that come back. Spoofed source
  // addresses would otherwise grow this map without bound, so sweep the whole
  // thing once it gets big rather than tracking eviction per entry.
  const sweep = (now) => {
    if (hits.size <= MAX_KEYS) return
    for (const key of [...hits.keys()]) prune(key, now)
  }

  return {
    check(key, now = Date.now()) {
      const kept = prune(key, now)
      if (kept.length < max) return { allowed: true, retryAfterSec: 0 }
      return { allowed: false, retryAfterSec: Math.ceil((windowMs - (now - kept[0])) / 1000) }
    },
    fail(key, now = Date.now()) {
      const kept = prune(key, now)
      kept.push(now)
      hits.set(key, kept)
      sweep(now)
    },
    succeed(key) {
      hits.delete(key)
    },
  }
}
