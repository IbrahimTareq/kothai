// Tests for the caching half of server/lib/http.js serveStatic. Before this,
// every response carried only Content-Type, so each reload of Everything
// re-downloaded every thumbnail in full (hundreds of files, ~190KB average).
// Two different policies are needed, which is why cacheControlFor is pure and
// tested separately from the 304 plumbing:
//   - /uploads/* is user content under a STABLE name (meta-<noteId>.jpg is
//     overwritten in place when a note is re-enriched), so it must revalidate
//     rather than be pinned — hence ETag/Last-Modified + a short max-age.
//   - dist/assets/* is Vite output with a content hash in the filename, so a
//     changed file is a changed URL and it can be cached immutably forever.
//     index.html has no hash and gates every deploy, so it must never be.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, statSync, utimesSync } from 'node:fs'
import { IncomingMessage, ServerResponse } from 'node:http'
import type { IncomingHttpHeaders, OutgoingHttpHeader, OutgoingHttpHeaders } from 'node:http'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

const TMP_UPLOADS = mkdtempSync(path.join(tmpdir(), 'stash-uploads-'))

const realConfig = await import('../../../server/config.ts')
mock.module('../../../server/config.ts', {
  namedExports: { ...realConfig, UPLOAD_DIR: TMP_UPLOADS },
})

const { serveStatic, cacheControlFor, etagFor } = await import('../../../server/lib/http.ts')

function fakeReq(headers: IncomingHttpHeaders = {}): IncomingMessage {
  const req = new IncomingMessage(new Socket())
  req.method = 'GET'
  req.headers = headers
  return req
}

interface Sent {
  code: number | null
  headers: Record<string, string>
  body: Buffer | string | undefined
  ended: boolean
}

// A real ServerResponse with writeHead/end swapped for recorders. It has to be
// a real one because serveStatic is typed against node:http, and the recorders
// are what make it readable: a ServerResponse with no socket keeps nothing —
// getHeaders() comes back empty for headers handed to writeHead.
function fakeRes(): { raw: ServerResponse; sent: Sent } {
  const raw = new ServerResponse(fakeReq())
  const sent: Sent = { code: null, headers: {}, body: undefined, ended: false }
  raw.writeHead = (
    code: number,
    a?: string | OutgoingHttpHeaders | OutgoingHttpHeader[],
    b?: OutgoingHttpHeaders | OutgoingHttpHeader[],
  ) => {
    // node's writeHead also has a (code, statusMessage, headers) overload; the
    // recorder has to accept it to be assignable, though serveStatic only ever
    // calls the two-argument form.
    const headers = typeof a === 'string' ? b : a
    sent.code = code
    sent.headers = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]))
    return raw
  }
  raw.end = (body?: unknown) => {
    // node's end() also accepts a callback as its first argument; serveStatic
    // only ever passes the bytes or nothing, and a callback is not a body.
    sent.body = typeof body === 'string' || Buffer.isBuffer(body) ? body : undefined
    sent.ended = true
    return raw
  }
  return { raw, sent }
}

function writeUpload(name: string, contents: string) {
  const abs = path.join(TMP_UPLOADS, name)
  writeFileSync(abs, contents)
  return abs
}

// ---- cacheControlFor (pure policy) -------------------------------------

test('hashed build assets are cached immutably — a new build is a new URL', () => {
  const cc = cacheControlFor('/assets/index-CKKCRydn.js')
  assert.match(cc, /immutable/)
  assert.match(cc, /max-age=31536000/)
})

test('index.html is never cached immutably, so a deploy is picked up at once', () => {
  for (const p of ['/', '/index.html', '/everything', '/settings']) {
    const cc = cacheControlFor(p)
    assert.doesNotMatch(cc, /immutable/, `${p} must revalidate`)
    assert.match(cc, /no-cache/, `${p} must revalidate`)
  }
})

