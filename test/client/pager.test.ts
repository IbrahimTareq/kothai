import test from 'node:test'
import assert from 'node:assert/strict'
import { NotePager, PAGE, isPlaceholder } from '../../client/data/pager.ts'
import type { UIItem } from '../../client/types.ts'

const item = (id: string, o: Partial<UIItem> = {}): UIItem => ({
  id,
  ts: 0,
  type: 'link',
  tags: [],
  pending: false,
  ...o,
})
const page = (offset: number, n: number, total: number) => ({
  offset,
  total,
  facets: { types: {}, sources: {} },
  pendingTotal: 0,
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
  assert.deepEqual(
    p.slots().map(s => (s as UIItem).id),
    ['new', 'n0', 'n2'],
  )
  p.patchLocal('n2', { tags: ['x'] })
  assert.deepEqual((p.slots()[2] as UIItem).tags, ['x'])
})

test('a facets refresh replaces the chip counts and leaves the slots alone', () => {
  const p = new NotePager()
  p.applyPage({ ...page(0, 2, 2), facets: { types: { link: 2 }, sources: { github: 1 } } })
  const before = p.slots()
  assert.equal(p.applyFacets({ types: { link: 1 }, sources: {} }, p.requestFacets()), true)
  assert.deepEqual(p.facets, { types: { link: 1 }, sources: {} })
  assert.equal(p.slots(), before)
})

test('only the newest facets refresh applies, whichever answer lands last', () => {
  const p = new NotePager()
  p.applyPage(page(0, 2, 2))
  const first = p.requestFacets()
  const second = p.requestFacets()
  assert.equal(p.applyFacets({ types: { link: 1 }, sources: {} }, second), true)
  assert.equal(p.applyFacets({ types: { link: 2 }, sources: {} }, first), false)
  assert.deepEqual(p.facets.types, { link: 1 })
})

test('a page asked for before a facets refresh cannot put back its older counts', () => {
  const p = new NotePager()
  p.applyPage({ ...page(0, 2, 240), facets: { types: { link: 2 }, sources: { github: 1 } } })
  const pageReq = p.requestFacets() // scrolled to page 2 while the delete was in flight
  p.applyFacets({ types: { link: 1 }, sources: {} }, p.requestFacets())
  assert.equal(
    p.applyPage(
      { ...page(PAGE, 2, 240), facets: { types: { link: 2 }, sources: { github: 1 } } },
      p.generation,
      pageReq,
    ),
    true,
  )
  assert.deepEqual(p.facets, { types: { link: 1 }, sources: {} })
  assert.equal((p.slots()[PAGE] as UIItem).id, `n${PAGE}`)
})

test("a facets refresh sent before a query switch is dropped once the new query's page lands", () => {
  const p = new NotePager()
  p.applyPage(page(0, 2, 2))
  const req = p.requestFacets()
  const gen = p.beginQuery()
  p.applyPage({ ...page(0, 1, 1), facets: { types: { video: 1 }, sources: {} } }, gen, p.requestFacets())
  assert.equal(p.applyFacets({ types: { link: 9 }, sources: {} }, req), false)
  assert.deepEqual(p.facets.types, { video: 1 })
})

test("a newer facets refresh survives the new query's first page landing after it", () => {
  const p = new NotePager()
  p.applyPage(page(0, 2, 2))
  const gen = p.beginQuery()
  const pageReq = p.requestFacets()
  p.applyFacets({ types: { video: 3 }, sources: {} }, p.requestFacets()) // a capture, mid-switch
  p.applyPage({ ...page(0, 2, 2), facets: { types: { video: 2 }, sources: {} } }, gen, pageReq)
  assert.deepEqual(p.facets.types, { video: 3 })
})

test('reset clears state for a new query', () => {
  const p = new NotePager()
  p.applyPage(page(0, 3, 3))
  p.reset()
  assert.equal(p.total, 0)
  assert.deepEqual(p.slots(), [])
  assert.deepEqual(p.neededPages(0, 10), [0])
})

const pageOf = (ids: string[], types: Record<string, number>) => ({
  offset: 0,
  total: ids.length,
  facets: { types, sources: {} },
  pendingTotal: 0,
  notes: ids.map(id => item(id)),
})

