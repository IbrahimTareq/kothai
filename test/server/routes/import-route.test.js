// Tests for server/routes/import.js — the HTTP route tying the ZIP reader,
// the importer registry, and the phase-one save + background-enrich pattern
// together. Runs the handler directly against a fake req/res: the real
// server/import/* modules are pure (no disk/network), so only the note store,
// the collections store, and the enrich queue are stubbed via node:test's
// mock.module (requires --experimental-test-module-mocks, wired into
// `pnpm test`) — the same pattern test/enrich-instagram-chain.test.js uses.
//
// The fake note/collections stores below deliberately mirror the REAL
// stores' semantics (attach() clearing removedIds, create() defaulting
// removedIds: [], etc.) — a review round found that an earlier, looser
// version of these stubs masked a real bug (a smart Space's removedIds
// getting silently cleared by an import) because the fake didn't reproduce
// the behavior that made it dangerous.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { deflateRawSync } from 'node:zlib'

// ---- in-memory fake note store -----------------------------------------
let notes
let flushCalls
let flushImpl
let addNoteCalls
let removeManyCalls
function seedNotes(list) {
  notes = list.map((n) => ({ ...n }))
}
function fakeAllNotes() {
  return notes.map((n) => ({ ...n }))
}
let nextId = 1
let addNoteImpl = async () => {}
async function fakeAddNote(note, opts) {
  addNoteCalls.push({ note, opts })
  await addNoteImpl(note)
  const record = { id: `note-${nextId++}`, createdAt: new Date().toISOString(), tags: [], ...note }
  notes.unshift(record)
  return { ...record }
}
async function fakeFlush() {
  flushCalls++
  return flushImpl()
}
async function fakeRemoveMany(ids) {
  removeManyCalls.push([...ids])
  const idSet = new Set(ids)
  notes = notes.filter((n) => !idSet.has(n.id))
}

// ---- in-memory fake collections store ----------------------------------
// Mirrors server/data/collections.js's attach()/create() semantics exactly:
// create() always sets removedIds: [] alongside itemIds: [], and addItem's
// attach() both dedup-adds to itemIds AND removes the id from removedIds.
let spaces
let addItemCalls
function seedSpaces(list) {
  spaces = list.map((s) => ({ ...s, itemIds: [...s.itemIds], removedIds: [...(s.removedIds || [])] }))
}
function fakeSpacesAll() {
  return spaces.map((s) => ({ ...s }))
}
let nextSpaceId = 1
async function fakeCreateSpace({ name, tags = [] }) {
  const s = { id: `space-${nextSpaceId++}`, name, tags, itemIds: [], removedIds: [] }
  // Matches server/data/collections.js's real create(), which UNSHIFTS —
  // an earlier version of this stub used push(), which made all() return
  // OLDEST-first instead of newest-first. That divergence masked a real
  // bug (MUST FIX N1): the route's spaceByLowerName index relied on
  // newest-first ordering to correctly prefer a freshly-created plain
  // mirror Space over an older same-named smart one.
  spaces.unshift(s)
  return { ...s }
}
async function fakeAddItem(id, itemId) {
  const s = spaces.find((x) => x.id === id)
  if (!s) return null
  addItemCalls.push({ id, itemId })
  if (!s.itemIds.includes(itemId)) s.itemIds.unshift(itemId)
  s.removedIds = s.removedIds.filter((x) => x !== itemId)
  return { ...s }
}

// ---- fake enrich queue ---------------------------------------------------
let queueEnrichCalls

// ---- fake importer override (for testing route defensiveness against a
// misbehaving/future importer, without needing a real broken export) -------
let importerOverride = null

function reset() {
  seedNotes([])
  seedSpaces([])
  nextId = 1
  nextSpaceId = 1
  flushCalls = 0
  flushImpl = async () => {}
  addNoteImpl = async () => {}
  addNoteCalls = []
  removeManyCalls = []
  addItemCalls = []
  queueEnrichCalls = []
  importerOverride = null
}
reset()

const realStore = await import('../../../server/data/notes.js')
const realCollections = await import('../../../server/data/collections.js')
const realEnrich = await import('../../../server/ai/enrich.js')
const realImportIndex = await import('../../../server/import/index.js')

mock.module('../../../server/data/notes.js', {
  namedExports: {
    ...realStore,
    allNotes: () => fakeAllNotes(),
    addNote: (note, opts) => fakeAddNote(note, opts),
    flush: () => fakeFlush(),
    removeMany: (ids) => fakeRemoveMany(ids),
  },
})
mock.module('../../../server/data/collections.js', {
  namedExports: {
    ...realCollections,
    all: () => fakeSpacesAll(),
    create: (input) => fakeCreateSpace(input),
    addItem: (id, itemId) => fakeAddItem(id, itemId),
  },
})
mock.module('../../../server/ai/enrich.js', {
  namedExports: {
    ...realEnrich,
    queueEnrich: (id, job) => { queueEnrichCalls.push({ id, job }) },
  },
})
mock.module('../../../server/import/index.js', {
  namedExports: {
    ...realImportIndex,
    findImporter: (files) => (importerOverride ?? realImportIndex.findImporter(files)),
  },
})

const { handleImport } = await import('../../../server/routes/import.js')

// ---- fake req/res helpers -------------------------------------------------
// A real EventEmitter satisfies readBody's req.on('data'/'end'/'error') +
// req.destroy() contract, so the route exercises the REAL http.js readBody
// (and its size-limit rejection path) rather than a stand-in.
function fakeReq(payload) {
  const req = new EventEmitter()
  req.destroy = () => {}
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload)
  setImmediate(() => {
    req.emit('data', Buffer.from(raw))
    req.emit('end')
  })
  return req
}

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    writeHead(code) { this.statusCode = code },
    end(str) { this.body = str ? JSON.parse(str) : null },
  }
}

function b64(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64')
}

function savedPostsPayload(rows) {
  return { saved_saved_media: rows }
}

