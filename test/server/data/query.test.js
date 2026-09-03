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
// By the date the tile shows (createdAt — when the item was originally saved,
// which an import takes from the export). Before sortNotes there was no sort
// at all: notes came back in insertion order, which put a bulk import's OLDEST
// items at the top of the board.

const dated = (id, createdAt) => ({ id, createdAt })

const A = dated('a', '2024-12-15T00:00:00Z')
const B = dated('b', '2025-08-09T00:00:00Z')
const C = dated('c', '2026-02-11T00:00:00Z')

test('sortNotes: newest first by default', () => {
  assert.deepEqual(sortNotes([A, B, C], 'newest').map((n) => n.id), ['c', 'b', 'a'])
  assert.deepEqual(sortNotes([A, B, C], undefined).map((n) => n.id), ['c', 'b', 'a'])
})

test('sortNotes: oldest first is the exact reverse', () => {
  assert.deepEqual(sortNotes([C, A, B], 'oldest').map((n) => n.id), ['a', 'b', 'c'])
})

test('sortNotes: an unknown sort falls back to newest rather than throwing', () => {
  assert.deepEqual(sortNotes([A, C], 'sideways').map((n) => n.id), ['c', 'a'])
})

test('sortNotes: exact ties keep insertion order, so a just-saved note stays on top', () => {
  // A bulk import gives thousands of rows the same date, and two notes saved in
  // the same second are ordinary. The store hands notes over newest-inserted
  // first, and that is what a tie should preserve — someone who just saved
  // something expects to find it at the top, not wherever its id sorts.
  const same = '2025-01-01T00:00:00Z'
  const notes = [dated('just-saved', same), dated('older', same), dated('oldest', same)]
  assert.deepEqual(sortNotes(notes, 'newest').map((n) => n.id), ['just-saved', 'older', 'oldest'])
  // And oldest-first reverses ties too, rather than leaving them newest-first.
  assert.deepEqual(sortNotes(notes, 'oldest').map((n) => n.id), ['oldest', 'older', 'just-saved'])
})

test('sortNotes: an unparseable date sorts as the epoch rather than throwing', () => {
  const notes = [dated('bad', 'not a date'), dated('good', '2026-01-01T00:00:00Z')]
  assert.deepEqual(sortNotes(notes, 'newest').map((n) => n.id), ['good', 'bad'])
  assert.deepEqual(sortNotes(notes, 'oldest').map((n) => n.id), ['bad', 'good'])
})

test('sortNotes: never reorders the caller array — it belongs to the note store', () => {
  const notes = [C, A, B]
  const before = notes.map((n) => n.id)
  sortNotes(notes, 'oldest')
  assert.deepEqual(notes.map((n) => n.id), before)
})
