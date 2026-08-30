// Regression guard for the item-board layout shared by Everything and Spaces.
//
// `.board` was once a CSS grid of 8px implicit rows, laid out by a `Masonry`
// effect that measured each card and wrote `grid-row-end: span N` onto its
// cell. When the Everything board moved to the computed windowed layout
// (layout/masonry.ts), that effect went away — but CollectionView kept rendering
// its cards as bare `.board` children. With nothing writing the spans, every
// card claimed a single 8px row and the whole space stacked on top of itself:
// 15 cards, all reported at the same `top`, overlapping.
//
// The fix is that there is exactly ONE board layout. These pin it: no view
// hand-rolls a board element, and the stylesheet carries no row-span grid that
// nothing computes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

const read = (p: string) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8')

test('no view hand-rolls a board element — they all go through components/Board', () => {
  for (const f of readdirSync(new URL('../../client/views', import.meta.url))) {
    const src = read('client/views/' + f)
    assert.ok(
      !/className=\{?['"`]board[ '"`]/.test(src),
      `client/views/${f} builds its own .board; use the shared Board component ` +
      `or its cards get no layout at all`,
    )
  }
})

test('the .board rule is not a row-span grid nothing computes', () => {
  const rule = read('client/styles/views/gallery.css').match(/^\.board\{[^}]*\}/m)?.[0]
  assert.ok(rule, '.board rule not found in gallery.css')
  assert.ok(
    !/grid-auto-rows/.test(rule!),
    'grid-auto-rows only works with inline grid-row-end spans, which no code writes',
  )
})