// The route's file-not-zip fallback carries exactly ONE named file, but
// parse() matches saved_posts.json / saved_collections.json by FILE NAME —
// not by JSON top-level key — so a saved_posts + saved_collections scenario
// can only be exercised through a real two-entry ZIP (see makeZip below).
function savedPostsAndCollectionsZip(rows, collectionRows) {
  return makeZip([
    { name: 'your_instagram_activity/saved/saved_posts.json', data: Buffer.from(JSON.stringify(savedPostsPayload(rows))) },
    { name: 'your_instagram_activity/saved/saved_collections.json', data: Buffer.from(JSON.stringify({ saved_saved_collections: collectionRows })) },
  ])
}

function post(poster, code, ts = 1718000000, { path = 'p' } = {}) {
  return { title: poster, string_map_data: { 'Saved on': { href: `https://www.instagram.com/${path}/${code}/`, timestamp: ts } } }
}

// parseSavedPosts falls back to ANY usable http(s) href when a row has no
// Instagram-permalink-shaped one (instagram.js:116) — so a non-Instagram
// link is a real, reachable shape for an "item", not just a theoretical one.
function nonIgPost(title, href, ts = 1718000000) {
  return { title, string_map_data: { 'Saved on': { href, timestamp: ts } } }
}

// Minimal valid stored-mode ZIP builder (mirrors test/zip.test.js's approach)
// so the corrupt-ZIP test can also sanity-check a WELL-formed one without a
// third-party zip library — deliberately reuses the "PK" sniff the route uses.
function crc32(buf) {
  let c
  const table = crc32.table || (crc32.table = (() => {
    const t = []
    for (let n = 0; n < 256; n++) {
      c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
      t[n] = c >>> 0
    }
    return t
  })())
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function makeZip(entries) {
  // entries: [{ name, data: Buffer }]
  const localParts = []
  const centralParts = []
  let offset = 0
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const compressed = deflateRawSync(data)
    const crc = crc32(data)
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4) // version needed
    localHeader.writeUInt16LE(0, 6) // flags
    localHeader.writeUInt16LE(8, 8) // method: deflate
    localHeader.writeUInt16LE(0, 10) // time
    localHeader.writeUInt16LE(0, 12) // date
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(compressed.length, 18)
    localHeader.writeUInt32LE(data.length, 22)
    localHeader.writeUInt16LE(nameBuf.length, 26)
    localHeader.writeUInt16LE(0, 28)
    localParts.push(localHeader, nameBuf, compressed)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(0, 8)
    centralHeader.writeUInt16LE(8, 10)
    centralHeader.writeUInt16LE(0, 12)
    centralHeader.writeUInt16LE(0, 14)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(compressed.length, 20)
    centralHeader.writeUInt32LE(data.length, 24)
    centralHeader.writeUInt16LE(nameBuf.length, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE(0, 38)
    centralHeader.writeUInt32LE(offset, 42)
    centralParts.push(centralHeader, nameBuf)

    offset += localHeader.length + nameBuf.length + compressed.length
  }
  const centralStart = offset
  const central = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(central.length, 12)
  eocd.writeUInt32LE(centralStart, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...localParts, central, eocd])
}

// ---- tests ----------------------------------------------------------------

test('happy path: imports posts, queues enrich, reports counts', async () => {
  reset()
  const payload = savedPostsPayload([post('natgeo', 'AAA111'), post('chefsteps', 'BBB222')])
  const res = fakeRes()
  await handleImport(fakeReq({ name: 'saved_posts.json', data: b64(payload) }), res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.importer, 'instagram')
  assert.equal(res.body.imported, 2)
  assert.equal(res.body.skipped, 0)
  assert.equal(res.body.failed, 0)
  assert.deepEqual(res.body.warnings, [])
  assert.equal(notes.length, 2)
  assert.equal(flushCalls, 1, 'one batched flush, not one persist per note')
  assert.equal(queueEnrichCalls.length, 2, 'each imported note is queued for background enrich')
})

// MUST FIX F3 (review round): enrich must be queued only AFTER the batch
// flush succeeds, never while notes are still being added — otherwise a
// later flush failure leaves orphaned jobs for ids that get rolled back
// (see the flush-failure test below for the concrete harm).
test('enrich is not queued while notes are still being added — only after the batch flush succeeds', async () => {
  reset()
  const seenDuringAdd = []
  addNoteImpl = async () => { seenDuringAdd.push(queueEnrichCalls.length) }
  const payload = savedPostsPayload([post('natgeo', 'AAA111'), post('chefsteps', 'BBB222')])
  await handleImport(fakeReq({ name: 'saved_posts.json', data: b64(payload) }), fakeRes())
  assert.deepEqual(seenDuringAdd, [0, 0], 'queueEnrich must not have fired yet while the add loop is still running')
  assert.equal(queueEnrichCalls.length, 2, 'both get queued once the batch is actually flushed')
})

test('the note handed to addNote carries the instagram tag and a createdAt derived from savedAt', async () => {
  reset()
  const payload = savedPostsPayload([post('natgeo', 'AAA111', 1718000000)])
  await handleImport(fakeReq({ name: 'saved_posts.json', data: b64(payload) }), fakeRes())

  assert.equal(addNoteCalls.length, 1)
  const { note, opts } = addNoteCalls[0]
  assert.deepEqual(note.tags, ['instagram'])
  assert.equal(note.createdAt, new Date(1718000000 * 1000).toISOString())
  assert.equal(note.url, 'https://www.instagram.com/p/AAA111/')
  assert.equal(opts.persist, false, 'each add is batched, not persisted individually')
})

test('url dedup: re-importing the same export is idempotent', async () => {
  reset()
  const payload = savedPostsPayload([post('natgeo', 'AAA111')])
  const res1 = fakeRes()
  await handleImport(fakeReq({ name: 'saved_posts.json', data: b64(payload) }), res1)
  assert.equal(res1.body.imported, 1)

  const res2 = fakeRes()
  await handleImport(fakeReq({ name: 'saved_posts.json', data: b64(payload) }), res2)
  assert.equal(res2.body.imported, 0, 'nothing new to add the second time')
  assert.equal(res2.body.skipped, 1)
  assert.equal(notes.length, 1, 'no duplicate note was created')
})

