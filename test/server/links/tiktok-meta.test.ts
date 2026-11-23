// What a TikTok save gets now that TikTok's oEmbed stopped answering with
// title, author_name and thumbnail_url (seen 2026-11-19: only an iframe is
// left). The responses below are the live shapes of 2026-11-23, trimmed to
// the fields read and with a made-up post in them.
//
// Mocks are installed before meta.ts is imported; see oembed.test.ts.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'

// Saving the cover writes into the upload dir, which config.ts freezes at import.
process.env.KOTHAI_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'kothai-tiktok-'))
const { UPLOAD_DIR } = await import('../../../server/config.ts')
mkdirSync(UPLOAD_DIR, { recursive: true })

const VIDEO = 'https://www.tiktok.com/@somebaker/video/7300000000000000001'
const OEMBED = `https://www.tiktok.com/oembed?url=${encodeURIComponent(VIDEO)}&format=json`
const COVER = 'https://p16-common-sign.tiktokcdn.com/tos-useast5-p-0068-tx/abc~tplv-tiktokx-cropcenter:300:400.jpeg'

// What oEmbed answers today: no title, no author_name, no thumbnail_url.
const reducedOembed = {
  version: '1.0',
  type: 'video',
  html: '<iframe src="https://www.tiktok.com/player/v1/7300000000000000001?embed_from=oembed"></iframe>',
  provider_url: 'https://www.tiktok.com',
  provider_name: 'TikTok',
  embed_product_id: '7300000000000000001',
  embed_type: 'video',
}

// The video page as served to Kothai's UA: no OpenGraph tags, the shell's
// <title>, and the post as JSON — with TikTok's /-escaped slashes.
const item = (statusCode: number, itemStruct?: unknown) =>
  JSON.stringify({
    __DEFAULT_SCOPE__: {
      'webapp.app-context': { language: 'en' },
      'webapp.video-detail': { ...(itemStruct ? { itemInfo: { itemStruct } } : {}), statusCode, statusMsg: '' },
    },
  }).replaceAll('/', '\\u002F')

const page = (json: string) =>
  `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>TikTok - Make Your Day</title></head><body>` +
  `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${json}</script></body></html>`

const POST = {
  id: '7300000000000000001',
  desc: 'Same-day sourdough, no starter discard #sourdough #baking',
  author: { uniqueId: 'somebaker', nickname: 'Some Baker' },
  video: { cover: COVER },
}

// Every page this test serves, by the URL asked for. A page answered for a
// URL other than its own stands for a redirect safeFetch followed: `url` on
// the Response is where it landed, as on a real one.
const AT_FORM = 'https://www.tiktok.com/@/video/7300000000000000001'
const SHORT = 'https://vm.tiktok.com/ZMabc123/'
const ELSEWHERE = 'https://example.com/a-page-quoting-tiktok'

let pageHtml = ''
let fetched: string[] = []
const cover = await sharp({ create: { width: 300, height: 400, channels: 3, background: '#c86428' } })
  .jpeg()
  .toBuffer()

const htmlAt = (landed: string) => {
  const res = new Response(pageHtml, { headers: { 'content-type': 'text/html; charset=utf-8' } })
  Object.defineProperty(res, 'url', { value: landed })
  return res
}

const realSsrf = await import('../../../server/lib/ssrf.ts')
mock.module('../../../server/lib/ssrf.ts', {
  namedExports: {
    ...realSsrf,
    safeFetch: async (url: string) => {
      fetched.push(url)
      if (url === OEMBED) return Response.json(reducedOembed)
      if (url === VIDEO || url === AT_FORM || url === ELSEWHERE) return htmlAt(url)
      if (url === SHORT) return htmlAt(AT_FORM)
      if (url === COVER) return new Response(cover, { headers: { 'content-type': 'image/jpeg' } })
      return new Response(null, { status: 404 })
    },
  },
})

const { fetchLinkMeta } = await import('../../../server/links/meta.ts')

// Counts the "no post data" warnings a test produces, keeping the rest of
// the run's output quiet.
const warnings = (t: { mock: { method: typeof mock.method } }) => t.mock.method(console, 'warn', () => {}).mock

