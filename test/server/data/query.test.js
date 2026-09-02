import test from 'node:test'
import assert from 'node:assert/strict'
import { applyFilters, facetsOf, pageOf, sourceKey, matchesQ } from '../../../server/data/query.js'

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
  assert.equal(applyFilters(notes, {}).length, 3, 'omitting it must not filter anything')
  assert.equal(applyFilters(notes, { unavailable: false }).length, 3)
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
  assert.equal(f.types.video, 2)
})
