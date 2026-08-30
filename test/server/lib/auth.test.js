// Unit tests for server/lib/auth.js — the primitives behind the optional
// password gate. Everything here is pure or injectable: the token functions
// take the password and the clock, so a test never depends on process.env or
// on real time passing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseCookies, issueSession, verifySession, passwordMatches,
  sessionCookie, clearedCookie, isSecureRequest, createThrottle,
} from '../../../server/lib/auth.js'

const PW = 'correct horse battery staple'
const T0 = 1_700_000_000_000

// ---- cookies ------------------------------------------------------------

test('parseCookies: splits a real Cookie header, tolerating spacing', () => {
  assert.deepEqual(parseCookies('a=1; b=2'), { a: '1', b: '2' })
  assert.deepEqual(parseCookies('a=1;b=2'), { a: '1', b: '2' })
})

test('parseCookies: a value containing "=" survives intact (base64 tokens are padded with it)', () => {
  assert.deepEqual(parseCookies('stash_session=abc.def=='), { stash_session: 'abc.def==' })
})

test('parseCookies: no header, empty header and junk all yield an empty object rather than throwing', () => {
  assert.deepEqual(parseCookies(undefined), {})
  assert.deepEqual(parseCookies(''), {})
  assert.deepEqual(parseCookies('novalue'), {})
})

// ---- session tokens -----------------------------------------------------

test('issueSession/verifySession: a freshly issued token verifies', () => {
  const token = issueSession(PW, { now: T0 })
  assert.equal(verifySession(token, PW, { now: T0 + 1000 }), true)
})

test('verifySession: a token whose expiry has passed is rejected', () => {
  const token = issueSession(PW, { now: T0, ttlMs: 60_000 })
  assert.equal(verifySession(token, PW, { now: T0 + 59_000 }), true)
  assert.equal(verifySession(token, PW, { now: T0 + 61_000 }), false)
})

test('verifySession: the expiry is signed, so extending it by hand invalidates the token', () => {
  // The expiry travels in the clear where the client can see it — the whole
  // job of the signature is that editing it is useless.
  const token = issueSession(PW, { now: T0, ttlMs: 60_000 })
  const [, sig] = token.split('.')
  const forged = `${T0 + 10 * 365 * 24 * 3600 * 1000}.${sig}`
  assert.equal(verifySession(forged, PW, { now: T0 + 61_000 }), false)
})

test('verifySession: a tampered signature is rejected', () => {
  const token = issueSession(PW, { now: T0 })
  const [exp, sig] = token.split('.')
  const flipped = sig[0] === 'A' ? 'B' + sig.slice(1) : 'A' + sig.slice(1)
  assert.equal(verifySession(`${exp}.${flipped}`, PW, { now: T0 }), false)
})

test('verifySession: a token issued under a different password is rejected — changing the password logs every session out', () => {
  // This is why the signing key is derived from the password rather than from
  // a separate random secret: revocation comes free.
  const token = issueSession(PW, { now: T0 })
  assert.equal(verifySession(token, 'a different password', { now: T0 }), false)
})

test('verifySession: malformed input is rejected without throwing', () => {
  for (const junk of ['', 'nodot', 'a.b.c', '.', 'abc.', undefined, null, 'NaN.xxxx']) {
    assert.equal(verifySession(junk, PW, { now: T0 }), false)
  }
})

// ---- the password itself ------------------------------------------------

test('passwordMatches: accepts the password and rejects a near miss', () => {
  assert.equal(passwordMatches(PW, PW), true)
  assert.equal(passwordMatches(PW + 'x', PW), false)
  assert.equal(passwordMatches('', PW), false)
})

test('passwordMatches: a length mismatch is compared, not thrown on (timingSafeEqual needs equal lengths)', () => {
  // Hashing both sides first is what makes the comparison safe here; a naive
  // timingSafeEqual on the raw strings throws on differing lengths, which
  // would leak the length through the error path.
  assert.doesNotThrow(() => passwordMatches('x', PW))
  assert.equal(passwordMatches('x', PW), false)
})

// ---- Set-Cookie ---------------------------------------------------------

test('sessionCookie: HttpOnly, SameSite=Lax and Path=/ are always present', () => {
  const c = sessionCookie('tok', { secure: false, maxAgeSec: 100 })
  assert.match(c, /^stash_session=tok;/)
  assert.match(c, /HttpOnly/)
  assert.match(c, /SameSite=Lax/)
  assert.match(c, /Path=\//)
  assert.match(c, /Max-Age=100/)
})

test('sessionCookie: Secure is set only over TLS — hardcoding it would break every plain-HTTP LAN install', () => {
  assert.doesNotMatch(sessionCookie('tok', { secure: false }), /Secure/)
  assert.match(sessionCookie('tok', { secure: true }), /Secure/)
})

test('clearedCookie: expires the cookie immediately', () => {
  assert.match(clearedCookie({ secure: false }), /stash_session=;/)
  assert.match(clearedCookie({ secure: false }), /Max-Age=0/)
})

test('isSecureRequest: direct TLS or a proxy that says https; plain HTTP otherwise', () => {
  assert.equal(isSecureRequest({ headers: {}, socket: { encrypted: true } }), true)
  assert.equal(isSecureRequest({ headers: { 'x-forwarded-proto': 'https' }, socket: {} }), true)
  // A proxy chain reports a list; the client-facing hop is the first entry.
  assert.equal(isSecureRequest({ headers: { 'x-forwarded-proto': 'https,http' }, socket: {} }), true)
  assert.equal(isSecureRequest({ headers: {}, socket: {} }), false)
  assert.equal(isSecureRequest({ headers: { 'x-forwarded-proto': 'http' }, socket: {} }), false)
})

// ---- login throttle -----------------------------------------------------

test('createThrottle: allows attempts up to the limit, then locks the key out', () => {
  const t = createThrottle({ max: 3, windowMs: 60_000 })
  for (let i = 0; i < 3; i++) {
    assert.equal(t.check('1.2.3.4', T0).allowed, true)
    t.fail('1.2.3.4', T0)
  }
  assert.equal(t.check('1.2.3.4', T0).allowed, false)
})

test('createThrottle: reports how long the caller must wait', () => {
  const t = createThrottle({ max: 1, windowMs: 60_000 })
  t.fail('1.2.3.4', T0)
  const { allowed, retryAfterSec } = t.check('1.2.3.4', T0 + 20_000)
  assert.equal(allowed, false)
  assert.equal(retryAfterSec, 40)
})

test('createThrottle: failures age out of the window', () => {
  const t = createThrottle({ max: 2, windowMs: 60_000 })
  t.fail('1.2.3.4', T0)
  t.fail('1.2.3.4', T0 + 1000)
  assert.equal(t.check('1.2.3.4', T0 + 2000).allowed, false)
  assert.equal(t.check('1.2.3.4', T0 + 61_500).allowed, true, 'both failures are older than the window')
})

test('createThrottle: a successful login clears the key', () => {
  const t = createThrottle({ max: 2, windowMs: 60_000 })
  t.fail('1.2.3.4', T0)
  t.fail('1.2.3.4', T0)
  assert.equal(t.check('1.2.3.4', T0).allowed, false)
  t.succeed('1.2.3.4')
  assert.equal(t.check('1.2.3.4', T0).allowed, true)
})

test('createThrottle: keys are independent, so one attacker cannot lock everyone else out', () => {
  const t = createThrottle({ max: 1, windowMs: 60_000 })
  t.fail('1.2.3.4', T0)
  assert.equal(t.check('1.2.3.4', T0).allowed, false)
  assert.equal(t.check('5.6.7.8', T0).allowed, true)
})
