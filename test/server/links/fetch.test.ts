// The fetch every link scrape goes through: the http(s) pre-filter, and proof
// that get() really routes through the SSRF guard in server/lib/ssrf.ts.
import test from 'node:test'
import assert from 'node:assert/strict'
import { isSafeFetchUrl, get } from '../../../server/links/fetch.ts'

test('isSafeFetchUrl: allows http(s), rejects data: URLs and malformed input (attacker-controlled thumb/og:image guard)', () => {
  assert.equal(isSafeFetchUrl('https://scontent.cdninstagram.com/x.jpg'), true)
  assert.equal(isSafeFetchUrl('http://example.com/x.jpg'), true)
  assert.equal(isSafeFetchUrl('data:image/jpeg;base64,/9j/xyz'), false)
  assert.equal(isSafeFetchUrl('file:///etc/passwd'), false)
  assert.equal(isSafeFetchUrl('not a url'), false)
})

test('get: rejects non-http(s) URLs before ever calling fetch (no network I/O — the guard throws first)', async () => {
  await assert.rejects(() => get('data:text/plain,hi', 'text/plain'), /unsupported URL scheme/)
})

// The scheme check alone never stopped these — http://169.254.169.254 is a
// perfectly valid http(s) URL. These assert get() actually routes through
// server/lib/ssrf.ts (which owns the range rules and their own tests), rather
// than that the ranges themselves are right.
test('get: rejects internal and loopback addresses — the SSRF guard is wired into the real fetch path', async () => {
  await assert.rejects(() => get('http://169.254.169.254/latest/meta-data/', '*/*'), /blocked address/)
  await assert.rejects(() => get('http://127.0.0.1:5173/api/export', '*/*'), /blocked (address|port)/)
  await assert.rejects(() => get('http://[::1]/', '*/*'), /blocked address/)
})

test('get: rejects a non-web port, so a stashed link cannot probe internal services', async () => {
  await assert.rejects(() => get('http://example.com:6379/', '*/*'), /blocked port/)
})