test('a new query keeps the old results on screen until its first page lands', () => {
  // Emptying on the click unmounted Everything's chip strip (built from
  // facets) and blanked the board for a whole round-trip: the "blink".
  const p = new NotePager()
  p.applyPage(pageOf(['a', 'b', 'c'], { link: 3 }))
  p.beginQuery()
  assert.deepEqual(
    p.slots().map(s => (s as UIItem).id),
    ['a', 'b', 'c'],
  )
  assert.deepEqual(p.facets.types, { link: 3 })
  p.applyPage(pageOf(['v'], { video: 1 }))
  assert.deepEqual(
    p.slots().map(s => (s as UIItem).id),
    ['v'],
  )
  assert.deepEqual(p.facets.types, { video: 1 })
})

test('a page from a superseded query is dropped, not applied over the current one', () => {
  // Two quick chip clicks: the first query's page can land after the second
  // query has started.
  const p = new NotePager()
  const first = p.beginQuery()
  const second = p.beginQuery()
  p.applyPage(pageOf(['old'], {}), first)
  p.applyPage(pageOf(['new'], {}), second)
  p.applyPage(pageOf(['old'], {}), first)
  assert.deepEqual(
    p.slots().map(s => (s as UIItem).id),
    ['new'],
  )
})

test('while a new query is pending, no further pages are requested against the old window', () => {
  // The old query's total and loaded indices would otherwise decide which of
  // the NEW query's pages to fetch.
  const p = new NotePager()
  p.applyPage(page(0, PAGE, PAGE * 3))
  p.beginQuery()
  assert.deepEqual(p.neededPages(PAGE, PAGE * 2), [])
})

test('applyDelta patches known ids, prepends fresh newest, ignores unloaded, removes deleted', () => {
  const p = new NotePager()
  p.applyPage({
    offset: 0,
    total: 3,
    facets: { types: {}, sources: {} },
    pendingTotal: 1,
    notes: [item('n0', { ts: 300 }), item('n1', { ts: 200 }), item('n2', { ts: 100 })],
  })
  p.applyDelta(
    {
      notes: [
        item('n1', { ts: 200, tags: ['enriched'] }), // known → patch in place
        item('brand-new', { ts: 999 }), // newer than newest → prepend
        item('deep-unloaded', { ts: 50 }), // older, not held → ignore
      ],
      deleted: ['n2'],
      pendingTotal: 0,
    },
    {},
  )
  const ids = p.slots().map(s => (s as UIItem).id)
  assert.deepEqual(ids, ['brand-new', 'n0', 'n1'])
  assert.deepEqual((p.slots()[2] as UIItem).tags, ['enriched'])
  assert.equal(p.pendingTotal, 0)
})

test('applyDelta keeps identity for JSON-equal patches and respects the query filter on prepends', () => {
  const p = new NotePager()
  p.applyPage({
    offset: 0,
    total: 1,
    facets: { types: {}, sources: {} },
    pendingTotal: 0,
    notes: [item('n0', { ts: 300 })],
  })
  const held = p.slots()[0]
  p.applyDelta({ notes: [item('n0', { ts: 300 })], deleted: [], pendingTotal: 0 }, {})
  assert.equal(p.slots()[0], held)
  p.applyDelta({ notes: [item('nomatch', { ts: 999, type: 'video' })], deleted: [], pendingTotal: 0 }, { type: 'link' })
  assert.equal(p.total, 1, 'prepend must pass matchesLocal for the active query')
})

test('applyDelta inserts every new note in a batch, even when the batch arrives newest-first', () => {
  const p = new NotePager()
  p.applyPage({
    offset: 0,
    total: 1,
    facets: { types: {}, sources: {} },
    pendingTotal: 0,
    notes: [item('n0', { ts: 100 })],
  })
  // Server's changedSince() returns newly-added notes newest-first (store
  // does unshift() on add), so a batch of 2+ new notes is NOT necessarily
  // in ascending-ts order. Both of these are newer than the n0 (ts 100)
  // that was loaded before the delta and must both survive.
  p.applyDelta(
    {
      notes: [item('newer', { ts: 300 }), item('older-but-still-new', { ts: 200 })],
      deleted: [],
      pendingTotal: 0,
    },
    {},
  )
  const ids = p.slots().map(s => (s as UIItem).id)
  assert.deepEqual(ids, ['newer', 'older-but-still-new', 'n0'])
  assert.equal(p.total, 3)
})

