import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flowPack, bounds, reconcile, ITEM_W, DEFAULT_H, GAP } from '../../client/layout/canvas.ts'

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

test('reconcile packs every member from the origin on an empty doc', () => {
  const d = reconcile({ nodes: [], edges: [] }, [{ id: 'a' }, { id: 'b' }])
  assert.deepEqual(d.nodes.map((n) => [n.id, n.type, n.x, n.y, n.width, n.height]), [
    ['item:a', 'item', 0, 0, ITEM_W, DEFAULT_H],
    ['item:b', 'item', ITEM_W + GAP, 0, ITEM_W, DEFAULT_H],
  ])
})

test('reconcile drops cards for departed members and edges touching them', () => {
  const doc = {
    nodes: [
      { id: 'item:a', type: 'item', itemId: 'a', x: 0, y: 0, width: 220, height: 100 },
      { id: 'n1', type: 'text', text: 'hi', x: 300, y: 0, width: 220, height: 60 },
    ],
    edges: [{ id: 'e1', fromNode: 'item:a', toNode: 'n1' }],
  }
  const d = reconcile(doc, [])
  assert.deepEqual(d.nodes.map((n) => n.id), ['n1'])
  assert.deepEqual(d.edges, [])
})

test('reconcile places new members in a row below existing content, keeping old positions', () => {
  const doc = {
    nodes: [{ id: 'item:a', type: 'item', itemId: 'a', x: 40, y: 10, width: 220, height: 100 }],
    edges: [],
  }
  const d = reconcile(doc, [{ id: 'a' }, { id: 'b' }])
  const a = d.nodes.find((n) => n.id === 'item:a')
  const b = d.nodes.find((n) => n.id === 'item:b')
  assert.deepEqual([a.x, a.y], [40, 10])
  assert.deepEqual([b.x, b.y], [40, 10 + 100 + GAP])
})
