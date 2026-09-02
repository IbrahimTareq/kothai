// Unit tests for the scroll-edge maths behind the filter bar's fade hints.
import test from 'node:test'
import assert from 'node:assert/strict'
import { scrollEdges, edgeClass, edgeClassY } from '../../client/layout/overflow.ts'

test('a strip that fits gets no hint on either side', () => {
  assert.deepEqual(scrollEdges(0, 347, 347), { left: false, right: false })
  // scrollWidth can round a pixel above clientWidth without anything being cut
  assert.deepEqual(scrollEdges(0, 348, 347), { left: false, right: false })
})

test('an unscrolled overflowing strip points right only', () => {
  assert.deepEqual(scrollEdges(0, 1363, 347), { left: false, right: true })
})

test('a strip scrolled to the middle points both ways', () => {
  assert.deepEqual(scrollEdges(500, 1363, 347), { left: true, right: true })
})

test('a strip scrolled fully right points left only', () => {
  assert.deepEqual(scrollEdges(1016, 1363, 347), { left: true, right: false })
})

// The case the epsilon exists for: momentum scrolling and browser zoom leave
// scrollLeft a fraction short of the maximum, which read as "there is more to
// the right" at the very end of the strip.
test('a fractional scrollLeft at either limit still counts as the limit', () => {
  assert.deepEqual(scrollEdges(1015.5, 1363, 347), { left: true, right: false })
  assert.deepEqual(scrollEdges(0.5, 1363, 347), { left: false, right: true })
})

test('edgeClass maps the edges onto the stylesheet hooks', () => {
  assert.equal(edgeClass({ left: false, right: false }), '')
  assert.equal(edgeClass({ left: false, right: true }), ' fade-r')
  assert.equal(edgeClass({ left: true, right: false }), ' fade-l')
  assert.equal(edgeClass({ left: true, right: true }), ' fade-l fade-r')
})

test('edgeClassY maps the same edges onto the vertical stylesheet hooks', () => {
  assert.equal(edgeClassY({ left: false, right: false }), '')
  assert.equal(edgeClassY({ left: false, right: true }), ' fade-b')
  assert.equal(edgeClassY({ left: true, right: false }), ' fade-t')
  assert.equal(edgeClassY({ left: true, right: true }), ' fade-t fade-b')
})