test('applyDelta handles a millisecond ts tie between two new notes in one batch', () => {
  const p = new NotePager()
  p.applyPage({
    offset: 0,
    total: 1,
    facets: { types: {}, sources: {} },
    pendingTotal: 0,
    notes: [item('n0', { ts: 100 })],
  })
  p.applyDelta(
    {
      notes: [item('a', { ts: 200 }), item('b', { ts: 200 })],
      deleted: [],
      pendingTotal: 0,
    },
    {},
  )
  const ids = p.slots().map(s => (s as UIItem).id)
  assert.equal(ids.length, 3)
  assert.ok(ids.includes('a') && ids.includes('b'))
})

test('thumbless reports loaded instagram slots without thumbs in range', () => {
  const p = new NotePager()
  p.applyPage({
    offset: 0,
    total: 4,
    facets: { types: {}, sources: {} },
    pendingTotal: 0,
    notes: [
      item('a', { type: 'video', url: 'https://www.instagram.com/reel/1/' }),
      item('b', { type: 'video', url: 'https://www.instagram.com/reel/2/', thumb: '/uploads/x.jpg' }),
      item('c', { type: 'link', url: 'https://example.com' }),
    ],
  })
  assert.deepEqual(p.thumbless(0, 3), ['a'], 'no thumb + instagram only; placeholder at 3 skipped')
})

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

test('restoreLocal puts an undone delete back in its slot', () => {
  const p = new NotePager()
  p.applyPage(page(0, 3, 3))
  const n1 = p.slots()[1] as UIItem
  p.removeLocal('n1')
  p.restoreLocal(n1, 1)
  assert.equal(p.total, 3)
  assert.deepEqual(
    p.slots().map(s => (s as UIItem).id),
    ['n0', 'n1', 'n2'],
  )
})