test('a TikTok save gets its caption, handle and cover from the video page', async () => {
  pageHtml = page(item(0, POST))
  fetched = []
  const meta = await fetchLinkMeta(VIDEO, 'tt-1')
  assert.equal(meta.siteTitle, POST.desc, 'the caption, not the shell page\'s "TikTok - Make Your Day"')
  assert.equal(meta.siteDesc, POST.desc, 'the caption is the only description a TikTok has')
  assert.equal(meta.author, 'somebaker', 'the handle, as the TikTok importer stores it')
  assert.equal(meta.siteName, 'TikTok')
  assert.equal(meta.thumb, '/uploads/meta-tt-1.jpg')
  assert.deepEqual(fetched, [OEMBED, VIDEO, COVER], 'no request beyond the page the scrape already fetched')
})

test("a long caption's title is its first line, at most 120 characters, as an Instagram caption's is", async () => {
  // Real captions run to thousands of characters over many lines (the demo
  // library's sourdough one is a full recipe), and siteTitle is the card's
  // provisional title.
  const first = `${'Same-day sourdough '.repeat(10)}#sourdough`
  const desc = `${first}\nIngredients:\n80g starter\n${'Fold, rest, fold. '.repeat(200)}`
  pageHtml = page(item(0, { ...POST, desc }))
  const meta = await fetchLinkMeta(VIDEO, 'tt-long')
  assert.equal(meta.siteTitle, first.slice(0, 120))
  assert.equal(meta.siteDesc, desc.slice(0, 2000))
})

test('an author that is not handle-shaped reads as absent rather than becoming the account', async () => {
  for (const uniqueId of ['some baker', 'x'.repeat(65), 'line\nbreak']) {
    pageHtml = page(item(0, { ...POST, author: { uniqueId } }))
    const meta = await fetchLinkMeta(VIDEO, 'tt-handle')
    assert.equal(meta.author, null, JSON.stringify(uniqueId))
  }
})

test('a captionless TikTok gets no title from the shell page, but keeps its handle and cover', async () => {
  pageHtml = page(item(0, { ...POST, desc: '' }))
  const meta = await fetchLinkMeta(VIDEO, 'tt-bare')
  assert.equal(meta.siteTitle, null, 'not "TikTok - Make Your Day"')
  assert.equal(meta.author, 'somebaker')
  assert.equal(meta.thumb, '/uploads/meta-tt-bare.jpg')
})

test('the "@/" form share redirects land on yields the post', async () => {
  pageHtml = page(item(0, POST))
  const meta = await fetchLinkMeta(AT_FORM, 'tt-at')
  assert.equal(meta.siteTitle, POST.desc)
  assert.equal(meta.author, 'somebaker')
})

test('a vm.tiktok.com short link, redirected to the video page, yields the post', async () => {
  pageHtml = page(item(0, POST))
  const meta = await fetchLinkMeta(SHORT, 'tt-short')
  assert.equal(meta.siteTitle, POST.desc)
  assert.equal(meta.author, 'somebaker')
  assert.equal(meta.thumb, '/uploads/meta-tt-short.jpg')
})

test("a page off tiktok.com is not read as a TikTok post, even carrying TikTok's script", async () => {
  pageHtml = page(item(0, POST))
  fetched = []
  const meta = await fetchLinkMeta(ELSEWHERE, 'tt-else')
  assert.equal(meta.siteTitle, 'TikTok - Make Your Day', "that page's own <title>")
  assert.equal(meta.author, null)
  assert.deepEqual(fetched, [ELSEWHERE], 'and no cover fetched off its say-so')
})

test('a deleted TikTok gets no title, author or cover, and says so in the log', async t => {
  // Live 2026-11-23: a removed video's page answers 200 with statusCode 10204
  // and no itemInfo.
  const warned = warnings(t)
  pageHtml = page(item(10204))
  const meta = await fetchLinkMeta(VIDEO, 'tt-2')
  assert.equal(meta.siteTitle, null)
  assert.equal(meta.author, null)
  assert.equal(meta.thumb, null)
  assert.equal(warned.callCount(), 1, 'one line, so TikTok closing this path is visible')
})

test('a post whose fields are not strings reads as absent rather than landing in the note', async () => {
  pageHtml = page(item(0, { desc: 42, author: { uniqueId: ['x'] }, video: { cover: 7 } }))
  fetched = []
  const meta = await fetchLinkMeta(VIDEO, 'tt-3')
  assert.equal(meta.siteTitle, null)
  assert.equal(meta.author, null)
  assert.deepEqual(fetched, [OEMBED, VIDEO])
})

test('unparseable page data is ignored and logged, not thrown', async t => {
  const warned = warnings(t)
  pageHtml = page('{"__DEFAULT_SCOPE__":')
  const meta = await fetchLinkMeta(VIDEO, 'tt-4')
  assert.equal(meta.siteTitle, null)
  assert.equal(warned.callCount(), 1)
})