test('uploads revalidate rather than pin — meta-<id>.jpg is overwritten in place', () => {
  const cc = cacheControlFor('/uploads/meta-abc.jpg')
  assert.doesNotMatch(cc, /immutable/)
  assert.match(cc, /max-age=\d+/)
  // Private: uploads are the user's own content, never for a shared cache.
  assert.match(cc, /private/)
})

// ---- validators and 304 ------------------------------------------------

test('a thumbnail is served with the validators a 304 needs', async () => {
  writeUpload('meta-one.jpg', 'imagebytes')
  const { raw, sent } = fakeRes()
  await serveStatic(fakeReq(), raw, '/uploads/meta-one.jpg')

  assert.equal(sent.code, 200)
  assert.equal(sent.headers['content-type'], 'image/jpeg')
  assert.ok(sent.headers.etag, 'needs an ETag to revalidate against')
  assert.ok(sent.headers['last-modified'], 'needs Last-Modified')
  assert.ok(sent.headers['cache-control'])
  assert.equal(sent.body?.toString(), 'imagebytes')
})

test('a matching If-None-Match gets a bodyless 304 instead of the bytes again', async () => {
  writeUpload('meta-two.jpg', 'imagebytes')
  const first = fakeRes()
  await serveStatic(fakeReq(), first.raw, '/uploads/meta-two.jpg')

  const { raw, sent } = fakeRes()
  await serveStatic(fakeReq({ 'if-none-match': first.sent.headers.etag }), raw, '/uploads/meta-two.jpg')

  assert.equal(sent.code, 304)
  assert.ok(!sent.body || sent.body.length === 0, '304 must carry no body')
  assert.equal(sent.headers.etag, first.sent.headers.etag)
  assert.ok(sent.headers['cache-control'], '304 still refreshes the freshness policy')
})

test('re-enriching a note changes the ETag, so the stale thumbnail is replaced', async () => {
  const abs = writeUpload('meta-three.jpg', 'old-thumbnail')
  const first = fakeRes()
  await serveStatic(fakeReq(), first.raw, '/uploads/meta-three.jpg')

  writeFileSync(abs, 'a-completely-new-thumbnail')
  const { raw, sent } = fakeRes()
  await serveStatic(fakeReq({ 'if-none-match': first.sent.headers.etag }), raw, '/uploads/meta-three.jpg')

  assert.equal(sent.code, 200)
  assert.equal(sent.body?.toString(), 'a-completely-new-thumbnail')
  assert.notEqual(sent.headers.etag, first.sent.headers.etag)
})

test('a same-size overwrite still changes the ETag — size alone is not enough', async () => {
  const abs = writeUpload('meta-four.jpg', 'aaaaaaaa')
  const before = etagFor(statSync(abs))
  // Same byte length, later mtime: the exact shape of an in-place re-enrich.
  writeFileSync(abs, 'bbbbbbbb')
  const later = new Date(Date.now() + 5000)
  utimesSync(abs, later, later)
  assert.notEqual(etagFor(statSync(abs)), before)
})

test('If-Modified-Since alone also gets a 304', async () => {
  writeUpload('meta-five.jpg', 'imagebytes')
  const first = fakeRes()
  await serveStatic(fakeReq(), first.raw, '/uploads/meta-five.jpg')

  const { raw, sent } = fakeRes()
  await serveStatic(
    fakeReq({ 'if-modified-since': first.sent.headers['last-modified'] }),
    raw,
    '/uploads/meta-five.jpg',
  )
  assert.equal(sent.code, 304)
})

test('a non-matching If-None-Match still gets the full body', async () => {
  writeUpload('meta-six.jpg', 'imagebytes')
  const { raw, sent } = fakeRes()
  await serveStatic(fakeReq({ 'if-none-match': '"not-the-right-etag"' }), raw, '/uploads/meta-six.jpg')

  assert.equal(sent.code, 200)
  assert.equal(sent.body?.toString(), 'imagebytes')
})

test('a missing upload is still a plain 404, not a cached one', async () => {
  const { raw, sent } = fakeRes()
  await serveStatic(fakeReq(), raw, '/uploads/nope.jpg')
  assert.equal(sent.code, 404)
})
