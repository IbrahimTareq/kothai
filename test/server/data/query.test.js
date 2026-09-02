import test from 'node:test'
import assert from 'node:assert/strict'
import { applyFilters, facetsOf, pageOf, sortNotes, sourceKey, matchesQ } from '../../../server/data/query.js'

const N = (o) => ({ id: o.id, type: 'link', tags: [], url: null, content: '', title: '', ...o })
const LIB = [
  N({ id: 'a', type: 'video', url: 'https://www.instagram.com/reel/AAA/', siteDesc: 'Makkah at night' }),
  N({ id: 'b', type: 'video', url: 'https://www.instagram.com/p/BBB/' }),
  N({ id: 'c', type: 'link', url: 'https://github.com/foo/bar', title: 'repo' }),
  N({ id: 'd', type: 'text', content: 'notes about makkah trip' }),
  N({ id: 'e', type: 'link', url: 'https://example.com/x', tags: ['travel'] }),
]

test('sourceKey mirrors the client source predicates', () => {
  assert.equal(sourceKey(LIB[0]), 'reels')
  assert.equal(sourceKey(LIB[1]), 'igposts')
  assert.equal(sourceKey(LIB[2]), 'github')
  assert.equal(sourceKey(LIB[4]), 'web')
  assert.equal(sourceKey(LIB[3]), null)
})

test('matchesQ searches content, titles, descriptions, tags, and host', () => {
  assert.ok(matchesQ(LIB[0], 'makkah'))
  assert.ok(matchesQ(LIB[3], 'MAKKAH'))
  assert.ok(matchesQ(LIB[4], 'travel'))
  assert.ok(matchesQ(LIB[2], 'github.com'))
  assert.ok(!matchesQ(LIB[1], 'makkah'))
})

test('applyFilters narrows by type, source, q, and collection set', () => {
  assert.deepEqual(applyFilters(LIB, { type: 'video' }).map((n) => n.id), ['a', 'b'])
  assert.deepEqual(applyFilters(LIB, { source: 'reels' }).map((n) => n.id), ['a'])
  assert.deepEqual(applyFilters(LIB, { q: 'makkah' }).map((n) => n.id), ['a', 'd'])
  assert.deepEqual(applyFilters(LIB, { collection: new Set(['b', 'e']) }).map((n) => n.id), ['b', 'e'])
  assert.equal(applyFilters(LIB, {}).length, 5, 'no filters returns everything, same order')
})

test('facetsOf counts types and sources', () => {
  const f = facetsOf(LIB)
  assert.deepEqual(f.types, { video: 2, link: 2, text: 1 })
  assert.deepEqual(f.sources, { reels: 1, igposts: 1, github: 1, web: 1 })
})

test('pageOf slices with clamped offset/limit', () => {
  assert.deepEqual(pageOf(LIB, 1, 2).map((n) => n.id), ['b', 'c'])
  assert.deepEqual(pageOf(LIB, 4, 10).map((n) => n.id), ['e'])
  assert.deepEqual(pageOf(LIB, 99, 10), [])
  assert.equal(pageOf(LIB, 0, 9999).length, 5, 'limit capped is fine when list is short')
})

// --- the unavailable filter ------------------------------------------------
// Cuts across type and source rather than being one of them: a dead link can be
// a video or a post from any platform, so it is a state of the note.

test('applyFilters: unavailable narrows to marked notes only', () => {
  const notes = [
    { id: 'a', type: 'video', url: 'https://www.tiktok.com/video/1', unavailable: true },
    { id: 'b', type: 'video', url: 'https://www.tiktok.com/video/2' },
    { id: 'c', type: 'link', url: 'https://www.instagram.com/p/X/', unavailable: true },
  ]
  assert.deepEqual(applyFilters(notes, { unavailable: true }).map((n) => n.id), ['a', 'c'])
  // Omitting it is not "no filter" — the default is to hide the dead ones.
  assert.deepEqual(applyFilters(notes, {}).map((n) => n.id), ['b'])
  assert.deepEqual(applyFilters(notes, { unavailable: 'all' }).map((n) => n.id), ['a', 'b', 'c'])
})

test('applyFilters: unavailable composes with type rather than replacing it', () => {
  const notes = [
    { id: 'a', type: 'video', unavailable: true },
    { id: 'b', type: 'link', unavailable: true },
  ]
  assert.deepEqual(applyFilters(notes, { unavailable: true, type: 'video' }).map((n) => n.id), ['a'])
})

