import test from 'node:test'
import assert from 'node:assert/strict'
import { NotePager, PAGE, isPlaceholder, matchesLocal } from '../../client/data/pager.ts'
import type { UIItem } from '../../client/types.ts'

const item = (id: string, o: Partial<UIItem> = {}): UIItem =>
  ({ id, ts: 0, type: 'note', tags: [], pending: false, ...o })
const page = (offset: number, n: number, total: number) => ({
  offset, total, facets: { types: {}, sources: {} }, pendingTotal: 0,
  notes: Array.from({ length: n }, (_, i) => item(`n${offset + i}`)),
})

test('slots covers total; unloaded indices are placeholders', () => {
  const p = new NotePager()
  p.applyPage(page(0, 3, 10))
  const s = p.slots()
  assert.equal(s.length, 10)
  assert.equal((s[0] as UIItem).id, 'n0')
  assert.ok(isPlaceholder(s[5]))
})

test('placeholder objects are stable across calls (render identity)', () => {
  const p = new NotePager()
  p.applyPage(page(0, 1, 4))
  assert.equal(p.slots()[3], p.slots()[3])
})

test('slots() returns the same array when nothing changed', () => {
  const p = new NotePager()
  p.applyPage(page(0, 2, 2))
  assert.equal(p.slots(), p.slots())
})

test('applyPage keeps the existing object for JSON-equal notes', () => {
  const p = new NotePager()
  p.applyPage(page(0, 2, 2))
  const before = p.slots()[0]
  p.applyPage(page(0, 2, 2))
  assert.equal(p.slots()[0], before)
})

test('neededPages returns page-aligned offsets not loaded or inflight', () => {
  const p = new NotePager()
  p.applyPage(page(0, PAGE, PAGE * 3))
  assert.deepEqual(p.neededPages(PAGE - 5, PAGE + 5), [PAGE])
  p.markInflight(PAGE)
  assert.deepEqual(p.neededPages(PAGE - 5, PAGE * 2 + 5), [PAGE * 2])
  assert.deepEqual(p.neededPages(0, 5), [])
})

test('neededPages clamps to total', () => {
  const p = new NotePager()
  p.applyPage(page(0, 10, 10))
  assert.deepEqual(p.neededPages(50, 900), [])
})

test('local insert/remove/patch shift and patch slots', () => {
  const p = new NotePager()
  p.applyPage(page(0, 3, 3))
  p.insertLocal(item('new'))
  assert.equal(p.total, 4)
  assert.equal((p.slots()[0] as UIItem).id, 'new')
  assert.equal((p.slots()[1] as UIItem).id, 'n0')
  p.removeLocal('n1')
  assert.equal(p.total, 3)
  assert.deepEqual(p.slots().map((s) => (s as UIItem).id), ['new', 'n0', 'n2'])
  p.patchLocal('n2', { tags: ['x'] })
  assert.deepEqual((p.slots()[2] as UIItem).tags, ['x'])
})

test('reset clears state for a new query', () => {
  const p = new NotePager()
  p.applyPage(page(0, 3, 3))
  p.reset()
  assert.equal(p.total, 0)
  assert.deepEqual(p.slots(), [])
  assert.deepEqual(p.neededPages(0, 10), [0])
})

test('applyDelta patches known ids, prepends fresh newest, ignores unloaded, removes deleted', () => {
  const p = new NotePager()
  p.applyPage({ offset: 0, total: 3, facets: { types: {}, sources: {} }, pendingTotal: 1,
    notes: [item('n0', { ts: 300 }), item('n1', { ts: 200 }), item('n2', { ts: 100 })] })
  p.applyDelta({
    notes: [
      item('n1', { ts: 200, tags: ['enriched'] }),   // known → patch in place
      item('brand-new', { ts: 999 }),                // newer than newest → prepend
      item('deep-unloaded', { ts: 50 }),             // older, not held → ignore
    ],
    deleted: ['n2'],
    pendingTotal: 0,
  }, {})
  const ids = p.slots().map((s) => (s as UIItem).id)
  assert.deepEqual(ids, ['brand-new', 'n0', 'n1'])
  assert.deepEqual((p.slots()[2] as UIItem).tags, ['enriched'])
  assert.equal(p.pendingTotal, 0)
})

test('applyDelta keeps identity for JSON-equal patches and respects the query filter on prepends', () => {
  const p = new NotePager()
  p.applyPage({ offset: 0, total: 1, facets: { types: {}, sources: {} }, pendingTotal: 0,
    notes: [item('n0', { ts: 300 })] })
  const held = p.slots()[0]
  p.applyDelta({ notes: [item('n0', { ts: 300 })], deleted: [], pendingTotal: 0 }, {})
  assert.equal(p.slots()[0], held)
  p.applyDelta({ notes: [item('nomatch', { ts: 999, type: 'video' })], deleted: [], pendingTotal: 0 }, { type: 'text' })
  assert.equal(p.total, 1, 'prepend must pass matchesLocal for the active query')
})

test('applyDelta inserts every new note in a batch, even when the batch arrives newest-first', () => {
  const p = new NotePager()
  p.applyPage({ offset: 0, total: 1, facets: { types: {}, sources: {} }, pendingTotal: 0,
    notes: [item('n0', { ts: 100 })] })
  // Server's changedSince() returns newly-added notes newest-first (store
  // does unshift() on add), so a batch of 2+ new notes is NOT necessarily
  // in ascending-ts order. Both of these are newer than the n0 (ts 100)
  // that was loaded before the delta and must both survive.
  p.applyDelta({
    notes: [
      item('newer', { ts: 300 }),
      item('older-but-still-new', { ts: 200 }),
    ],
    deleted: [],
    pendingTotal: 0,
  }, {})
  const ids = p.slots().map((s) => (s as UIItem).id)
  assert.deepEqual(ids, ['newer', 'older-but-still-new', 'n0'])
  assert.equal(p.total, 3)
})

