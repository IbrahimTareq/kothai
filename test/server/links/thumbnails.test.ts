// What happens to a link's og:image: shrunk before it is stored, and fetched
// again later when the download failed for a reason that passes.
//
// Mocks are installed before the subjects are imported; see oembed.test.ts.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { note } from '../../helpers/notes.ts'
import type { NoteRecord } from '../../../server/data/notes.ts'

// server/config.ts freezes the upload dir at import time, and saving a
// thumbnail writes it there.
process.env.KOTHAI_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'kothai-thumbnails-'))
const { UPLOAD_DIR } = await import('../../../server/config.ts')
mkdirSync(UPLOAD_DIR, { recursive: true })

const PAGE = 'https://example.com/post'
const IMAGE = 'https://cdn.example.com/og.png'

const solid = (width: number, height: number, alpha = 1) =>
  sharp({ create: { width, height, channels: 4, background: { r: 200, g: 80, b: 40, alpha } } })

// What the image URL answers. Swapped per test.
let image: { status?: number; error?: Error; body?: Buffer } = {}
let imageRequests = 0
const serve = async (body: Buffer | Promise<Buffer>) => {
  image = { body: await body }
}

const realSsrf = await import('../../../server/lib/ssrf.ts')
mock.module('../../../server/lib/ssrf.ts', {
  namedExports: {
    ...realSsrf,
    safeFetch: async (url: string) => {
      if (url === PAGE)
        return new Response(`<html><head><meta property="og:image" content="${IMAGE}"></head></html>`, {
          headers: { 'content-type': 'text/html' },
        })
      if (url !== IMAGE) return new Response(null, { status: 404 })
      imageRequests++
      if (image.error) throw image.error
      if (image.status) return new Response(null, { status: image.status })
      return new Response(image.body, { headers: { 'content-type': 'image/png' } })
    },
  },
})

const notes = new Map<string, NoteRecord>()
mock.module('../../../server/data/notes.ts', {
  namedExports: {
    getNote: (id: string) => notes.get(id),
    updateNote: async (id: string, patch: Partial<NoteRecord>) => {
      const n = notes.get(id)
      if (n) Object.assign(n, patch)
      return n ?? null
    },
  },
})

const { fetchLinkMeta } = await import('../../../server/links/meta.ts')
const { queueThumbRetry } = await import('../../../server/links/thumb-retry.ts')

const stored = (thumb: string | null | undefined) =>
  sharp(readFileSync(path.join(UPLOAD_DIR, path.basename(thumb || ''))))

// ---- shrinking --------------------------------------------------------------
// og:images arrive at whatever size the site publishes: the demo's twenty-one
// came to 3.7 MB, with Wikipedia's at 1280px and NN/g's at 8001x4188, all for
// cards about 250px wide.

test('saving: a huge opaque image is stored as a JPEG no longer than 960px on its long edge', async () => {
  await serve(solid(8001, 4188).png().toBuffer())
  const { thumb, thumbRatio } = await fetchLinkMeta(PAGE, 'big')
  assert.equal(thumb, '/uploads/meta-big.jpg')
  assert.equal(thumbRatio, 1.912, 'the stored shape, so a card holds it before the image loads')
  const meta = await stored(thumb).metadata()
  assert.equal(meta.format, 'jpeg')
  assert.equal(meta.width, 960)
  assert.equal(meta.height, 502)
})

test('saving: a small image is not enlarged', async () => {
  await serve(solid(200, 100).png().toBuffer())
  const meta = await stored((await fetchLinkMeta(PAGE, 'small')).thumb).metadata()
  assert.equal(meta.width, 200)
  assert.equal(meta.height, 100)
})

