// Tests for meta.js's oEmbed provider discovery.
//
// Two halves:
//   - oembedEndpoint() is pure URL math over the REAL @extractus registry.
//     These deliberately do not mock the provider data: the entire reason the
//     package is a dependency is that the ~300-entry registry is not ours to
//     keep current, and a test against a stubbed registry would prove nothing
//     about whether TikTok is actually in it.
//   - the fetchLinkMeta integration mocks server/lib/ssrf.js (the seam get()
//     calls) so the wiring can be asserted with no network at all. Mocking
//     THERE and not at global fetch is the point of the exercise: it proves
//     the oEmbed lookup goes through the guarded get(), and not through the
//     package's own extract(), which does its own unguarded fetching.
//
// Mocks are installed before meta.js is imported — mock.module only affects
// modules resolved after it runs, so a static import of the subject at the
// top of the file would silently bind the real implementation.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

let responses // url → { json?, text?, contentType }
let fetched   // every url safeFetch saw, in order

function respond(url) {
  const r = responses[url]
  if (!r) return { ok: false, status: 404, headers: new Headers(), text: async () => '', json: async () => ({}) }
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': r.contentType || 'application/json' }),
    text: async () => r.text ?? '',
    json: async () => r.json ?? {},
  }
}

const realSsrf = await import('../../../server/lib/ssrf.js')
mock.module('../../../server/lib/ssrf.js', {
  namedExports: {
    ...realSsrf,
    safeFetch: async (url) => {
      fetched.push(url)
      return respond(url)
    },
  },
})

const { oembedEndpoint, fetchLinkMeta } = await import('../../../server/ai/meta.js')

// ---- provider discovery (pure, real registry) ----------------------------

test('oembedEndpoint resolves the providers the hand-rolled table used to cover', () => {
  assert.match(oembedEndpoint('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), /^https:\/\/www\.youtube\.com\/oembed\?/)
  assert.match(oembedEndpoint('https://youtu.be/dQw4w9WgXcQ'), /^https:\/\/www\.youtube\.com\/oembed\?/)
  assert.match(oembedEndpoint('https://vimeo.com/123456'), /^https:\/\/vimeo\.com\/api\/oembed\.json\?/)
})

test('oembedEndpoint resolves TikTok — the provider this package was adopted for', () => {
  const api = oembedEndpoint('https://www.tiktok.com/@someone/video/1234567890')
  assert.match(api, /^https:\/\/www\.tiktok\.com\/oembed\?/)
  const q = new URL(api).searchParams
  assert.equal(q.get('url'), 'https://www.tiktok.com/@someone/video/1234567890')
  assert.equal(q.get('format'), 'json')
})

test('oembedEndpoint percent-encodes the target url into the query, never concatenates it', () => {
  const api = oembedEndpoint('https://vimeo.com/123?a=1&b=2')
  assert.equal(new URL(api).searchParams.get('url'), 'https://vimeo.com/123?a=1&b=2')
  // One '?' only — the target url's own query must not leak into the
  // endpoint's query structure.
  assert.equal(api.split('?').length, 2)
})

test('oembedEndpoint returns null for an unknown provider and for non-http(s) input', () => {
  assert.equal(oembedEndpoint('https://example.com/some/page'), null)
  assert.equal(oembedEndpoint('file:///etc/passwd'), null)
  assert.equal(oembedEndpoint('javascript:alert(1)'), null)
  assert.equal(oembedEndpoint('not a url'), null)
  assert.equal(oembedEndpoint(''), null)
})

test("oembedEndpoint skips Meta's token-gated graph endpoint rather than spending a doomed request on it", () => {
  // The registry DOES list instagram.com, pointing at
  // graph.facebook.com/.../instagram_oembed — which 400s for any caller
  // without an app access token. Post/reel/tv URLs never get here anyway
  // (fetchLinkMeta short-circuits to the bespoke embed pipeline first), but a
  // bare profile URL would.
  assert.equal(oembedEndpoint('https://www.instagram.com/reel/ABC123/'), null)
  assert.equal(oembedEndpoint('https://www.instagram.com/chefsteps/'), null)
  assert.equal(oembedEndpoint('https://www.facebook.com/some/post/1'), null)
})

// ---- fetchLinkMeta integration (mocked transport, no network) -------------

const TIKTOK = 'https://www.tiktok.com/@chef/video/7300000000000000000'

test('fetchLinkMeta: a TikTok URL is resolved via the registry and fetched through the guarded get()', async () => {
  fetched = []
  responses = {
    [oembedEndpoint(TIKTOK)]: {
      json: {
        title: 'three ingredient brown butter pasta #pasta #recipe',
        author_name: 'chef',
        provider_name: 'TikTok',
      },
    },
    // Page scrape returns no og tags, so oEmbed's fields must survive it.
    [TIKTOK]: { text: '<html><head></head><body></body></html>', contentType: 'text/html' },
  }

  const meta = await fetchLinkMeta(TIKTOK, 'note-1')

  assert.ok(fetched.includes(oembedEndpoint(TIKTOK)), 'the oEmbed endpoint went through safeFetch, not the package')
  // The caption arrives as oEmbed `title` — for a TikTok that IS the caption,
  // and it is the only text a saved TikTok has to be retrieved by.
  assert.equal(meta.siteTitle, 'three ingredient brown butter pasta #pasta #recipe')
  assert.equal(meta.siteName, 'TikTok')
  assert.equal(meta.siteDesc, 'by chef', 'author_name still becomes the weak-signal siteDesc when the page has no og:description')
})

test('fetchLinkMeta: mergeSiteDesc behaviour is unchanged — the real og:description wins, the oEmbed author line trails it', async () => {
  fetched = []
  responses = {
    [oembedEndpoint(TIKTOK)]: { json: { title: 'T', author_name: 'chef', provider_name: 'TikTok' } },
    [TIKTOK]: {
      text: '<html><head><meta property="og:description" content="The real description."></head></html>',
      contentType: 'text/html',
    },
  }
  const meta = await fetchLinkMeta(TIKTOK, 'note-2')
  assert.equal(meta.siteDesc, 'The real description.\n\nby chef')
})

test('fetchLinkMeta: an unknown provider skips oEmbed entirely and still scrapes OpenGraph', async () => {
  fetched = []
  const url = 'https://example.com/an/article'
  responses = {
    [url]: {
      text: '<html><head><meta property="og:title" content="An Article"><meta property="og:site_name" content="Example"></head></html>',
      contentType: 'text/html',
    },
  }
  const meta = await fetchLinkMeta(url, 'note-3')
  assert.deepEqual(fetched, [url], 'exactly one fetch — no speculative oEmbed call for a URL no provider claims')
  assert.equal(meta.siteTitle, 'An Article')
  assert.equal(meta.siteName, 'Example')
})

test('fetchLinkMeta: a failing oEmbed endpoint falls through to the OpenGraph scrape instead of throwing', async () => {
  fetched = []
  responses = {
    // No entry for the oEmbed endpoint → respond() 404s, which get() throws on.
    [TIKTOK]: {
      text: '<html><head><meta property="og:title" content="Scraped Title"></head></html>',
      contentType: 'text/html',
    },
  }
  const meta = await fetchLinkMeta(TIKTOK, 'note-4')
  assert.equal(meta.siteTitle, 'Scraped Title')
})