test('applyDelta handles a millisecond ts tie between two new notes in one batch', () => {
  const p = new NotePager()
  p.applyPage({ offset: 0, total: 1, facets: { types: {}, sources: {} }, pendingTotal: 0,
    notes: [item('n0', { ts: 100 })] })
  p.applyDelta({
    notes: [item('a', { ts: 200 }), item('b', { ts: 200 })],
    deleted: [],
    pendingTotal: 0,
  }, {})
  const ids = p.slots().map((s) => (s as UIItem).id)
  assert.equal(ids.length, 3)
  assert.ok(ids.includes('a') && ids.includes('b'))
})

test('thumbless reports loaded instagram slots without thumbs in range', () => {
  const p = new NotePager()
  p.applyPage({ offset: 0, total: 4, facets: { types: {}, sources: {} }, pendingTotal: 0,
    notes: [
      item('a', { type: 'video', url: 'https://www.instagram.com/reel/1/' }),
      item('b', { type: 'video', url: 'https://www.instagram.com/reel/2/', thumb: '/uploads/x.jpg' }),
      item('c', { type: 'link', url: 'https://example.com' }),
    ] })
  assert.deepEqual(p.thumbless(0, 3), ['a'], 'no thumb + instagram only; placeholder at 3 skipped')
})

test('markAwaitingThumb keeps a note counted until it resolves or expires', () => {
  const p = new NotePager()
  p.applyPage(page(0, 1, 1)) // creates note 'n0' with no thumb
  p.markAwaitingThumb(['n0'], 1000, 20000)
  assert.equal(p.awaitingThumbCount(1000), 1)
  assert.equal(p.awaitingThumbCount(19000), 1, 'still within ttl')
  assert.equal(p.awaitingThumbCount(21001), 0, 'expired')
})

test('awaitingThumbCount resolves early once the note actually gets a thumb', () => {
  const p = new NotePager()
  p.applyPage(page(0, 1, 1))
  p.markAwaitingThumb(['n0'], 1000, 20000)
  p.applyPage({ offset: 0, total: 1, facets: { types: {}, sources: {} }, pendingTotal: 0,
    notes: [item('n0', { thumb: '/uploads/x.jpg' })] })
  assert.equal(p.awaitingThumbCount(2000), 0)
})

test('reset() clears any pending thumbnail waits from the previous query', () => {
  const p = new NotePager()
  p.applyPage(page(0, 1, 1))
  p.markAwaitingThumb(['n0'], 1000, 20000)
  p.reset()
  assert.equal(p.awaitingThumbCount(1000), 0)
})

// The delta poll's normal cadence is tuned for background backfill; a note the
// user just captured needs a faster one until it finishes enriching.
test('watch keeps a freshly captured note counted while it is still pending', () => {
  const p = new NotePager()
  p.insertLocal(item('fresh', { pending: true }))
  p.watch(['fresh'], 1000, 90000)
  assert.equal(p.watchingCount(1000), 1)
  assert.equal(p.watchingCount(89000), 1, 'still within ttl')
  assert.equal(p.watchingCount(91001), 0, 'expired')
})

test('watchingCount drops a note as soon as enrichment clears its pending flag', () => {
  const p = new NotePager()
  p.insertLocal(item('fresh', { pending: true }))
  p.watch(['fresh'], 1000, 90000)
  p.applyDelta({ notes: [item('fresh', { pending: false, title: 'enriched' })], deleted: [], pendingTotal: 0 }, {})
  assert.equal(p.watchingCount(2000), 0)
})

test('watchingCount drops a note that left the view', () => {
  const p = new NotePager()
  p.insertLocal(item('fresh', { pending: true }))
  p.watch(['fresh'], 1000, 90000)
  p.removeLocal('fresh')
  assert.equal(p.watchingCount(2000), 0)
})

test('reset() clears watched captures from the previous query', () => {
  const p = new NotePager()
  p.insertLocal(item('fresh', { pending: true }))
  p.watch(['fresh'], 1000, 90000)
  p.reset()
  assert.equal(p.watchingCount(1000), 0)
})

test('matchesLocal mirrors the server filter for optimistic inserts', () => {
  const reel = item('r', { type: 'video', url: 'https://www.instagram.com/reel/A/', host: 'instagram.com' })
  assert.ok(matchesLocal(reel, {}))
  assert.ok(matchesLocal(reel, { type: 'video' }))
  assert.ok(!matchesLocal(reel, { type: 'text' }))
  assert.ok(matchesLocal(reel, { source: 'reels' }))
  assert.ok(!matchesLocal(item('t', { title: 'hello' }), { q: 'xyz' }))
  assert.ok(matchesLocal(item('t', { title: 'hello world' }), { q: 'world' }))
})

// A collection-scoped query can't be mirrored client-side: an item carries no
// record of which collections it belongs to (unlike type/source/q, which are
// derivable from the item itself). Without this, applyDelta would treat any
// vault-wide change as belonging to whatever Space is currently open.
test('matchesLocal never optimistically matches a collection-scoped query', () => {
  const it = item('x', { type: 'video', tags: ['whatever'] })
  assert.ok(!matchesLocal(it, { collection: 'c1' }))
  assert.ok(!matchesLocal(it, { collection: 'c1', type: 'video' })) // even if every other clause matches
})
