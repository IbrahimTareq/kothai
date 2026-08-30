// Unit tests for the windowed masonry core in client/layout/masonry.ts.
//
// Progressive reveal alone only DEFERRED the problem: scrolling to the end of
// a 1,675-post library still ended at 42k DOM nodes and the same jank. These
// functions replace measure-every-card-every-pass with pure arithmetic, so the
// number of mounted cards stays constant no matter how large the library is.
import test from 'node:test'
import assert from 'node:assert/strict'
import { columnCount, packColumns, visibleBoxes, columnWidth, clampScrollTop, HeightBook, OVERSCAN } from '../../client/layout/masonry.ts'

// --- columnCount: mirrors the CSS breakpoints in styles/foundation/responsive.css ---

test('columnCount matches the stylesheet at desktop width', () => {
  assert.equal(columnCount(1400, 'grid4'), 4)
  assert.equal(columnCount(1400, 'grid6'), 6)
  assert.equal(columnCount(1400, 'grid8'), 8)
})

test('columnCount thins the densest grids on tablet (<=900px)', () => {
  assert.equal(columnCount(900, 'grid8'), 5)
  assert.equal(columnCount(900, 'grid6'), 4)
  assert.equal(columnCount(900, 'grid4'), 4, 'grid4 is untouched at this breakpoint')
})

test('columnCount pins every grid to two columns on phones (<=640px)', () => {
  for (const v of ['grid4', 'grid6', 'grid8'] as const) assert.equal(columnCount(640, v), 2)
})

test('columnCount never returns less than one column, even at absurd widths', () => {
  assert.ok(columnCount(0, 'grid8') >= 1)
})

// --- packColumns: shortest-column masonry packing, no DOM ---------------

const h = (heights: Record<string, number>) => (id: string) => heights[id] ?? 100

test('packColumns places each item in the shortest column and stacks with the gap', () => {
  const items = ['a', 'b', 'c']
  const { boxes, total } = packColumns(items, 2, h({ a: 100, b: 50, c: 30 }), 10)
  assert.deepEqual(boxes.map((b) => [b.id, b.col, b.top]), [
    ['a', 0, 0],   // both columns empty -> first
    ['b', 1, 0],   // column 1 still empty -> next
    ['c', 1, 60],  // column 1 (50) is shorter than column 0 (100)
  ])
  assert.equal(total, 100, 'total is the tallest column')
})

test('packColumns keeps every item, and total covers the tallest column including gaps', () => {
  const ids = Array.from({ length: 100 }, (_, i) => 'i' + i)
  const { boxes, total } = packColumns(ids, 4, () => 50, 10)
  assert.equal(boxes.length, 100)
  assert.equal(new Set(boxes.map((b) => b.id)).size, 100, 'no item dropped or duplicated')
  // 100 items / 4 columns = 25 per column: 25 cards + 24 gaps
  assert.equal(total, 25 * 50 + 24 * 10)
})

test('packColumns handles an empty list without producing a negative total', () => {
  const { boxes, total } = packColumns([], 4, () => 50, 10)
  assert.deepEqual(boxes, [])
  assert.equal(total, 0)
})

// --- visibleBoxes: the actual windowing --------------------------------

const grid = (n: number) => packColumns(Array.from({ length: n }, (_, i) => 'i' + i), 4, () => 200, 14)

test('visibleBoxes returns only what is near the viewport, not the whole library', () => {
  const { boxes } = grid(4000) // 1000 rows deep
  const vis = visibleBoxes(boxes, 0, 900)
  assert.ok(vis.length > 0, 'something must render')
  assert.ok(vis.length < 100, `expected a small window, got ${vis.length}`)
})

test('visibleBoxes window size stays CONSTANT as the library grows — the whole point', () => {
  const small = visibleBoxes(grid(400).boxes, 5000, 900).length
  const huge = visibleBoxes(grid(40000).boxes, 5000, 900).length
  assert.equal(small, huge, 'a 100x larger library must not mount more cards')
})

test('visibleBoxes includes an overscan margin so scrolling never reveals empty space', () => {
  const { boxes } = grid(4000)
  const vis = visibleBoxes(boxes, 5000, 900)
  const tops = vis.map((b) => b.top)
  assert.ok(Math.min(...tops) <= 5000 - OVERSCAN + 200, 'must reach above the viewport')
  assert.ok(Math.max(...tops) >= 5000 + 900, 'must reach below the viewport')
})

test('visibleBoxes at the very top and very bottom still returns cards', () => {
  const { boxes, total } = grid(4000)
  assert.ok(visibleBoxes(boxes, 0, 900).length > 0)
  assert.ok(visibleBoxes(boxes, total - 900, 900).length > 0)
})

