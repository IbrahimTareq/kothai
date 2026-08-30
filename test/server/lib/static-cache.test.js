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
import { tmpdir } from 'node:os'
import path from 'node:path'

const TMP_UPLOADS = mkdtempSync(path.join(tmpdir(), 'stash-uploads-'))

const realNotes = await import('../../../server/data/notes.js')
mock.module('../../../server/data/notes.js', {
  namedExports: { ...realNotes, UPLOAD_DIR: TMP_UPLOADS },
})

const { serveStatic, cacheControlFor, etagFor } = await import('../../../server/lib/http.js')

function fakeReq(headers = {}) {
  return { method: 'GET', headers }
}

function fakeRes() {
  return {
    code: null,
    headers: {},
    body: undefined,
    ended: false,
    writeHead(code, headers) {
      this.code = code
      this.headers = Object.fromEntries(
        Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), v]),
      )
    },
    end(body) {
      this.body = body
      this.ended = true
    },
  }
}

function writeUpload(name, contents) {
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
  const res = fakeRes()
  await serveStatic(fakeReq(), res, '/uploads/meta-one.jpg')

  assert.equal(res.code, 200)
  assert.equal(res.headers['content-type'], 'image/jpeg')
  assert.ok(res.headers['etag'], 'needs an ETag to revalidate against')
  assert.ok(res.headers['last-modified'], 'needs Last-Modified')
  assert.ok(res.headers['cache-control'])
  assert.equal(res.body.toString(), 'imagebytes')
})

test('a matching If-None-Match gets a bodyless 304 instead of the bytes again', async () => {
  writeUpload('meta-two.jpg', 'imagebytes')
  const first = fakeRes()
  await serveStatic(fakeReq(), first, '/uploads/meta-two.jpg')

  const res = fakeRes()
  await serveStatic(fakeReq({ 'if-none-match': first.headers['etag'] }), res, '/uploads/meta-two.jpg')

  assert.equal(res.code, 304)
  assert.ok(!res.body || res.body.length === 0, '304 must carry no body')
  assert.equal(res.headers['etag'], first.headers['etag'])
  assert.ok(res.headers['cache-control'], '304 still refreshes the freshness policy')
})

test('re-enriching a note changes the ETag, so the stale thumbnail is replaced', async () => {
  const abs = writeUpload('meta-three.jpg', 'old-thumbnail')
  const first = fakeRes()
  await serveStatic(fakeReq(), first, '/uploads/meta-three.jpg')

  writeFileSync(abs, 'a-completely-new-thumbnail')
  const res = fakeRes()
  await serveStatic(fakeReq({ 'if-none-match': first.headers['etag'] }), res, '/uploads/meta-three.jpg')

  assert.equal(res.code, 200)
  assert.equal(res.body.toString(), 'a-completely-new-thumbnail')
  assert.notEqual(res.headers['etag'], first.headers['etag'])
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
  await serveStatic(fakeReq(), first, '/uploads/meta-five.jpg')

  const res = fakeRes()
  await serveStatic(
    fakeReq({ 'if-modified-since': first.headers['last-modified'] }),
    res,
    '/uploads/meta-five.jpg',
  )
  assert.equal(res.code, 304)
})

test('a non-matching If-None-Match still gets the full body', async () => {
  writeUpload('meta-six.jpg', 'imagebytes')
  const res = fakeRes()
  await serveStatic(fakeReq({ 'if-none-match': '"not-the-right-etag"' }), res, '/uploads/meta-six.jpg')

  assert.equal(res.code, 200)
  assert.equal(res.body.toString(), 'imagebytes')
})

test('a missing upload is still a plain 404, not a cached one', async () => {
  const res = fakeRes()
  await serveStatic(fakeReq(), res, '/uploads/nope.jpg')
  assert.equal(res.code, 404)
})
