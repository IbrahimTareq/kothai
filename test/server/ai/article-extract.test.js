// Unit tests for extractArticle — the Readability-backed article body scrape.
// Pure (html string in, string|null out), so no network or fetch mocking.
import test from 'node:test'
import assert from 'node:assert/strict'
import { extractArticle, fetchLinkMeta } from '../../../server/ai/meta.js'

// Readability needs a real-ish document: a <title>, and enough prose in a
// single container to beat the nav/footer noise around it.
function articlePage(body) {
  return `<!DOCTYPE html><html><head><title>Test Article</title></head><body>
    <nav><a href="/">Home</a><a href="/about">About</a></nav>
    <article><h1>Test Article</h1>${body}</article>
    <footer>Copyright 2026</footer>
  </body></html>`
}

const PARA = '<p>' + 'Sourdough fermentation depends on wild yeast and lactic acid bacteria working together over many hours. '.repeat(6) + '</p>'

test('extractArticle: pulls article prose out of surrounding page chrome', () => {
  const out = extractArticle(articlePage(PARA))
  assert.ok(out, 'expected an extracted article, got null')
  assert.match(out, /Sourdough fermentation depends on wild yeast/)
  // The point of Readability over a naive innerText: chrome is dropped.
  assert.doesNotMatch(out, /Copyright 2026/)
})

test('extractArticle: paywall/cookie-wall stubs fall under the length floor', () => {
  const wall = `<!DOCTYPE html><html><head><title>Subscribe</title></head><body>
    <article><p>Subscribe to continue reading this article.</p></article>
  </body></html>`
  // Short enough to be indistinguishable from a stub — storing it would
  // pollute the embedding with boilerplate that says nothing about the page.
  assert.equal(extractArticle(wall), null)
})

test('extractArticle: client-rendered shell with no prose yields null', () => {
  assert.equal(extractArticle('<!DOCTYPE html><html><body><div id="root"></div></body></html>'), null)
})

test('extractArticle: malformed html returns null instead of throwing', () => {
  assert.equal(extractArticle('<html><body><p>unclosed'), null)
  assert.equal(extractArticle(''), null)
})

test('extractArticle: long articles are capped at 8000 chars', () => {
  const huge = '<p>' + 'All work and no play makes Jack a dull boy. '.repeat(600) + '</p>'
  const out = extractArticle(articlePage(huge))
  assert.ok(out)
  assert.equal(out.length, 8000)
})

test('extractArticle: whitespace is collapsed', () => {
  const out = extractArticle(articlePage(PARA))
  assert.doesNotMatch(out, /\s{2,}/)
})

// get() calls the global fetch directly, so a stub is all that's needed.
// The fixture deliberately carries no og:image, so saveThumb never fires and
// a single stubbed response covers the whole call.
function stubFetch(body, contentType) {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
  })
  return () => { globalThis.fetch = original }
}

const OG_PAGE = `<!DOCTYPE html><html><head>
  <title>Test Article</title>
  <meta property="og:title" content="A Baking Post">
  <meta property="og:description" content="Some thoughts on baking">
</head><body>
  <nav><a href="/">Home</a></nav>
  <article><h1>A Baking Post</h1>${PARA}</article>
</body></html>`

test('fetchLinkMeta: populates article alongside og tags for an html response', async (t) => {
  const restore = stubFetch(OG_PAGE, 'text/html; charset=utf-8')
  t.after(restore)
  const meta = await fetchLinkMeta('https://example.com/bread', 'note-1')
  assert.equal(meta.siteTitle, 'A Baking Post')
  assert.ok(meta.article, 'expected article to be extracted')
  assert.match(meta.article, /Sourdough fermentation depends on wild yeast/)
})

test('fetchLinkMeta: skips extraction when the response is not html', async (t) => {
  // Same bytes, non-html content-type: the guard must stop Readability from
  // ever seeing it, so article stays null even though the body would parse.
  const restore = stubFetch(OG_PAGE, 'application/json')
  t.after(restore)
  const meta = await fetchLinkMeta('https://example.com/data', 'note-2')
  assert.equal(meta.article, null)
})