test('a duplicate url WITHIN one export is also deduped (not just against pre-existing notes)', async () => {
  reset()
  const payload = savedPostsPayload([post('natgeo', 'AAA111'), post('natgeo', 'AAA111')])
  const res = fakeRes()
  await handleImport(fakeReq({ name: 'saved_posts.json', data: b64(payload) }), res)
  assert.equal(res.body.imported, 1)
  assert.equal(res.body.skipped, 1)
})

// MUST FIX 1 (review round): dedup must key on a CANONICAL url, not the raw
// string — a hand-saved link and the same post re-arriving via export almost
// never share byte-identical URLs.
test('canonical url dedup: www / trailing slash / tracking query do not defeat dedup against an existing note', async () => {
  reset()
  seedNotes([{ id: 'existing-1', url: 'https://instagram.com/p/AAA111', tags: [] }])
  const payload = savedPostsPayload([post('natgeo', 'AAA111')]) // https://www.instagram.com/p/AAA111/
  const res = fakeRes()
  await handleImport(fakeReq({ name: 'saved_posts.json', data: b64(payload) }), res)
  assert.equal(res.body.imported, 0)
  assert.equal(res.body.skipped, 1)
  assert.equal(notes.length, 1, 'still just the one pre-existing note')
})

test('canonical url dedup: a tracking query string on the pre-existing note does not defeat dedup', async () => {
  reset()
  seedNotes([{ id: 'existing-1', url: 'https://www.instagram.com/p/AAA111/?igsh=abc123', tags: [] }])
  const payload = savedPostsPayload([post('natgeo', 'AAA111')])
  const res = fakeRes()
  await handleImport(fakeReq({ name: 'saved_posts.json', data: b64(payload) }), res)
  assert.equal(res.body.imported, 0)
  assert.equal(res.body.skipped, 1)
})

test('canonical url dedup: /reel/<code>/ and /p/<code>/ for the same shortcode are the same post', async () => {
  reset()
  seedNotes([{ id: 'existing-1', url: 'https://www.instagram.com/reel/AAA111/', tags: [] }])
  const payload = savedPostsPayload([post('natgeo', 'AAA111', 1718000000, { path: 'p' })])
  const res = fakeRes()
  await handleImport(fakeReq({ name: 'saved_posts.json', data: b64(payload) }), res)
  assert.equal(res.body.imported, 0)
  assert.equal(res.body.skipped, 1, '/p/AAA111/ must be recognized as the same post as the existing /reel/AAA111/')
})

// MUST FIX F6 (review round): the /p|reel|reels|tv/ path KEYWORD match must
// be case-insensitive (Instagram never actually produces uppercase here, but
// nothing guarantees a hand-typed/hand-edited url won't be) — the captured
// SHORTCODE itself, however, must stay case-sensitive, since shortcodes are.
test('canonical url dedup is case-insensitive on the IG path keyword only', async () => {
  reset()
  seedNotes([{ id: 'existing-1', url: 'https://www.instagram.com/P/AAA111/', tags: [] }])
  const payload = savedPostsPayload([post('natgeo', 'AAA111')]) // lowercase /p/
  const res = fakeRes()
  await handleImport(fakeReq({ name: 'saved_posts.json', data: b64(payload) }), res)
  assert.equal(res.body.skipped, 1, 'uppercase /P/ and lowercase /p/ must be recognized as the same post')
})

// MUST FIX F1 (review round, HIGH — silent data loss): an earlier version of
// canonicalUrl dropped the query string and port for EVERY host (not just
// Instagram), so distinct non-Instagram links with different query params
// or ports false-merged into the SAME canonical key — losing one of the two
// notes entirely. This is reachable today: parseSavedPosts falls back to
// any usable href when a row has no Instagram-permalink-shaped one.
test('two distinct query-differentiated non-Instagram URLs import as two separate notes, not merged', async () => {
  reset()
  const payload = savedPostsPayload([
    nonIgPost('yt1', 'https://www.youtube.com/watch?v=AAA'),
    nonIgPost('yt2', 'https://www.youtube.com/watch?v=BBB'),
  ])
  const res = fakeRes()
  await handleImport(fakeReq({ name: 'saved_posts.json', data: b64(payload) }), res)
  assert.equal(res.body.imported, 2, 'both distinct links must be imported, not merged into one')
  assert.equal(res.body.skipped, 0)
  assert.equal(notes.length, 2)
})

test('two distinct non-Instagram URLs differing only by port are treated as distinct notes', async () => {
  reset()
  const payload = savedPostsPayload([
    nonIgPost('a', 'https://example.com:8443/a'),
    nonIgPost('b', 'https://example.com:9999/a'),
  ])
  const res = fakeRes()
  await handleImport(fakeReq({ name: 'saved_posts.json', data: b64(payload) }), res)
  assert.equal(res.body.imported, 2)
})

test('a hand-saved non-Instagram link and a distinct-query import target both survive (no cross-item false merge)', async () => {
  reset()
  seedNotes([{ id: 'existing-1', url: 'https://news.ycombinator.com/item?id=1', tags: [] }])
  const payload = savedPostsPayload([nonIgPost('hn2', 'https://news.ycombinator.com/item?id=2')])
  const res = fakeRes()
  await handleImport(fakeReq({ name: 'saved_posts.json', data: b64(payload) }), res)
  assert.equal(res.body.imported, 1, 'a distinct thread (different id=) must still be imported')
  assert.equal(notes.length, 2, 'the pre-existing note must not have been treated as a match and dropped')
})