test('facetsOf: counts unavailable alongside types and sources', () => {
  const f = facetsOf([
    { type: 'video', unavailable: true },
    { type: 'video' },
    { type: 'link', unavailable: true },
  ])
  assert.equal(f.unavailable, 2)
  // The dead video is not counted under its type: the type chips describe the
  // default view, which does not include it.
  assert.equal(f.types.video, 1)
  assert.equal(f.types.link, undefined)
})

// --- multi-select facets ----------------------------------------------------
// OR within a facet, AND across them. ANDing within a facet would always be
// empty (nothing is both a video and a note), which is why lists widen.

test('applyFilters: several types widen the set rather than narrowing it to nothing', () => {
  const notes = [{ id: 'a', type: 'video' }, { id: 'b', type: 'link' }, { id: 'c', type: 'text' }]
  assert.deepEqual(applyFilters(notes, { type: 'video,link' }).map((n) => n.id), ['a', 'b'])
  assert.deepEqual(applyFilters(notes, { type: ['video', 'text'] }).map((n) => n.id), ['a', 'c'])
})

test('applyFilters: several sources widen the same way', () => {
  const notes = [
    { id: 'a', url: 'https://www.tiktok.com/video/1' },
    { id: 'b', url: 'https://www.instagram.com/p/X/' },
    { id: 'c', url: 'https://example.com/thing' },
  ]
  const got = applyFilters(notes, { source: 'tiktok,igposts' }).map((n) => n.id)
  assert.ok(got.includes('a'), 'tiktok item kept')
  assert.ok(!got.includes('c'), 'unrelated item dropped')
})

test('applyFilters: facets AND together — type narrows a multi-source selection', () => {
  const notes = [
    { id: 'a', type: 'video', url: 'https://www.tiktok.com/video/1' },
    { id: 'b', type: 'link', url: 'https://www.tiktok.com/video/2' },
  ]
  assert.deepEqual(applyFilters(notes, { source: 'tiktok', type: 'video' }).map((n) => n.id), ['a'])
})

test('applyFilters: unavailable combines with the others instead of replacing them', () => {
  const notes = [
    { id: 'a', type: 'video', url: 'https://www.tiktok.com/video/1', unavailable: true },
    { id: 'b', type: 'video', url: 'https://www.tiktok.com/video/2' },
    { id: 'c', type: 'link', url: 'https://www.tiktok.com/video/3', unavailable: true },
  ]
  assert.deepEqual(applyFilters(notes, { unavailable: true, type: 'video' }).map((n) => n.id), ['a'])
})

test('applyFilters: an empty list is not a filter', () => {
  const notes = [{ id: 'a', type: 'video' }, { id: 'b', type: 'link' }]
  assert.equal(applyFilters(notes, { type: '' }).length, 2)
  assert.equal(applyFilters(notes, { type: [] }).length, 2)
  assert.equal(applyFilters(notes, { type: ',, ,' }).length, 2, 'a list of blanks is still no filter')
})

// --- unavailable is hidden by default ----------------------------------------

test('applyFilters: unavailable notes are out of an ordinary view unless asked for', () => {
  const notes = [
    { id: 'a', type: 'video' },
    { id: 'b', type: 'video', unavailable: true },
  ]
  assert.deepEqual(applyFilters(notes, {}).map((n) => n.id), ['a'], 'hidden by default')
  assert.deepEqual(applyFilters(notes, { type: 'video' }).map((n) => n.id), ['a'], 'and under any other filter')
  assert.deepEqual(applyFilters(notes, { unavailable: 'only' }).map((n) => n.id), ['b'])
  assert.deepEqual(applyFilters(notes, { unavailable: true }).map((n) => n.id), ['b'], 'true still means only')
  assert.deepEqual(applyFilters(notes, { unavailable: 'all' }).map((n) => n.id), ['a', 'b'], 'all skips the filter entirely')
})

test('facetsOf: type/source counts describe the default view, so they exclude the hidden ones', () => {
  // Otherwise a "TikTok 2" chip opens a board of 1 and the gap reads as a bug.
  const f = facetsOf([
    { type: 'video', url: 'https://www.tiktok.com/video/1' },
    { type: 'video', url: 'https://www.tiktok.com/video/2', unavailable: true },
  ])
  assert.equal(f.types.video, 1)
  assert.equal(f.sources.tiktok, 1)
  assert.equal(f.unavailable, 1, 'but the hidden ones are still counted, or the chip could never appear')
})

