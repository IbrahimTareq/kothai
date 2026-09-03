import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flowPack, bounds } from '../../client/layout/canvas.ts'

const box = (id, w = 220, h = 160) => ({ id, type: 'text', text: '', x: 0, y: 0, width: w, height: h })

test('flowPack lays nodes out in rows, wrapping at maxWidth', () => {
  const out = flowPack([box('a'), box('b', 220, 300), box('c')], { maxWidth: 500, gap: 24 })
  assert.deepEqual(out.map((n) => [n.x, n.y]), [[0, 0], [244, 0], [0, 324]]) // row 1 is 300 tall + gap
  assert.deepEqual(out.map((n) => n.id), ['a', 'b', 'c'])                     // order preserved
})

test('flowPack starts at the given origin and never wraps the first node in a row', () => {
  const out = flowPack([box('wide', 2000, 100), box('b')], { originX: 50, originY: 70, maxWidth: 1200 })
  assert.deepEqual([out[0].x, out[0].y], [50, 70])
  assert.deepEqual([out[1].x, out[1].y], [50, 194]) // 70 + 100 + 24
})

test('bounds covers every node and is null for none', () => {
  assert.equal(bounds([]), null)
  const b = bounds([{ ...box('a'), x: 10, y: 20 }, { ...box('b', 100, 50), x: 300, y: -10 }])
  assert.deepEqual(b, { minX: 10, minY: -10, maxX: 400, maxY: 180 })
})
