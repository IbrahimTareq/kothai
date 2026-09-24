// Tests for meta.ts's Reddit handling: URL recognition, and share links being
// resolved to the canonical post so Reddit's oEmbed endpoint recognises them.
// Reddit's .json rendering answers 403 to anonymous requests, so a post gets
// what oEmbed returns and nothing is fetched from the .json route.
//
// Mocks are installed before meta.ts is imported; see test/oembed.test.ts.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

interface Stub {
  json?: unknown
  text?: string
  contentType?: string
  redirectsTo?: string
}

let responses: Record<string, Stub>
let fetched: string[]

function respond(url: string) {
  const r = responses[url]
  if (!r) return { ok: false, status: 404, headers: new Headers(), text: async () => '', json: async () => ({}) }
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': r.contentType || 'application/json' }),
    // Response.url is the URL after redirects — what resolveRedditShare reads
    // to turn a /s/ share link back into the canonical post URL.
    url: r.redirectsTo || url,
    text: async () => r.text ?? '',
    json: async () => r.json ?? {},
  }
}

const realSsrf = await import('../../../server/lib/ssrf.ts')
mock.module('../../../server/lib/ssrf.ts', {
  namedExports: {
    ...realSsrf,
    safeFetch: async (url: string) => {
      fetched.push(url)
      return respond(url)
    },
  },
})

const { isRedditPost, isRedditShare, fetchLinkMeta } = await import('../../../server/ai/meta.ts')

const POST_URL = 'https://www.reddit.com/r/breadit/comments/abc123/my_first_sourdough/'
const oembedOf = (url: string) => `https://www.reddit.com/oembed?url=${encodeURIComponent(url)}&format=json`

test('isRedditPost matches post permalinks on reddit.com and its subdomains, not the rest of the site', () => {
  assert.equal(isRedditPost(POST_URL), true)
  assert.equal(isRedditPost('https://old.reddit.com/r/breadit/comments/abc123/'), true)
  assert.equal(isRedditPost('https://np.reddit.com/comments/abc123'), true)
  assert.equal(isRedditPost('https://www.reddit.com/r/breadit/'), false) // subreddit index
  assert.equal(isRedditPost('https://www.reddit.com/user/baker99'), false)
  assert.equal(isRedditPost('https://evil.com/reddit.com/comments/x'), false)
  assert.equal(isRedditPost('not a url'), false)
})

test('a Reddit permalink gets its title from oEmbed, with no .json fetch', async () => {
  fetched = []
  responses = {
    [oembedOf(POST_URL)]: {
      json: { title: 'Why did the Roman Empire fall?', author_name: 'PatsHobbyJP', provider_name: 'reddit' },
    },
    [POST_URL]: { text: '<html><head><title>Reddit</title></head></html>', contentType: 'text/html' },
  }
  const meta = await fetchLinkMeta(POST_URL, 'note-r1')
  assert.equal(meta.siteTitle, 'Why did the Roman Empire fall?')
  assert.equal(meta.siteName, 'reddit')
  assert.ok(!fetched.some(u => u.includes('.json')), 'the walled .json route is never tried')
})

// ---- share links --------------------------------------------------------
// /r/<sub>/s/<id> is what Reddit's own share sheet produces, so it is the form
// most saves actually arrive in. It matches neither the oEmbed registry's
// pattern, so before this the note ended up titled "Reddit" by the shell
// page's <title>.

const SHARE_URL = 'https://www.reddit.com/r/breadit/s/GStuyyUMKl'

test('isRedditShare matches a share link and nothing that merely looks like one', () => {
  assert.equal(isRedditShare(SHARE_URL), true)
  assert.equal(isRedditShare('https://reddit.com/r/breadit/s/abc/'), true, 'trailing slash')
  // r/s is a real subreddit name, and this is an ordinary post URL in it.
  assert.equal(isRedditShare('https://www.reddit.com/r/s/comments/abc123/x/'), false)
  assert.equal(isRedditShare(POST_URL), false)
  assert.equal(isRedditShare('https://notreddit.com/r/x/s/abc'), false)
  assert.equal(isRedditShare('not a url'), false)
})

test('fetchLinkMeta resolves a share link to the canonical post before fetching metadata', async () => {
  fetched = []
  // Reddit answers the share link with a redirect to the permalink, carrying
  // share_id/utm_* tracking params that must not reach the oEmbed lookup.
  responses = {
    [SHARE_URL]: {
      contentType: 'text/html',
      text: '<html><head><title>Reddit</title></head></html>',
      redirectsTo: `${POST_URL}?share_id=abc&utm_medium=android_app`,
    },
    [oembedOf(POST_URL)]: { json: { title: 'My first sourdough', provider_name: 'reddit' } },
  }
  const meta = await fetchLinkMeta(SHARE_URL, 'note-r4')

  assert.deepEqual(
    fetched.slice(0, 2),
    [SHARE_URL, oembedOf(POST_URL)],
    'the share link is followed once, then the canonical URL drives the rest',
  )
  assert.equal(meta.siteTitle, 'My first sourdough', 'the real post title, not the "Reddit" shell title')
})

test('a share link that does not resolve to a post falls back to the generic path', async () => {
  // A share link to a subreddit rather than to a post: there is no permalink
  // behind it, so the generic oEmbed + OpenGraph route handles it as before.
  fetched = []
  const SUB_SHARE = 'https://www.reddit.com/r/breadit/s/zzz'
  responses = {
    [SUB_SHARE]: {
      contentType: 'text/html',
      text: '<html><head><meta property="og:title" content="r/breadit"></head></html>',
      redirectsTo: 'https://www.reddit.com/r/breadit/',
    },
  }
  const meta = await fetchLinkMeta(SUB_SHARE, 'note-r5')
  assert.equal(meta.siteTitle, 'r/breadit')
})