// Deleting a link straight after capturing it is the common "wrong link"
// case, and its enrichment lands inside the undo window: the delta brought
// the deleted card back on screen, and an Undo after that showed it twice.
test('a delta does not bring back a note deleted locally', () => {
  const p = new NotePager()
  const fresh = item('fresh', { ts: 100, pending: true })
  p.insertLocal(fresh)
  p.removeLocal('fresh')
  p.applyDelta({ notes: [item('fresh', { ts: 100, title: 'enriched' })], deleted: [], pendingTotal: 0 }, {})
  assert.equal(p.total, 0)
  p.restoreLocal(fresh, 0)
  p.applyDelta({ notes: [item('fresh', { ts: 100, title: 'enriched' })], deleted: [], pendingTotal: 0 }, {})
  assert.deepEqual(
    p.slots().map(s => (s as UIItem).title),
    ['enriched'],
  )
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

const pendingDelta = (pendingTotal: number) => ({ notes: [], deleted: [], pendingTotal })

test('pendingEta: nothing until two minutes and five notes have gone by', () => {
  const p = new NotePager()
  p.applyDelta(pendingDelta(100), {}, 0)
  p.applyDelta(pendingDelta(80), {}, 60_000)
  assert.equal(p.pendingEta(60_000), null, 'one minute is not a rate')

  const q = new NotePager()
  q.applyDelta(pendingDelta(100), {}, 0)
  q.applyDelta(pendingDelta(97), {}, 600_000)
  assert.equal(q.pendingEta(600_000), null, 'three notes is not a rate')
})

test('pendingEta: the count left at the rate it has fallen', () => {
  const p = new NotePager()
  p.applyDelta(pendingDelta(100), {}, 0)
  p.applyDelta(pendingDelta(80), {}, 120_000)
  assert.equal(p.pendingEta(120_000), 480_000, '20 done in 2 min, 80 left → 8 min')
  p.applyDelta(pendingDelta(80), {}, 180_000) // a stall — no further progress
  assert.equal(p.pendingEta(180_000), 720_000, 'a stall stays in the rate: 80 left at 20/2min over 3min')
})

test('pendingEta: notes added mid-run join the drain rather than restart it', () => {
  const p = new NotePager()
  p.applyDelta(pendingDelta(100), {}, 0)
  p.applyDelta(pendingDelta(80), {}, 120_000)
  p.applyDelta(pendingDelta(130), {}, 120_000) // a save or second import adds 50
  assert.equal(p.pendingEta(120_000), 780_000, '20 done in 2 min, 130 left → 13 min')
})

test('pendingEta: a count that drained to zero starts a new window when it rises', () => {
  const p = new NotePager()
  p.applyDelta(pendingDelta(10), {}, 0)
  p.applyDelta(pendingDelta(0), {}, 600_000)
  p.applyDelta(pendingDelta(50), {}, 700_000)
  p.applyDelta(pendingDelta(40), {}, 820_000)
  assert.equal(p.pendingEta(820_000), 480_000, '10 done in 2 min, 40 left → 8 min')
})

test('pendingEta: a query switch does not restart the estimate', () => {
  const p = new NotePager()
  p.applyDelta(pendingDelta(100), {}, 0)
  p.reset()
  p.applyDelta(pendingDelta(80), {}, 120_000)
  assert.equal(p.pendingEta(120_000), 480_000)
})

test('pendingEta: nothing pending, nothing to estimate', () => {
  const p = new NotePager()
  p.applyDelta(pendingDelta(10), {}, 0)
  p.applyDelta(pendingDelta(0), {}, 600_000)
  assert.equal(p.pendingEta(600_000), null)
})

// Server order, n0 newest, with `extra` spliced in at `at`.
const serverList = (n: number, extra: string[] = [], at = 0) => {
  const ids = Array.from({ length: n }, (_, i) => `n${i}`)
  ids.splice(at, 0, ...extra)
  return ids
}
const serverPage = (ids: string[], offset: number) => ({
  offset,
  total: ids.length,
  facets: { types: {}, sources: {} },
  pendingTotal: 0,
  notes: ids.slice(offset, offset + PAGE).map(id => item(id)),
})
const loadedIds = (p: NotePager) => p.slots().flatMap(s => (isPlaceholder(s) ? [] : [s.id]))

test('a note saved elsewhere between two pages does not show the page boundary note twice', () => {
  const p = new NotePager()
  p.applyPage(serverPage(serverList(PAGE * 2), 0))
  // Saved from Telegram while no delta poll was running: every note on the
  // server moves one place down before the second page is asked for.
  const now = serverList(PAGE * 2, ['tg'])
  p.applyPage(serverPage(now, PAGE))
  const ids = loadedIds(p)
  assert.equal(new Set(ids).size, ids.length)
  // The stale copy's page is fetched again, which brings the new note in.
  for (const off of p.neededPages(0, PAGE * 2)) p.applyPage(serverPage(now, off))
  assert.deepEqual(loadedIds(p), now)
})

test('an import landing mid-list does not show a loaded note twice', () => {
  const p = new NotePager()
  p.applyPage(serverPage(serverList(PAGE * 3), 0))
  p.applyPage(serverPage(serverList(PAGE * 3), PAGE))
  // Imported notes carry their original dates, so they land in the middle.
  p.applyPage(serverPage(serverList(PAGE * 3, ['old1', 'old2'], 50), PAGE * 2))
  const ids = loadedIds(p)
  assert.equal(new Set(ids).size, ids.length)
})

test('pages refetched while a delete waits out its Undo show neither a duplicate nor the deleted note', () => {
  const p = new NotePager()
  const server = serverList(PAGE * 3)
  p.applyPage(serverPage(server, 0))
  p.applyPage(serverPage(server, PAGE))
  p.removeLocal('n5') // the server keeps n5 until the Undo lapses
  // Every note after n5 moved up one, leaving the last loaded slot empty, so
  // scrolling there refetches its page — asking the server to leave out what
  // was deleted here.
  for (let pass = 0; pass < 5; pass++) {
    const shown = server.filter(id => !p.excluded().includes(id))
    for (const off of p.neededPages(0, PAGE * 2 - 1)) p.applyPage(serverPage(shown, off))
  }
  const ids = loadedIds(p)
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(ids.includes('n5'), false)
  assert.equal(ids.length, PAGE * 2)
})

test('an idle board still polls, so a note saved from Telegram reaches it', () => {
  const p = new NotePager()
  p.applyPage(serverPage(serverList(3), 0))
  assert.equal(p.pollDelay(0), 4000)
})

test('the poll runs hot for a note just captured, and slows for a big backlog', () => {
  const p = new NotePager()
  p.applyPage({ ...serverPage(serverList(3), 0), pendingTotal: 80 })
  assert.equal(p.pollDelay(0), 15000)
  p.insertLocal(item('fresh', { pending: true }))
  p.watch(['fresh'], 0, 90_000)
  assert.equal(p.pollDelay(0), 1200)
})
