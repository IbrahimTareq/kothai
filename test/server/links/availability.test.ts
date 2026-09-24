// Tests for server/links/availability.ts — the verdict, not the sweep.
//
// The distinction these pin is the one that makes auto-removal safe or
// catastrophic: a definite "this content is gone" versus "the request failed".
// Only the first may ever lead to a deletion.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

// Typed as get's own signature, which forces every stub below to hand
// back a REAL Response. The literals they used to return ({ json: async () =>
// ... }) could only be typed by lying about what get() answers — and the case
// that matters most here, a 200 whose body is not JSON, is only honest if
// json() fails the way the real one does.
let getImpl: (url: string, accept: string) => Promise<Response>
const realFetch = await import('../../../server/links/fetch.ts')
mock.module('../../../server/links/fetch.ts', {
  namedExports: { ...realFetch, get: (url: string, accept: string) => getImpl(url, accept) },
})
const { checkAvailability, isCheckable, ALIVE, DEAD, UNKNOWN } = await import('../../../server/links/availability.ts')

const TT = 'https://www.tiktok.com/video/7325881953608158497'
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status })

test('a 200 with a JSON body means the content is alive', async () => {
  getImpl = async () => new Response(JSON.stringify({ title: 'a caption' }))
  assert.equal(await checkAvailability(TT), ALIVE)
})

test('400/404/410 are the only statuses that mean the content is gone', async () => {
  for (const status of [400, 404, 410]) {
    getImpl = async () => {
      throw httpError(status)
    }
    assert.equal(await checkAvailability(TT), DEAD, `${status} should read as gone`)
  }
})

test('a throttle or a server error is NEVER read as gone', async () => {
  // The case that would turn one bad afternoon into mass deletion.
  for (const status of [401, 403, 429, 500, 502, 503]) {
    getImpl = async () => {
      throw httpError(status)
    }
    assert.equal(await checkAvailability(TT), UNKNOWN, `${status} must not read as gone`)
  }
})

test('a network failure with no status is not a verdict', async () => {
  getImpl = async () => {
    throw new Error('fetch failed')
  }
  assert.equal(await checkAvailability(TT), UNKNOWN)
})

test('a 200 that is not JSON proves nothing — an error page would pass on status alone', async () => {
  getImpl = async () => new Response('<html>an error page</html>')
  assert.equal(await checkAvailability(TT), UNKNOWN)
})

test('Instagram is never checkable — a soft-ban is indistinguishable from a deletion', async () => {
  assert.equal(isCheckable('https://www.instagram.com/p/ABC123/'), false)
  assert.equal(await checkAvailability('https://www.instagram.com/p/ABC123/'), UNKNOWN)
})

test('unknown hosts and junk urls are not checkable', () => {
  assert.equal(isCheckable('https://example.com/thing'), false)
  assert.equal(isCheckable('not a url'), false)
  assert.equal(isCheckable(null), false)
  assert.equal(isCheckable(''), false)
})

test('tiktok links are checkable', () => {
  assert.equal(isCheckable(TT), true)
  assert.equal(isCheckable('https://www.tiktok.com/@someone/video/123'), true)
})