test('a tracking query param (utm_) alone does not defeat dedup for a non-Instagram link', async () => {
  reset()
  seedNotes([{ id: 'existing-1', url: 'https://example.com/article', tags: [] }])
  const payload = savedPostsPayload([nonIgPost('x', 'https://example.com/article?utm_source=ig&utm_medium=share')])
  const res = fakeRes()
  await handleImport(fakeReq({ name: 'saved_posts.json', data: b64(payload) }), res)
  assert.equal(res.body.skipped, 1)
  assert.equal(res.body.imported, 0)
})

// ALSO fix #1 (review round): `si` is a YouTube/Spotify share-tracking
// param, but on an arbitrary host it could just as easily be a real query
// param (e.g. a search-index id) — stripping it globally would false-merge
// distinct links on unrelated sites the same way F1 did for `v=`/`id=`.
test('the "si" tracking param is stripped on YouTube (dedup survives it)', async () => {
  reset()
  seedNotes([{ id: 'existing-1', url: 'https://www.youtube.com/watch?v=AAA', tags: [] }])
  const payload = savedPostsPayload([nonIgPost('x', 'https://www.youtube.com/watch?v=AAA&si=abc123')])
  const res = fakeRes()
  await handleImport(fakeReq({ name: 'saved_posts.json', data: b64(payload) }), res)
  assert.equal(res.body.skipped, 1, 'si must be stripped on youtube.com so dedup still matches')
})

test('the "si" query param is NOT stripped on an arbitrary host — two distinct si values stay distinct', async () => {
  reset()
  const payload = savedPostsPayload([
    nonIgPost('a', 'https://shop.example.com/list?si=1'),
    nonIgPost('b', 'https://shop.example.com/list?si=2'),
  ])
  const res = fakeRes()
  await handleImport(fakeReq({ name: 'saved_posts.json', data: b64(payload) }), res)
  assert.equal(res.body.imported, 2, 'si is a real (non-tracking) param on this host and must not be stripped')
})

test('a post in multiple IG collections lands in each corresponding Space', async () => {
  reset()
  const zip = savedPostsAndCollectionsZip(
    [post('natgeo', 'AAA111')],
    [
      { title: 'Recipes', list: [{ href: 'https://www.instagram.com/p/AAA111/' }] },
      { title: 'Travel', list: [{ href: 'https://www.instagram.com/p/AAA111/' }] },
    ],
  )
  const res = fakeRes()
  await handleImport(fakeReq({ name: 'export.zip', data: zip.toString('base64') }), res)

  assert.equal(res.body.imported, 1)
  assert.equal(res.body.collections, 2)
  const names = spaces.map((s) => s.name).sort()
  assert.deepEqual(names, ['Recipes', 'Travel'])
  const noteId = notes[0].id
  for (const s of spaces) assert.ok(s.itemIds.includes(noteId), `note filed into ${s.name}`)
})

test('an existing Space is matched case-insensitively rather than duplicated', async () => {
  reset()
  seedSpaces([{ id: 'space-existing', name: 'recipes', tags: [], itemIds: [] }])
  const zip = savedPostsAndCollectionsZip(
    [post('natgeo', 'AAA111')],
    [{ title: 'Recipes', list: [{ href: 'https://www.instagram.com/p/AAA111/' }] }],
  )
  const res = fakeRes()
  await handleImport(fakeReq({ name: 'export.zip', data: zip.toString('base64') }), res)

  assert.equal(spaces.length, 1, 'no duplicate Space was created for a case-different name match')
  assert.equal(spaces[0].id, 'space-existing')
  assert.ok(spaces[0].itemIds.includes(notes[0].id))
})

// MUST FIX 2 (review round): filing must resolve from `items`, not from only
// newly-added notes — otherwise a re-import (dedup skip) can never sync a
// collection the user added the post to after the last export.
test('re-import with a NEWLY-added IG collection files the already-existing note into a new Space', async () => {
  reset()
  // First import: no collections file at all, just the bare post.
  const first = savedPostsPayload([post('natgeo', 'AAA111')])
  const res1 = fakeRes()
  await handleImport(fakeReq({ name: 'saved_posts.json', data: b64(first) }), res1)
  assert.equal(res1.body.imported, 1)
  assert.equal(res1.body.collections, 0)
  const noteId = notes[0].id

  // Second import: same post (now a dedup-skip) but the export now also
  // carries a "Recipes" collection membership for it.
  const zip = savedPostsAndCollectionsZip(
    [post('natgeo', 'AAA111')],
    [{ title: 'Recipes', list: [{ href: 'https://www.instagram.com/p/AAA111/' }] }],
  )
  const res2 = fakeRes()
  await handleImport(fakeReq({ name: 'export.zip', data: zip.toString('base64') }), res2)

  assert.equal(res2.body.imported, 0, 'the post itself is still a dedup-skip')
  assert.equal(res2.body.skipped, 1)
  assert.equal(res2.body.collections, 1, 'a Space was still created/filed for the already-existing note')
  const space = spaces.find((s) => s.name === 'Recipes')
  assert.ok(space, 'the Recipes Space was created')
  assert.ok(space.itemIds.includes(noteId), 'the EXISTING note (not a new one) was filed into it')
})

// MUST FIX F2 (review round, promoted from an earlier looser "addItem is
// idempotent" test that turned out to be vacuous — dedup meant `members`
// was empty on the second call, so addItem was never actually exercised a
// second time). Filing now resolves from `items` (so a re-import CAN see
// unchanged membership), which means the route itself — not just attach()'s
// internal dedup — must skip the redundant call, or a no-op re-import of a
// large export would cost one collections-table row write per membership,
// every single time.
test('re-importing an unchanged export skips redundant addItem calls entirely (no write-per-membership storm)', async () => {
  reset()
  const zip = savedPostsAndCollectionsZip(
    [post('natgeo', 'AAA111')],
    [{ title: 'Recipes', list: [{ href: 'https://www.instagram.com/p/AAA111/' }] }],
  )
  const res1 = fakeRes()
  await handleImport(fakeReq({ name: 'export.zip', data: zip.toString('base64') }), res1)
  const noteId = notes[0].id
  assert.equal(addItemCalls.length, 1, 'filed once on the first import')
  assert.equal(res1.body.collections, 1)

  const res2 = fakeRes()
  await handleImport(fakeReq({ name: 'export.zip', data: zip.toString('base64') }), res2)
  assert.equal(addItemCalls.length, 1, 'no redundant addItem call for membership that already exists')
  assert.equal(res2.body.collections, 0, 'nothing actually changed, so this collection is not reported as touched')
  const space = spaces.find((s) => s.name === 'Recipes')
  assert.deepEqual(space.itemIds, [noteId])
})

