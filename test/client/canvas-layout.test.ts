import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flowPack, bounds, reconcile, columnOf, childrenOf, stackColumn, tidy, toFlow, fromFlow, ITEM_W, DEFAULT_H, GAP, COL_HEAD, COL_PAD, COL_MIN_H } from '../../client/layout/canvas.ts'

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

const col = (id, x, y, w = 260, h = 400) => ({ id, type: 'group', label: id, x, y, width: w, height: h })
const card = (id, x, y, h = 100) => ({ id, type: 'item', itemId: id, x, y, width: 220, height: h })

test('columnOf: a node belongs to the smallest column containing its centre', () => {
  const doc = { nodes: [col('big', 0, 0, 1000, 1000), col('small', 100, 100, 300, 300), card('a', 150, 150), card('b', 700, 700), card('c', 2000, 2000)], edges: [] }
  assert.equal(columnOf(doc, 'a'), 'small')
  assert.equal(columnOf(doc, 'b'), 'big')
  assert.equal(columnOf(doc, 'c'), null)
  assert.equal(columnOf(doc, 'small'), null) // columns never nest
})

test('stackColumn stacks children top to bottom, sets their width and grows the column', () => {
  const doc = { nodes: [col('g', 0, 0, 260, 400), card('late', 20, 300, 80), card('early', 20, 60, 100), card('out', 900, 900)], edges: [] }
  const d = stackColumn(doc, 'g')
  const g = d.nodes.find((n) => n.id === 'g')
  const early = d.nodes.find((n) => n.id === 'early')
  const late = d.nodes.find((n) => n.id === 'late')
  assert.deepEqual([early.x, early.y, early.width], [COL_PAD, COL_HEAD + COL_PAD, 260 - 2 * COL_PAD])
  assert.deepEqual([late.x, late.y], [COL_PAD, COL_HEAD + COL_PAD + 100 + COL_PAD])
  assert.equal(g.height, COL_HEAD + COL_PAD + 100 + COL_PAD + 80 + COL_PAD)
  assert.deepEqual(childrenOf(d, 'g').map((n) => n.id), ['late', 'early'])
  assert.deepEqual([d.nodes.find((n) => n.id === 'out').x], [900]) // untouched
})

test('stackColumn keeps an empty column at its minimum height', () => {
  const d = stackColumn({ nodes: [col('g', 0, 0, 260, 500)], edges: [] }, 'g')
  assert.equal(d.nodes[0].height, COL_MIN_H)
})

test('tidy re-packs top-level nodes in reading order and carries column children along', () => {
  const doc = {
    nodes: [
      card('second', 600, 5),           // same visual row as first, further right
      card('first', 0, 0),
      col('g', 0, 500, 260, 200),
      card('kid', COL_PAD, 500 + COL_HEAD + COL_PAD), // inside g
    ],
    edges: [],
  }
  const d = tidy(doc)
  const at = (id) => { const n = d.nodes.find((x) => x.id === id); return [n.x, n.y] }
  assert.deepEqual(at('first'), [0, 0])
  assert.deepEqual(at('second'), [244, 0])
  assert.deepEqual(at('g'), [488, 0])
  // the child moved by the same delta as its column and is still inside it
  assert.deepEqual(at('kid'), [488 + COL_PAD, COL_HEAD + COL_PAD])
  assert.equal(columnOf(d, 'kid'), 'g')
})

test('toFlow gives column children a parentId and relative position, groups first', () => {
  const doc = {
    nodes: [card('kid', 100 + COL_PAD, 200 + COL_HEAD + COL_PAD), col('g', 100, 200), card('loose', 900, 900)],
    edges: [{ id: 'e1', fromNode: 'kid', toNode: 'loose', fromSide: 'right', toSide: 'left' }],
  }
  const f = toFlow(doc)
  assert.equal(f.nodes[0].id, 'g')
  const kid = f.nodes.find((n) => n.id === 'kid')
  assert.equal(kid.parentId, 'g')
  assert.deepEqual(kid.position, { x: COL_PAD, y: COL_HEAD + COL_PAD })
  assert.equal(kid.width, 220)
  assert.deepEqual(kid.data, { kind: 'item', itemId: 'kid', h: 100 })
  const g = f.nodes.find((n) => n.id === 'g')
  assert.deepEqual([g.width, g.height, g.dragHandle], [260, 400, '.cv-col-head'])
  assert.equal(f.nodes.find((n) => n.id === 'loose').parentId, undefined)
  assert.deepEqual(f.edges, [{ id: 'e1', source: 'kid', target: 'loose', sourceHandle: 'right', targetHandle: 'left' }])
})

test('toFlow keeps selection and measurements from the previous flow nodes', () => {
  const doc = { nodes: [card('a', 0, 0)], edges: [] }
  const prev = [{ id: 'a', type: 'item', position: { x: 0, y: 0 }, data: {}, selected: true, measured: { width: 220, height: 333 } }]
  const f = toFlow(doc, prev)
  assert.equal(f.nodes[0].selected, true)
  assert.deepEqual(f.nodes[0].measured, { width: 220, height: 333 })
})

test('fromFlow restores absolute coordinates, measured heights and edge sides', () => {
  const nodes = [
    { id: 'g', type: 'group', position: { x: 100, y: 200 }, width: 260, height: 400, data: { kind: 'group', label: 'Reads', h: 400 } },
    { id: 'item:a', type: 'item', parentId: 'g', position: { x: 12, y: 48 }, width: 236, data: { kind: 'item', itemId: 'a', h: 100 }, measured: { width: 236, height: 150 } },
    { id: 'n1', type: 'text', position: { x: 900.4, y: 10 }, width: 300, data: { kind: 'text', text: 'note', h: 60 } },
  ]
  const edges = [{ id: 'e1', source: 'item:a', target: 'n1', sourceHandle: 'bottom', targetHandle: null }]
  const d = fromFlow(nodes, edges)
  assert.deepEqual(d.nodes, [
    { id: 'g', type: 'group', label: 'Reads', x: 100, y: 200, width: 260, height: 400 },
    { id: 'item:a', type: 'item', itemId: 'a', x: 112, y: 248, width: 236, height: 150 },
    { id: 'n1', type: 'text', text: 'note', x: 900, y: 10, width: 300, height: 60 },
  ])
  assert.deepEqual(d.edges, [{ id: 'e1', fromNode: 'item:a', toNode: 'n1', fromSide: 'bottom', toSide: undefined }])
})

test('toFlow then fromFlow round-trips a doc with a column', () => {
  const doc = {
    nodes: [col('g', 100, 200), card('kid', 100 + COL_PAD, 200 + COL_HEAD + COL_PAD), card('loose', 900, 900)],
    edges: [{ id: 'e1', fromNode: 'kid', toNode: 'loose' }],
  }
  const f = toFlow(doc)
  const back = fromFlow(f.nodes, f.edges)
  const byId = (d) => Object.fromEntries(d.nodes.map((n) => [n.id, n]))
  assert.deepEqual(byId(back), byId(doc))
  assert.deepEqual(back.edges, [{ id: 'e1', fromNode: 'kid', toNode: 'loose', fromSide: undefined, toSide: undefined }])
})
