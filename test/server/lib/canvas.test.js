// Unit tests for server/lib/canvas.js — validation of a space's canvas doc.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeCanvas } from '../../../server/lib/canvas.js'

const item = (id, extra = {}) => ({ id, type: 'item', itemId: 'note-' + id, x: 1.4, y: 2.6, width: 220, height: 100, ...extra })

test('rejects anything that is not a doc with node and edge arrays', () => {
  assert.equal(sanitizeCanvas(null), null)
  assert.equal(sanitizeCanvas('nope'), null)
  assert.equal(sanitizeCanvas({ nodes: [] }), null)
  assert.equal(sanitizeCanvas({ nodes: {}, edges: [] }), null)
})

test('rejects oversized docs outright', () => {
  const nodes = Array.from({ length: 2001 }, (_, i) => item('n' + i))
  assert.equal(sanitizeCanvas({ nodes, edges: [] }), null)
  assert.equal(sanitizeCanvas({ nodes: [], edges: Array(2001).fill({}) }), null)
})

test('keeps well-formed nodes, rounds coordinates and strips unknown fields', () => {
  const d = sanitizeCanvas({ nodes: [item('a', { junk: true })], edges: [] })
  assert.deepEqual(d, { nodes: [{ id: 'a', type: 'item', itemId: 'note-a', x: 1, y: 3, width: 220, height: 100 }], edges: [] })
})

test('drops malformed nodes: bad type, non-finite numbers, non-positive size, missing payload, dup ids', () => {
  const d = sanitizeCanvas({
    nodes: [
      item('a'),
      item('a'),                                          // duplicate id
      { ...item('b'), type: 'file' },                     // unknown type
      { ...item('c'), x: Infinity },                      // non-finite
      { ...item('d'), width: 0 },                         // non-positive
      { ...item('e'), itemId: undefined },                // item without itemId
      { id: 'f', type: 'text', x: 0, y: 0, width: 10, height: 10 }, // text without text
      { id: 'g', type: 'group', x: 0, y: 0, width: 10, height: 10, label: 42 },
      { id: 'h', type: 'text', text: '', x: 0, y: 0, width: 10, height: 10 }, // empty text is fine
      { id: 'x'.repeat(65), type: 'text', text: '', x: 0, y: 0, width: 10, height: 10 },
    ],
    edges: [],
  })
  assert.deepEqual(d.nodes.map((n) => n.id), ['a', 'g', 'h'])
  assert.equal('label' in d.nodes[1], false)
})

test('truncates long text and labels', () => {
  const d = sanitizeCanvas({
    nodes: [
      { id: 't', type: 'text', text: 'x'.repeat(30000), x: 0, y: 0, width: 10, height: 10 },
      { id: 'g', type: 'group', label: 'y'.repeat(500), x: 0, y: 0, width: 10, height: 10 },
    ],
    edges: [],
  })
  assert.equal(d.nodes[0].text.length, 20000)
  assert.equal(d.nodes[1].label.length, 200)
})

test('keeps edges between surviving nodes with valid sides only; drops dangling and duplicate edges', () => {
  const d = sanitizeCanvas({
    nodes: [item('a'), item('b')],
    edges: [
      { id: 'e1', fromNode: 'a', toNode: 'b', fromSide: 'right', toSide: 'diagonal' },
      { id: 'e1', fromNode: 'b', toNode: 'a' },          // duplicate id
      { id: 'e2', fromNode: 'a', toNode: 'ghost' },      // dangling
      { id: 'e3', fromNode: 'b', toNode: 'a', fromSide: 'top', toSide: 'left' },
      'garbage',
    ],
  })
  assert.deepEqual(d.edges, [
    { id: 'e1', fromNode: 'a', toNode: 'b', fromSide: 'right' },
    { id: 'e3', fromNode: 'b', toNode: 'a', fromSide: 'top', toSide: 'left' },
  ])
})