// MUST FIX F4 (review round, MEDIUM — undoes a deliberate user action on the
// mainline path): for a PLAIN (non-smart) Space, addItem's attach() clears
// removedIds unconditionally — so re-filing a post the user had hand
// -removed from a Space the import itself created would silently resurrect
// it on every subsequent re-import. Same harm as the smart-Space guard
// (MUST FIX 4 from the prior round), just for manual removal instead of a
// tag rule, and it hits the common case: a Space the import created, from
// which the user then removed one post.
test('a re-import does not resurrect an item the user hand-removed from a PLAIN Space', async () => {
  reset()
  seedNotes([{ id: 'existing-1', url: 'https://www.instagram.com/p/AAA111/', tags: [] }])
  seedSpaces([{ id: 'plain-1', name: 'Recipes', tags: [], itemIds: [], removedIds: ['existing-1'] }])
  const zip = savedPostsAndCollectionsZip(
    [post('natgeo', 'AAA111')],
    [{ title: 'Recipes', list: [{ href: 'https://www.instagram.com/p/AAA111/' }] }],
  )
  const res = fakeRes()
  await handleImport(fakeReq({ name: 'export.zip', data: zip.toString('base64') }), res)

  const space = spaces.find((s) => s.id === 'plain-1')
  assert.deepEqual(space.itemIds, [], 'hand-removed item must not be re-added')
  assert.deepEqual(space.removedIds, ['existing-1'], 'removal must stick — not cleared by the import')
  assert.equal(addItemCalls.length, 0, 'addItem must not even be called for a hand-removed id')
  assert.equal(res.body.collections, 0, 'nothing actually changed for this Space')
})

// MUST FIX 4 (review round): a name collision with a SMART (tag-rule) Space
// must never reuse it — that would file unrelated posts into a rule-driven
// Space and, via attach()'s removedIds-clearing, resurrect items the user
// deliberately hand-removed from it.
test('a name collision with a SMART Space creates a distinct "(Instagram)" Space instead of reusing it', async () => {
  reset()
  seedSpaces([{
    id: 'smart-1', name: 'Recipes', tags: ['cooking'], itemIds: ['note-hand-added'], removedIds: ['note-hand-removed'],
  }])
  const zip = savedPostsAndCollectionsZip(
    [post('natgeo', 'AAA111')],
    [{ title: 'Recipes', list: [{ href: 'https://www.instagram.com/p/AAA111/' }] }],
  )
  const res = fakeRes()
  await handleImport(fakeReq({ name: 'export.zip', data: zip.toString('base64') }), res)

  assert.equal(res.body.collections, 1)
  const smart = spaces.find((s) => s.id === 'smart-1')
  assert.deepEqual(smart.itemIds, ['note-hand-added'], 'the smart Space\'s membership is untouched')
  assert.deepEqual(smart.removedIds, ['note-hand-removed'], 'a hand-removed item must NOT be resurrected')

  const mirror = spaces.find((s) => s.name === 'Recipes (Instagram)')
  assert.ok(mirror, 'a distinct Space was created for the IG collection instead')
  assert.ok(mirror.itemIds.includes(notes[0].id))
  assert.equal(spaces.length, 2, 'exactly one new Space, the smart one untouched')
})

// MUST FIX F5 (review round, LOW): the "(Instagram)" fallback name was
// looked up but never re-checked for tags.length, so a user's OWN smart
// Space literally named "Recipes (Instagram)" would receive IG items and
// have its removedIds cleared — the exact harm the fallback exists to avoid,
// just one hop later.
test('if the "(Instagram)" fallback name is ALSO a smart Space, a further fresh Space is created instead', async () => {
  reset()
  seedSpaces([
    { id: 'smart-1', name: 'Recipes', tags: ['cooking'], itemIds: [], removedIds: [] },
    { id: 'smart-2', name: 'Recipes (Instagram)', tags: ['food'], itemIds: ['note-x'], removedIds: ['note-y'] },
  ])
  const zip = savedPostsAndCollectionsZip(
    [post('natgeo', 'AAA111')],
    [{ title: 'Recipes', list: [{ href: 'https://www.instagram.com/p/AAA111/' }] }],
  )
  const res = fakeRes()
  await handleImport(fakeReq({ name: 'export.zip', data: zip.toString('base64') }), res)

  const smart1 = spaces.find((s) => s.id === 'smart-1')
  const smart2 = spaces.find((s) => s.id === 'smart-2')
  assert.deepEqual(smart1.itemIds, [], 'the first smart Space is untouched')
  assert.deepEqual(smart2.itemIds, ['note-x'], 'the "(Instagram)"-named smart Space must ALSO be untouched')
  assert.deepEqual(smart2.removedIds, ['note-y'])

  const noteId = notes[0].id
  const freshMirror = spaces.find((s) => s.itemIds.includes(noteId))
  assert.ok(freshMirror, 'a third Space was created to hold the imported note')
  assert.notEqual(freshMirror.id, 'smart-1')
  assert.notEqual(freshMirror.id, 'smart-2')
})

