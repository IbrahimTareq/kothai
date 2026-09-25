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

// The Instagram lane is mocked at the queue, so these tests get the page
// without the 2.5s throttle and read the verdict off the markup alone.
let embedImpl: (url: string) => Promise<string>
const realQueue = await import('../../../server/links/instagram-queue.ts')
mock.module('../../../server/links/instagram-queue.ts', {
  namedExports: { ...realQueue, queueIgEmbed: (url: string) => embedImpl(url) },
})
const { checkAvailability, isCheckable } = await import('../../../server/links/availability.ts')

const TT = 'https://www.tiktok.com/video/7325881953608158497'
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status })

test('a 200 with a JSON body means the content is alive', async () => {
  getImpl = async () => new Response(JSON.stringify({ title: 'a caption' }))
  assert.equal(await checkAvailability(TT), 'alive')
})

test('400/404/410 are the only statuses that mean the content is gone', async () => {
  for (const status of [400, 404, 410]) {
    getImpl = async () => {
      throw httpError(status)
    }
    assert.equal(await checkAvailability(TT), 'dead', `${status} should read as gone`)
  }
})

test('a throttle or a server error is NEVER read as gone', async () => {
  // The case that would turn one bad afternoon into mass deletion.
  for (const status of [401, 403, 429, 500, 502, 503]) {
    getImpl = async () => {
      throw httpError(status)
    }
    assert.equal(await checkAvailability(TT), 'unknown', `${status} must not read as gone`)
  }
})

test('a network failure with no status is not a verdict', async () => {
  getImpl = async () => {
    throw new Error('fetch failed')
  }
  assert.equal(await checkAvailability(TT), 'unknown')
})

test('a 200 that is not JSON proves nothing — an error page would pass on status alone', async () => {
  getImpl = async () => new Response('<html>an error page</html>')
  assert.equal(await checkAvailability(TT), 'unknown')
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

const IG = 'https://www.instagram.com/p/DcLY4Atje0p/'
// Trimmed from the two pages fetched on 2026-09-26.
const IG_LIVE =
  '<div class="EmbeddedMedia"><img class="EmbeddedMediaImage" src="https://scontent.cdninstagram.com/x.jpg" alt=""></div>' +
  '<div class="Caption"><a class="CaptionUsername">someone</a><br />a caption</div>'
const IG_BROKEN =
  '<div class="_aa4c"><div class="EmbedBrokenMedia"><div class="ebmMessage">The link to this photo or video ' +
  'may be broken, or the post may have been removed.</div></div></div>'

test('an Instagram embed page that says the post is broken means gone', async () => {
  embedImpl = async () => IG_BROKEN
  assert.equal(await checkAvailability(IG), 'dead')
})

test('an Instagram embed page with the post on it means alive', async () => {
  embedImpl = async () => IG_LIVE
  assert.equal(await checkAvailability(IG), 'alive')
})

test('an Instagram page that is neither — a login wall, a soft-ban — proves nothing', async () => {
  // The case the old blanket exclusion existed for. Both answer 200.
  for (const html of ['<html><body><div class="LoginForm">Log in</div></body></html>', '']) {
    embedImpl = async () => html
    assert.equal(await checkAvailability(IG), 'unknown')
  }
})

test('a failed Instagram fetch is not a verdict', async () => {
  embedImpl = async () => {
    throw httpError(429)
  }
  assert.equal(await checkAvailability(IG), 'unknown')
})

test('Instagram posts are checkable; other Instagram pages are not', () => {
  assert.equal(isCheckable(IG), true)
  assert.equal(isCheckable('https://www.instagram.com/reel/DcLY4Atje0p/'), true)
  assert.equal(isCheckable('https://www.instagram.com/someone/'), false)
})

test('X and YouTube links are checkable', () => {
  assert.equal(isCheckable('https://x.com/jack/status/20'), true)
  assert.equal(isCheckable('https://twitter.com/jack/status/20'), true)
  assert.equal(isCheckable('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), true)
  assert.equal(isCheckable('https://youtu.be/dQw4w9WgXcQ'), true)
})

test('a missing YouTube video (400) or tweet (404) means gone; private (401/403) does not', async () => {
  const cases: [string, number, string][] = [
    ['https://www.youtube.com/watch?v=zzzzzzzzzzz', 400, 'dead'],
    ['https://x.com/jack/status/1999999999999999999', 404, 'dead'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 401, 'unknown'],
    ['https://x.com/jack/status/20', 403, 'unknown'],
  ]
  for (const [url, status, verdict] of cases) {
    getImpl = async () => {
      throw httpError(status)
    }
    assert.equal(await checkAvailability(url), verdict, `${url} answering ${status}`)
  }
})

// The oEmbed 400/404 measurement (see the header) was taken against the
// canonical watch/status link. A tweet's own /photo/1 share link and
// YouTube's /embed/, /v/ and bare /live links answer 404 for content that is
// very much alive — checking those would delete live saves.
test('X/YouTube shapes the oEmbed measurement was never taken against are not checkable', () => {
  assert.equal(isCheckable('https://x.com/jack/status/20/photo/1'), false)
  assert.equal(isCheckable('https://x.com/search?q=a'), false)
  assert.equal(isCheckable('https://www.youtube.com/embed/dQw4w9WgXcQ'), false)
  assert.equal(isCheckable('https://www.youtube.com/v/dQw4w9WgXcQ'), false)
  assert.equal(isCheckable('https://youtube.com/playlist?list=WL'), false)
  assert.equal(isCheckable('https://www.instagram.com/reels/audio/123/'), false)
})

test('canonical X/YouTube shapes stay checkable through subdomains and extra query params', () => {
  assert.equal(isCheckable('https://x.com/i/status/20'), true)
  assert.equal(isCheckable('https://twitter.com/jack/status/20?s=46'), true)
  assert.equal(isCheckable('https://youtube.com/shorts/abc123'), true)
  assert.equal(isCheckable('https://youtube.com/live/abc123'), true)
  assert.equal(isCheckable('https://youtu.be/dQw4w9WgXcQ?si=x'), true)
  assert.equal(isCheckable('https://m.youtube.com/watch?v=dQw4w9WgXcQ'), true)
})

test('a non-canonical shape is unknown without ever calling get — isCheckable rules it out first', async () => {
  let called = false
  getImpl = async () => {
    called = true
    throw httpError(404)
  }
  assert.equal(await checkAvailability('https://x.com/jack/status/20/photo/1'), 'unknown')
  assert.equal(called, false)
})

test('an Instagram page with both signals — a broken marker AND a live caption — is ambiguous, not dead', async () => {
  embedImpl = async () => IG_BROKEN + IG_LIVE
  assert.equal(await checkAvailability(IG), 'unknown')
})
