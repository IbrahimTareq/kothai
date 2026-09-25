import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  flowPack,
  bounds,
  reconcile,
  frameOf,
  frameAround,
  tidy,
  toFlow,
  fromFlow,
  ITEM_W,
  DEFAULT_H,
  GAP,
  FRAME_HEAD,
  FRAME_PAD,
} from '../../client/layout/canvas.ts'
import type { FlowEdge, FlowNode } from '../../client/layout/canvas.ts'
import type { CanvasDoc } from '../../client/types.ts'

// `.find` over a node list is `T | undefined`; every lookup below is for a node
// the test itself just put there, so a miss is a broken test and should say so
// rather than surface as a confusing property-of-undefined further down.
const need = <T>(n: T | undefined): T => {
  if (n === undefined) throw new Error('expected the node to be present')
  return n
}

// `as const` on every discriminant: without it the literal widens to `string`
// and the object stops satisfying the CanvasNode union.
const box = (id: string, w = 220, h = 160) => ({
  id,
  type: 'text' as const,
  text: '',
  x: 0,
  y: 0,
  width: w,
  height: h,
})

test('flowPack lays nodes out in rows, wrapping at maxWidth', () => {
  const out = flowPack([box('a'), box('b', 220, 300), box('c')], { maxWidth: 500, gap: 24 })
  assert.deepEqual(
    out.map(n => [n.x, n.y]),
    [
      [0, 0],
      [244, 0],
      [0, 324],
    ],
  ) // row 1 is 300 tall + gap
  assert.deepEqual(
    out.map(n => n.id),
    ['a', 'b', 'c'],
  ) // order preserved
})

test('flowPack starts at the given origin and never wraps the first node in a row', () => {
  const out = flowPack([box('wide', 2000, 100), box('b')], { originX: 50, originY: 70, maxWidth: 1200 })
  assert.deepEqual([out[0].x, out[0].y], [50, 70])
  assert.deepEqual([out[1].x, out[1].y], [50, 194]) // 70 + 100 + 24
})

test('bounds covers every node and is null for none', () => {
  assert.equal(bounds([]), null)
  const b = bounds([
    { ...box('a'), x: 10, y: 20 },
    { ...box('b', 100, 50), x: 300, y: -10 },
  ])
  assert.deepEqual(b, { minX: 10, minY: -10, maxX: 400, maxY: 180 })
})

test('reconcile packs every member from the origin on an empty doc', () => {
  const d = reconcile({ nodes: [], edges: [] }, [{ id: 'a' }, { id: 'b' }])
  assert.deepEqual(
    d.nodes.map(n => [n.id, n.type, n.x, n.y, n.width, n.height]),
    [
      ['item:a', 'item', 0, 0, ITEM_W, DEFAULT_H],
      ['item:b', 'item', ITEM_W + GAP, 0, ITEM_W, DEFAULT_H],
    ],
  )
})

test('reconcile drops cards for departed members and edges touching them', () => {
  const doc = {
    nodes: [
      { id: 'item:a', type: 'item' as const, itemId: 'a', x: 0, y: 0, width: 220, height: 100 },
      { id: 'n1', type: 'text' as const, text: 'hi', x: 300, y: 0, width: 220, height: 60 },
    ],
    edges: [{ id: 'e1', fromNode: 'item:a', toNode: 'n1' }],
  }
  const d = reconcile(doc, [])
  assert.deepEqual(
    d.nodes.map(n => n.id),
    ['n1'],
  )
  assert.deepEqual(d.edges, [])
})

test('reconcile places new members in a row below existing content, keeping old positions', () => {
  const doc = {
    nodes: [{ id: 'item:a', type: 'item' as const, itemId: 'a', x: 40, y: 10, width: 220, height: 100 }],
    edges: [],
  }
  const d = reconcile(doc, [{ id: 'a' }, { id: 'b' }])
  const a = need(d.nodes.find(n => n.id === 'item:a'))
  const b = need(d.nodes.find(n => n.id === 'item:b'))
  assert.deepEqual([a.x, a.y], [40, 10])
  assert.deepEqual([b.x, b.y], [40, 10 + 100 + GAP])
})

const frame = (id: string, x: number, y: number, w = 480, h = 320) => ({
  id,
  type: 'group' as const,
  label: id,
  x,
  y,
  width: w,
  height: h,
})
const card = (id: string, x: number, y: number, h = 100) => ({
  id,
  type: 'item' as const,
  itemId: id,
  x,
  y,
  width: 220,
  height: h,
})

test('frameOf: a node belongs to the smallest frame containing its centre', () => {
  const doc = {
    nodes: [
      frame('big', 0, 0, 1000, 1000),
      frame('small', 100, 100, 300, 300),
      card('a', 150, 150),
      card('b', 700, 700),
      card('c', 2000, 2000),
    ],
    edges: [],
  }
  assert.equal(frameOf(doc, 'a'), 'small')
  assert.equal(frameOf(doc, 'b'), 'big')
  assert.equal(frameOf(doc, 'c'), null)
  assert.equal(frameOf(doc, 'small'), null) // frames never nest
})

test('frameAround wraps the selection with padding and room for the title strip', () => {
  const doc = { nodes: [card('a', 100, 200), card('b', 400, 500, 60), card('out', 2000, 2000)], edges: [] }
  assert.deepEqual(frameAround(doc, ['a', 'b']), {
    x: 100 - FRAME_PAD,
    y: 200 - FRAME_PAD - FRAME_HEAD,
    width: 400 + 220 - 100 + 2 * FRAME_PAD,
    height: 500 + 60 - 200 + 2 * FRAME_PAD + FRAME_HEAD,
  })
})