// MUST FIX N1 (review round, MEDIUM — the fix above mints a duplicate Space
// on EVERY re-import). collections.all() is newest-first (create() unshifts
// — see fakeCreateSpace's comment above), so a naive last-wins index build
// resolves a name collision to whichever entry is OLDEST, not newest. Once
// the F5 fallback creates a plain mirror, the NEXT run's naive index would
// hand back the original (older) smart Space again for that same name,
// reject it again, and mint ANOTHER mirror — forever. This test imports the
// SAME export four times in a row and checks the mirror count never grows
// past one — a single import (like the F5 test above) cannot expose this,
// since the collision only exists starting on the SECOND run.
test('four consecutive re-imports against a same-named smart Space produce exactly ONE mirror Space', async () => {
  reset()
  seedSpaces([
    { id: 'smart-recipes', name: 'Recipes', tags: ['cooking'], itemIds: [], removedIds: [] },
    { id: 'smart-recipes-ig', name: 'Recipes (Instagram)', tags: ['food'], itemIds: [], removedIds: [] },
  ])
  const zip = savedPostsAndCollectionsZip(
    [post('natgeo', 'AAA111')],
    [{ title: 'Recipes', list: [{ href: 'https://www.instagram.com/p/AAA111/' }] }],
  )
  for (let i = 0; i < 4; i++) {
    await handleImport(fakeReq({ name: 'export.zip', data: zip.toString('base64') }), fakeRes())
  }

  assert.equal(spaces.length, 3, 'exactly one mirror Space total, not one freshly minted per re-import')
  const mirrors = spaces.filter((s) => s.name === 'Recipes (Instagram)' && (!s.tags || s.tags.length === 0))
  assert.equal(mirrors.length, 1)
  assert.ok(mirrors[0].itemIds.includes(notes[0].id))

  const smartRecipes = spaces.find((s) => s.id === 'smart-recipes')
  const smartRecipesIg = spaces.find((s) => s.id === 'smart-recipes-ig')
  assert.deepEqual(smartRecipes.itemIds, [], 'the smart "Recipes" Space is never touched')
  assert.deepEqual(smartRecipesIg.itemIds, [], 'the smart "Recipes (Instagram)" Space is never touched')
})

test('unrecognized payload -> 400', async () => {
  reset()
  const res = fakeRes()
  await handleImport(fakeReq({ name: 'random.json', data: b64({ hello: 'world' }) }), res)
  assert.equal(res.statusCode, 400)
  assert.match(res.body.error, /not a recognized export/i)
})

test('corrupt ZIP -> 400, not a 500', async () => {
  reset()
  const fakeZip = Buffer.concat([Buffer.from('PK'), Buffer.from([3, 4]), Buffer.from('garbage, not a real zip')])
  const res = fakeRes()
  await handleImport(fakeReq({ name: 'export.zip', data: fakeZip.toString('base64') }), res)
  assert.equal(res.statusCode, 400)
  assert.match(res.body.error, /could not read that zip/i)
})

test('a well-formed ZIP containing saved_posts.json imports correctly', async () => {
  reset()
  const payload = savedPostsPayload([post('natgeo', 'AAA111')])
  const zip = makeZip([{ name: 'your_instagram_activity/saved/saved_posts.json', data: Buffer.from(JSON.stringify(payload)) }])
  const res = fakeRes()
  await handleImport(fakeReq({ name: 'export.zip', data: zip.toString('base64') }), res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.imported, 1)
})

test('warnings from a partial parse are surfaced, not swallowed into a clean success', async () => {
  reset()
  // A row whose href is present but not http(s)-shaped never becomes an
  // "item" (see parseSavedPosts) — but a file that parses fine yet yields
  // nothing recognizable at all should warn, not silently report 0 imported
  // with no explanation.
  const payload = { saved_saved_media: [{ title: 'x', string_map_data: {} }] }
  const res = fakeRes()
  await handleImport(fakeReq({ name: 'saved_posts.json', data: b64(payload) }), res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.imported, 0)
  assert.ok(res.body.warnings.length > 0, 'a no-recognizable-posts file must produce a warning')
})

// A future/misbehaving importer that omits `warnings` (or returns something
// that isn't an array) must not turn into a 500 on the .push() calls below.
test('an importer returning non-array warnings is guarded against, not trusted blindly', async () => {
  reset()
  importerOverride = {
    name: 'fake',
    parse: () => ({ items: [], collections: [], warnings: undefined }),
    deriveNote: (item) => ({ type: 'link', title: 'x', content: item.url, url: item.url, tags: [] }),
  }
  const res = fakeRes()
  await handleImport(fakeReq({ name: 'whatever.json', data: b64({ anything: true }) }), res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.body.warnings, [])
})

test('a failed per-item addNote is counted as failed, not silently dropped or counted as skipped', async () => {
  reset()
  addNoteImpl = async (note) => {
    if (note.url && note.url.includes('BBB222')) throw new Error('simulated add failure')
  }
  const payload = savedPostsPayload([post('natgeo', 'AAA111'), post('chefsteps', 'BBB222')])
  const res = fakeRes()
  await handleImport(fakeReq({ name: 'saved_posts.json', data: b64(payload) }), res)
  assert.equal(res.body.imported, 1)
  assert.equal(res.body.skipped, 0)
  assert.equal(res.body.failed, 1)
  assert.ok(res.body.warnings.some((w) => /1 post/.test(w)))
})