test('visibleBoxes excludes a card that is far above the scroll position', () => {
  const { boxes } = grid(4000)
  const vis = visibleBoxes(boxes, 20000, 900)
  assert.ok(!vis.some((b) => b.top + b.height < 20000 - OVERSCAN), 'nothing far above may be mounted')
})

// --- columnWidth: never hand the DOM a negative width -------------------
// A board whose width has not been measured yet (0) produced
// (0 - gap*(cols-1)) / cols — a NEGATIVE width, which React drops silently,
// leaving every card styleless and invisible. Observed live: the resize
// observer had not fired yet, so the board sat at width 0 with cards that
// rendered no width attribute at all.

test('columnWidth splits the board evenly minus the gaps', () => {
  assert.equal(columnWidth(1300, 4, 14), (1300 - 14 * 3) / 4)
  assert.equal(columnWidth(600, 1, 14), 600)
})

test('columnWidth never goes negative or NaN for an unmeasured board', () => {
  for (const w of [0, -50, NaN]) {
    const got = columnWidth(w, 4, 14)
    assert.ok(Number.isFinite(got) && got >= 0, `columnWidth(${w}) returned ${got}`)
  }
})

test('columnWidth is finite even if the gaps alone exceed the board width', () => {
  const got = columnWidth(20, 8, 14)
  assert.ok(Number.isFinite(got) && got >= 0)
})

// --- HeightBook: self-calibrating estimates -----------------------------
// Static per-type guesses carry a systematic error. Measured live: the board
// reported a total height of 130,060px while content actually ended at
// ~125,024px, leaving ~5,000px of dead space under the last row because every
// unmeasured card was assumed taller than it really is. Averaging the cards
// we HAVE measured, per type, removes that bias as you scroll.
const link = (id: string) => ({ id, type: 'link', tags: [], pending: false, ts: 1 }) as never

test('HeightBook falls back to the static estimate before anything is measured', () => {
  const book = new HeightBook()
  assert.ok(book.get(link('a')) > 0)
})

test('HeightBook returns the exact measured height for a card it has seen', () => {
  const book = new HeightBook()
  book.set('a', 212)
  assert.equal(book.get(link('a')), 212)
})

test('HeightBook estimates an UNSEEN card from the average of measured cards of that type', () => {
  const book = new HeightBook()
  book.set('a', 200, 'link')
  book.set('b', 220, 'link')
  assert.equal(book.get(link('zzz')), 210, 'should use the 210 average, not the static guess')
})

test('HeightBook keeps per-type averages separate', () => {
  const book = new HeightBook()
  book.set('a', 200, 'link')
  book.set('v', 900, 'video')
  assert.equal(book.get(link('unseen')), 200, 'a link must not be estimated from a video')
})

test('HeightBook.set reports whether the value actually changed, so callers can skip a re-pack', () => {
  const book = new HeightBook()
  assert.equal(book.set('a', 200, 'link'), true)
  assert.equal(book.set('a', 200, 'link'), false, 'same height is not a change')
  assert.equal(book.set('a', 200.4, 'link'), false, 'sub-pixel noise is not a change')
  assert.equal(book.set('a', 260, 'link'), true)
})

// --- clampScrollTop: never window past the end of the content -----------
// Estimated heights mean the board's total height CHANGES as cards get
// measured — observed live shrinking from 130,060px to 71,072px while
// scrolling. If the recorded scroll position is left pointing into the space
// the board no longer occupies, the visible window matches nothing and the
// board renders completely empty. Reproduced exactly: scrollTop 70,388 against
// a re-packed board, 0 cells mounted.

test('clampScrollTop leaves a position inside the content alone', () => {
  assert.equal(clampScrollTop(5000, 130000, 744), 5000)
  assert.equal(clampScrollTop(0, 130000, 744), 0)
})

test('clampScrollTop pulls a stale position back inside a board that has shrunk', () => {
  assert.equal(clampScrollTop(120000, 71072, 744), 71072 - 744)
})

test('clampScrollTop never returns a negative position for content shorter than the viewport', () => {
  assert.equal(clampScrollTop(500, 300, 744), 0)
})

test('a non-empty board ALWAYS renders something, at any scroll position', () => {
  const ids = Array.from({ length: 400 }, (_, i) => 'i' + i)
  const { boxes, total } = packColumns(ids, 4, () => 200, 14)
  for (const raw of [0, total / 2, total, total * 3, 999999]) {
    const vis = visibleBoxes(boxes, clampScrollTop(raw, total, 744), 744)
    assert.ok(vis.length > 0, `blank board at scrollTop ${raw}`)
  }
})

test('HeightBook.avg averages across everything measured, with a floor default', () => {
  const hb = new HeightBook()
  assert.equal(hb.avg(), 260, 'no measurements yet — fixed default')
  hb.set('a', 300, 'video')
  hb.set('b', 100, 'note')
  assert.equal(hb.avg(), 200)
})