test('frameAround ignores selected frames, and has nothing to wrap without other nodes', () => {
  const doc = { nodes: [frame('f', -500, -500, 2000, 2000), card('a', 0, 0)], edges: [] }
  assert.deepEqual(frameAround(doc, ['f', 'a']), frameAround(doc, ['a']))
  assert.equal(frameAround(doc, ['f']), null)
})

test('tidy re-packs top-level nodes in reading order and carries frame children along', () => {
  const doc = {
    nodes: [
      card('second', 600, 5), // same visual row as first, further right
      card('first', 0, 0),
      frame('g', 0, 500, 480, 320),
      card('kid', 40, 600), // inside g
    ],
    edges: [],
  }
  const d = tidy(doc)
  const at = (id: string) => {
    const n = need(d.nodes.find(x => x.id === id))
    return [n.x, n.y]
  }
  assert.deepEqual(at('first'), [0, 0])
  assert.deepEqual(at('second'), [244, 0])
  assert.deepEqual(at('g'), [488, 0])
  // the child moved by the same delta as its frame and is still inside it
  assert.deepEqual(at('kid'), [488 + 40, 100])
  assert.equal(frameOf(d, 'kid'), 'g')
})

test('toFlow gives frame children a parentId and relative position, frames first', () => {
  const doc = {
    nodes: [card('kid', 130, 260), frame('g', 100, 200), card('loose', 900, 900)],
    edges: [{ id: 'e1', fromNode: 'kid', toNode: 'loose', fromSide: 'right' as const, toSide: 'left' as const }],
  }
  const f = toFlow(doc)
  assert.equal(f.nodes[0].id, 'g')
  const kid = need(f.nodes.find(n => n.id === 'kid'))
  assert.equal(kid.parentId, 'g')
  assert.deepEqual(kid.position, { x: 30, y: 60 })
  assert.equal(kid.width, 220)
  assert.deepEqual(kid.data, { kind: 'item', itemId: 'kid', h: 100 })
  const g = need(f.nodes.find(n => n.id === 'g'))
  assert.deepEqual([g.width, g.height, g.dragHandle], [480, 320, '.cv-frame-head'])
  assert.equal(need(f.nodes.find(n => n.id === 'loose')).parentId, undefined)
  assert.deepEqual(f.edges, [{ id: 'e1', source: 'kid', target: 'loose', sourceHandle: 'right', targetHandle: 'left' }])
})

test('toFlow drops a child from a frame shrunk until its centre is outside', () => {
  const doc = { nodes: [frame('g', 0, 0, 200, 200), card('kid', 150, 150)], edges: [] }
  const kid = need(toFlow(doc).nodes.find(n => n.id === 'kid'))
  assert.equal(kid.parentId, undefined)
  assert.deepEqual(kid.position, { x: 150, y: 150 })
})

test('toFlow keeps selection and measurements from the previous flow nodes', () => {
  const doc = { nodes: [card('a', 0, 0)], edges: [] }
  const prev: FlowNode[] = [
    {
      id: 'a',
      type: 'item',
      position: { x: 0, y: 0 },
      data: { kind: 'item', h: 160 },
      selected: true,
      measured: { width: 220, height: 333 },
    },
  ]
  const f = toFlow(doc, prev)
  assert.equal(f.nodes[0].selected, true)
  assert.deepEqual(f.nodes[0].measured, { width: 220, height: 333 })
})

test('fromFlow restores absolute coordinates, measured heights and edge sides', () => {
  const nodes: FlowNode[] = [
    {
      id: 'g',
      type: 'group',
      position: { x: 100, y: 200 },
      width: 260,
      height: 400,
      data: { kind: 'group', label: 'Reads', h: 400 },
    },
    {
      id: 'item:a',
      type: 'item',
      parentId: 'g',
      position: { x: 12, y: 48 },
      width: 236,
      data: { kind: 'item', itemId: 'a', h: 100 },
      measured: { width: 236, height: 150 },
    },
    { id: 'n1', type: 'text', position: { x: 900.4, y: 10 }, width: 300, data: { kind: 'text', text: 'note', h: 60 } },
  ]
  const edges: FlowEdge[] = [{ id: 'e1', source: 'item:a', target: 'n1', sourceHandle: 'bottom', targetHandle: null }]
  const d = fromFlow(nodes, edges)
  assert.deepEqual(d.nodes, [
    { id: 'g', type: 'group', label: 'Reads', x: 100, y: 200, width: 260, height: 400 },
    { id: 'item:a', type: 'item', itemId: 'a', x: 112, y: 248, width: 236, height: 150 },
    { id: 'n1', type: 'text', text: 'note', x: 900, y: 10, width: 300, height: 60 },
  ])
  assert.deepEqual(d.edges, [{ id: 'e1', fromNode: 'item:a', toNode: 'n1', fromSide: 'bottom', toSide: undefined }])
})

test('toFlow then fromFlow round-trips a doc with a frame', () => {
  const doc = {
    nodes: [frame('g', 100, 200), card('kid', 237, 311), card('loose', 900, 900)],
    edges: [{ id: 'e1', fromNode: 'kid', toNode: 'loose' }],
  }
  const f = toFlow(doc)
  const back = fromFlow(f.nodes, f.edges)
  const byId = (d: CanvasDoc) => Object.fromEntries(d.nodes.map(n => [n.id, n]))
  assert.deepEqual(byId(back), byId(doc))
  assert.deepEqual(back.edges, [{ id: 'e1', fromNode: 'kid', toNode: 'loose', fromSide: undefined, toSide: undefined }])
})