// MUST FIX 3 / MUST FIX F3 (review round): a failed flush must not leave
// in-memory-only notes that make a retry believe they're already imported
// (urlIndex would see them and report "skipped"), silently losing them if
// the process restarts before anything else happens to persist. F3 adds:
// enrich must not have been queued for the rolled-back note either — queued
// -then-rolled-back would classify/embed a note that's not really there,
// burn a throttled Instagram fetch for nothing, and (via autoAdd) leave a
// permanent ghost id in a smart collection.
test('a failed disk flush is rolled back and reported as a hard failure, not a clean/partial success', async () => {
  reset()
  flushImpl = async () => { throw new Error('ENOSPC: no space left on device') }
  const payload = savedPostsPayload([post('natgeo', 'AAA111')])
  const res = fakeRes()
  await handleImport(fakeReq({ name: 'saved_posts.json', data: b64(payload) }), res)

  assert.equal(res.statusCode, 500)
  assert.match(res.body.error, /ENOSPC|disk|could not save/i)
  assert.equal(notes.length, 0, 'the just-added note was rolled back out of memory')
  assert.equal(removeManyCalls.length, 1)
  assert.deepEqual(removeManyCalls[0].length, 1)
  assert.equal(queueEnrichCalls.length, 0, 'no orphaned enrich job for the rolled-back note')

  // A retry, once the underlying problem is gone, must genuinely re-import —
  // not see the rolled-back note via urlIndex and report it as "skipped".
  flushImpl = async () => {}
  const retryRes = fakeRes()
  await handleImport(fakeReq({ name: 'saved_posts.json', data: b64(payload) }), retryRes)
  assert.equal(retryRes.statusCode, 200)
  assert.equal(retryRes.body.imported, 1, 'the retry actually imports it, rather than treating it as already-there')
  assert.equal(retryRes.body.skipped, 0)
  assert.equal(notes.length, 1)
  assert.equal(queueEnrichCalls.length, 1, 'the successful retry DOES queue enrich, once')
})

test('empty/missing data -> 400', async () => {
  reset()
  const res1 = fakeRes()
  await handleImport(fakeReq({ name: 'saved_posts.json' }), res1)
  assert.equal(res1.statusCode, 400)

  const res2 = fakeRes()
  await handleImport(fakeReq({ name: 'saved_posts.json', data: '' }), res2)
  assert.equal(res2.statusCode, 400)
})

test('a literal JSON `null` body -> 400, not an unhandled throw / 500', async () => {
  reset()
  const res = fakeRes()
  await handleImport(fakeReq('null'), res)
  assert.equal(res.statusCode, 400)
})

test('an oversized upload gets a clean 413, not an unhandled throw / 500', async () => {
  reset()
  // Body text itself (not just the decoded file) exceeds BODY_LIMIT.
  const huge = 'x'.repeat(65 * 1024 * 1024)
  const res = fakeRes()
  await handleImport(fakeReq(`{"name":"a.json","data":"${huge}"}`), res)
  assert.equal(res.statusCode, 413)
})

test('concurrent imports: a second request while one is in flight gets 409, not corrupted state', async () => {
  reset()
  const payload = savedPostsPayload([post('natgeo', 'AAA111')])
  const res1 = fakeRes()
  const res2 = fakeRes()

  const p1 = handleImport(fakeReq({ name: 'saved_posts.json', data: b64(payload) }), res1)
  // Synchronous guard check happens before handleImport's first await, so
  // this resolves (with a 409 already written) without needing to wait on p1.
  await handleImport(fakeReq({ name: 'saved_posts.json', data: b64(payload) }), res2)
  assert.equal(res2.statusCode, 409)

  await p1
  assert.equal(res1.statusCode, 200)
  assert.equal(res1.body.imported, 1)
  assert.equal(notes.length, 1, 'the rejected concurrent request could not create a duplicate')

  // The flag must be released afterward — a third, later import must work.
  const res3 = fakeRes()
  await handleImport(fakeReq({ name: 'saved_posts.json', data: b64(payload) }), res3)
  assert.equal(res3.statusCode, 200)
  assert.equal(res3.body.skipped, 1)
})

// --- Multi-file uploads, source tagging, and order-independent collections ---
// An Instagram export hands you saved_posts.json and saved_collections.json as
// two separate files. Before this, /api/import took exactly one upload, so the
// only way to get Spaces was to send the whole ZIP — and a collections file
// imported on its own was rejected outright as "not a recognized export".

function collectionsPayload(rows) {
  return { saved_saved_collections: rows }
}

test('multi-file: posts and collections uploaded as two loose JSON files create Spaces', async () => {
  reset()
  const res = fakeRes()
  await handleImport(fakeReq({
    source: 'instagram',
    files: [
      { name: 'saved_posts.json', data: b64(savedPostsPayload([post('chefsteps', 'DEF456', 1718000000, { path: 'reel' })])) },
      { name: 'saved_collections.json', data: b64(collectionsPayload([{ title: 'Recipes', list: [{ href: 'https://www.instagram.com/reel/DEF456/' }] }])) },
    ],
  }), res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.imported, 1)
  assert.equal(res.body.collections, 1)
  assert.deepEqual(res.body.warnings, [])
  const space = spaces.find((s) => s.name === 'Recipes')
  assert.ok(space, 'a Space named after the IG collection was created')
  assert.deepEqual(space.itemIds, [notes[0].id])
})

test('order-independent: a collections file imported AFTER its posts still fills the Space', async () => {
  reset()
  const first = fakeRes()
  await handleImport(fakeReq({
    source: 'instagram',
    files: [{ name: 'saved_posts.json', data: b64(savedPostsPayload([post('chefsteps', 'DEF456', 1718000000, { path: 'reel' })])) }],
  }), first)
  assert.equal(first.body.imported, 1)
  assert.equal(first.body.collections, 0, 'no collections file yet, so no Spaces')
  const noteId = notes[0].id

  // A separate request, later. The posts are already in the store, so
  // membership has to resolve through the existing-notes url index.
  const second = fakeRes()
  await handleImport(fakeReq({
    source: 'instagram',
    files: [{ name: 'saved_collections.json', data: b64(collectionsPayload([{ title: 'Recipes', list: [{ href: 'https://www.instagram.com/reel/DEF456/' }] }])) }],
  }), second)

  assert.equal(second.statusCode, 200)
  assert.equal(second.body.imported, 0)
  assert.equal(second.body.collections, 1)
  const space = spaces.find((s) => s.name === 'Recipes')
  assert.deepEqual(space.itemIds, [noteId])
})