// --- board ordering ----------------------------------------------------------
// Two dates per note, and they are not the same: createdAt is when it was saved
// originally (an import keeps the export's date), importedAt is when it reached
// this library. Before sortNotes there was no sort at all — notes came back in
// insertion order, which put a bulk import's OLDEST items at the top.

const dated = (id, createdAt, importedAt) => ({ id, createdAt, importedAt })

test('sortNotes: added puts the newest arrival first, whatever it was saved on', () => {
  const notes = [
    dated('old-save-new-import', '2024-01-01T00:00:00Z', '2026-09-02T00:00:00Z'),
    dated('new-save-old-import', '2026-08-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ]
  assert.deepEqual(sortNotes(notes, 'added').map((n) => n.id), ['old-save-new-import', 'new-save-old-import'])
})

test('sortNotes: saved puts the original timeline back', () => {
  const notes = [
    dated('old-save-new-import', '2024-01-01T00:00:00Z', '2026-09-02T00:00:00Z'),
    dated('new-save-old-import', '2026-08-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ]
  assert.deepEqual(sortNotes(notes, 'saved').map((n) => n.id), ['new-save-old-import', 'old-save-new-import'])
})

test('sortNotes: a batch stamped per-row to the millisecond still ties, and falls back to the saved date', () => {
  // Real libraries carry these: the import route used to stamp each row with
  // its own new Date(), so an "arrival" differs by a millisecond across a batch
  // that landed as one event. Compared exactly, the tie-break never fires and
  // the batch keeps its export-file order — which is how December 2024 ended up
  // at the top of a library imported in September 2026.
  const notes = [
    dated('oldest', '2024-12-15T00:00:00Z', '2026-09-02T10:00:00.900Z'),
    dated('newest', '2025-08-09T00:00:00Z', '2026-09-02T10:00:00.100Z'),
    dated('middle', '2025-02-11T00:00:00Z', '2026-09-02T10:00:00.500Z'),
  ]
  assert.deepEqual(sortNotes(notes, 'added').map((n) => n.id), ['newest', 'middle', 'oldest'])
})

test('sortNotes: arrivals a real distance apart are still ordered by arrival', () => {
  // The bucket must not flatten genuinely different arrivals into one.
  const notes = [
    dated('yesterday', '2026-01-01T00:00:00Z', '2026-09-02T10:00:00Z'),
    dated('today', '2020-01-01T00:00:00Z', '2026-09-03T10:00:00Z'),
  ]
  assert.deepEqual(sortNotes(notes, 'added').map((n) => n.id), ['today', 'yesterday'])
})

test('sortNotes: one import batch shares an importedAt, so ties fall back to the saved date', () => {
  // The whole point: without the tie-break a batch keeps the export file's
  // order, which is what put December 2024 at the top of the board.
  const batch = '2026-09-02T00:00:00Z'
  const notes = [
    dated('oldest', '2024-12-15T00:00:00Z', batch),
    dated('newest', '2025-08-09T00:00:00Z', batch),
    dated('middle', '2025-02-11T00:00:00Z', batch),
  ]
  assert.deepEqual(sortNotes(notes, 'added').map((n) => n.id), ['newest', 'middle', 'oldest'])
})

test('sortNotes: a note with no importedAt falls back to its saved date', () => {
  const notes = [
    dated('imported', '2020-01-01T00:00:00Z', '2026-09-02T00:00:00Z'),
    dated('hand-saved', '2026-09-03T00:00:00Z', undefined),
  ]
  assert.deepEqual(sortNotes(notes, 'added').map((n) => n.id), ['hand-saved', 'imported'])
})

test('sortNotes: an unknown or missing sort is the default, and never throws on bad dates', () => {
  const notes = [dated('a', 'not a date', undefined), dated('b', '2026-01-01T00:00:00Z', undefined)]
  assert.deepEqual(sortNotes(notes, 'nonsense').map((n) => n.id), ['b', 'a'])
  assert.deepEqual(sortNotes(notes, undefined).map((n) => n.id), ['b', 'a'])
})

test('sortNotes: never reorders the caller array — it belongs to the note store', () => {
  const notes = [dated('a', '2024-01-01T00:00:00Z'), dated('b', '2026-01-01T00:00:00Z')]
  const before = notes.map((n) => n.id)
  sortNotes(notes, 'saved')
  assert.deepEqual(notes.map((n) => n.id), before)
})