// A transparent logo flattened into a JPEG gets a box around it, so
// transparency keeps PNG. Not WebP for either: local vision (llama.cpp's
// stb_image) cannot decode it, and it reads these same files.
test('saving: a transparent image stays a PNG with its alpha', async () => {
  await serve(solid(1200, 1200, 0.5).png().toBuffer())
  const { thumb } = await fetchLinkMeta(PAGE, 'logo')
  assert.equal(thumb, '/uploads/meta-logo.png')
  const meta = await stored(thumb).metadata()
  assert.equal(meta.hasAlpha, true)
  assert.equal(meta.width, 960)
})

test('saving: bytes that are not an image leave no thumbnail, and are not retried', async () => {
  await serve(Promise.resolve(Buffer.from('<html>not an image</html>')))
  const meta = await fetchLinkMeta(PAGE, 'junk')
  assert.equal(meta.thumb, null)
  assert.ok(!meta.thumbSrc)
})

// ---- retrying -----------------------------------------------------------------
// A download that failed for a reason that passes used to lose the image for
// good: the note was marked fetched, and nothing looks at a fetched note's
// metadata again. A fresh demo hit exactly this, opengraph.githubassets.com
// answering 429 while the seed fetched every link at once.

test('fetchLinkMeta: an image that answers 429, 5xx or drops the connection is remembered', async () => {
  image = { status: 429 }
  assert.equal((await fetchLinkMeta(PAGE, 'n1')).thumbSrc, IMAGE)
  image = { status: 503 }
  assert.equal((await fetchLinkMeta(PAGE, 'n1')).thumbSrc, IMAGE)
  image = { error: new TypeError('fetch failed') }
  const meta = await fetchLinkMeta(PAGE, 'n1')
  assert.equal(meta.thumb, null)
  assert.equal(meta.thumbSrc, IMAGE)
})

test('fetchLinkMeta: an image that is gone (404) is not remembered', async () => {
  image = { status: 404 }
  const meta = await fetchLinkMeta(PAGE, 'n1')
  assert.equal(meta.thumb, null)
  assert.ok(!meta.thumbSrc)
})

// The retry runs on a timer, then on the network mock and sharp's thread pool,
// and a failed one schedules its next timer only once that work settles. So a
// test keeps advancing the mocked clock by `step` until the note changes, and
// is bounded by real time (Date is not mocked), not by a count of event-loop
// turns: under the full suite's load a fixed count ran out first.
async function until(check: () => boolean, tick: (ms: number) => void, step: number) {
  const deadline = Date.now() + 5000
  while (!check() && Date.now() < deadline) {
    tick(step)
    await new Promise(r => setImmediate(r))
  }
  assert.ok(check(), 'timed out waiting for the retry to land')
}

test('queueThumbRetry: keeps backing off while rate-limited, then stores the image and forgets the source', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  notes.set('n2', { ...note({ id: 'n2', url: PAGE }), thumbSrc: IMAGE })
  image = { status: 429 }
  imageRequests = 0
  const tick = (ms: number) => t.mock.timers.tick(ms)
  queueThumbRetry('n2')
  tick(60_000)
  await until(() => imageRequests === 1, tick, 0)
  assert.equal(notes.get('n2')?.thumbSrc, IMAGE, 'still worth asking')

  await serve(solid(40, 20).png().toBuffer())
  await until(() => notes.get('n2')?.thumbSrc === null, tick, 10 * 60_000)
  assert.equal(notes.get('n2')?.thumb, '/uploads/meta-n2.jpg')
  assert.equal(notes.get('n2')?.thumbRatio, 2)
  assert.equal(imageRequests, 2)
})

test('queueThumbRetry: an image that turns out to be gone is let go, and not asked for again', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  notes.set('n3', { ...note({ id: 'n3', url: PAGE }), thumbSrc: IMAGE })
  image = { status: 404 }
  imageRequests = 0
  const tick = (ms: number) => t.mock.timers.tick(ms)
  queueThumbRetry('n3')
  await until(() => notes.get('n3')?.thumbSrc === null, tick, 60_000)
  tick(2 * 60 * 60_000)
  await new Promise(r => setImmediate(r))
  assert.equal(imageRequests, 1)
  assert.ok(!notes.get('n3')?.thumb)
})