test('collections-only: members with no saved post are reported, not silently dropped', async () => {
  reset()
  const res = fakeRes()
  await handleImport(fakeReq({
    source: 'instagram',
    files: [{ name: 'saved_collections.json', data: b64(collectionsPayload([
      { title: 'Recipes', list: [{ href: 'https://www.instagram.com/reel/DEF456/' }, { href: 'https://www.instagram.com/p/GHI789/' }] },
    ])) }],
  }), res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.imported, 0)
  assert.equal(res.body.collections, 0, 'nothing resolved, so no Space was touched')
  assert.ok(
    res.body.warnings.some((w) => /2 post\(s\) in these collections aren't saved yet/.test(w)),
    `expected an unresolved-members warning, got ${JSON.stringify(res.body.warnings)}`,
  )
})

test("collections: a post in two collections counts once in the unresolved warning", async () => {
  reset()
  const res = fakeRes()
  await handleImport(fakeReq({
    source: 'instagram',
    files: [{ name: 'saved_collections.json', data: b64(collectionsPayload([
      { title: 'Recipes', list: [{ href: 'https://www.instagram.com/reel/DEF456/' }] },
      { title: 'Favorites', list: [{ href: 'https://www.instagram.com/reel/DEF456/' }] },
    ])) }],
  }), res)
  assert.ok(res.body.warnings.some((w) => /^1 post\(s\)/.test(w)), JSON.stringify(res.body.warnings))
})

test('source tagging: an upload that is not that platform gets a source-specific error', async () => {
  reset()
  const res = fakeRes()
  await handleImport(fakeReq({
    source: 'instagram',
    files: [{ name: 'bookmarks.json', data: b64({ nothing: 'here' }) }],
  }), res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.code, 'import_source_mismatch')
  assert.match(res.body.error, /Instagram/)
  assert.match(res.body.error, /saved_posts\.json/)
})

test('source tagging: an unknown source names the ones that exist', async () => {
  reset()
  const res = fakeRes()
  await handleImport(fakeReq({
    source: 'myspace',
    files: [{ name: 'saved_posts.json', data: b64(savedPostsPayload([post('natgeo', 'AAA111')])) }],
  }), res)
  assert.equal(res.statusCode, 400)
  assert.match(res.body.error, /Unknown import source/)
  assert.match(res.body.error, /instagram/)
})

test('multi-file: two uploads carrying the same path do not overwrite each other', async () => {
  reset()
  const res = fakeRes()
  // Meta splits large exports into parts, each with its own saved_posts.json.
  await handleImport(fakeReq({
    source: 'instagram',
    files: [
      { name: 'saved_posts.json', data: b64(savedPostsPayload([post('natgeo', 'AAA111')])) },
      { name: 'saved_posts.json', data: b64(savedPostsPayload([post('chefsteps', 'BBB222')])) },
    ],
  }), res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.imported, 2, 'both parts were read, not just the last one')
})

test('multi-file: a ZIP and a loose JSON in one request are merged', async () => {
  reset()
  const zip = makeZip([
    { name: 'your_instagram_activity/saved/saved_posts.json', data: Buffer.from(JSON.stringify(savedPostsPayload([post('chefsteps', 'DEF456', 1718000000, { path: 'reel' })]))) },
  ])
  const res = fakeRes()
  await handleImport(fakeReq({
    source: 'instagram',
    files: [
      { name: 'export.zip', data: zip.toString('base64') },
      { name: 'saved_collections.json', data: b64(collectionsPayload([{ title: 'Recipes', list: [{ href: 'https://www.instagram.com/reel/DEF456/' }] }])) },
    ],
  }), res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.imported, 1)
  assert.equal(res.body.collections, 1)
})

test('multi-file: too many files is refused before anything is decoded', async () => {
  reset()
  const res = fakeRes()
  const files = Array.from({ length: 21 }, () => ({ name: 'saved_posts.json', data: b64(savedPostsPayload([])) }))
  await handleImport(fakeReq({ source: 'instagram', files }), res)
  assert.equal(res.statusCode, 400)
  assert.match(res.body.error, /Too many files/)
  assert.equal(notes.length, 0)
})

// --- TikTok ---------------------------------------------------------------

test('tiktok: an export imports as videos, and its three URL forms dedup to one note', async () => {
  reset()
  const exportJson = {
    'Likes and Favorites': {
      'Favorite Videos': { FavoriteVideoList: [{ Date: '2025-08-09 10:20:53', Link: 'https://www.tiktokv.com/share/video/7325881953608158497/' }] },
      'Like List': { ItemFavoriteList: [{ Date: '2025-01-01 00:00:00', Link: 'https://www.tiktokv.com/share/video/999/' }] },
    },
  }
  const res = fakeRes()
  await handleImport(fakeReq({ source: 'tiktok', files: [{ name: 'user_data_tiktok.json', data: b64(exportJson) }] }), res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.importer, 'tiktok')
  assert.equal(res.body.imported, 1, 'the Like List is not imported')
  assert.equal(notes[0].type, 'video')
  assert.deepEqual(notes[0].tags, ['tiktok'])
  assert.equal(notes[0].url, 'https://www.tiktok.com/video/7325881953608158497')

  // The same video saved by hand from the app carries the @handle form. A
  // second import must recognise it as already saved, not store it twice.
  const again = fakeRes()
  await handleImport(fakeReq({
    source: 'tiktok',
    files: [{ name: 'user_data_tiktok.json', data: b64({ 'Likes and Favorites': { 'Favorite Videos': { FavoriteVideoList: [
      { Date: '2025-08-09 10:20:53', Link: 'https://www.tiktok.com/@someone/video/7325881953608158497' },
    ] } } }) }],
  }), again)
  assert.equal(again.body.imported, 0)
  assert.equal(again.body.skipped, 1)
  assert.equal(notes.length, 1)
})

test('tiktok: an Instagram export dropped on the TikTok source is refused by name', async () => {
  reset()
  const res = fakeRes()
  await handleImport(fakeReq({
    source: 'tiktok',
    files: [{ name: 'saved_posts.json', data: b64(savedPostsPayload([post('natgeo', 'AAA111')])) }],
  }), res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.code, 'import_source_mismatch')
  assert.match(res.body.error, /TikTok/)
  assert.equal(notes.length, 0)
})
