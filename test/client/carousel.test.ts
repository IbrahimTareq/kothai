import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slideAt, nextIndex } from '../../client/layout/carousel.ts'

// The deck's two pure rules: where a slide sits given its distance from the
// active one, and which slide a drag commits to.

test('the active slide is centred, full size and fully opaque', () => {
  const { x, scale, opacity } = slideAt(0)
  assert.equal(x, 0)
  assert.equal(scale, 1)
  assert.equal(opacity, 1)
})

test('neighbours peek out behind, smaller and dimmer the further out they are', () => {
  const one = slideAt(1)
  const two = slideAt(2)
  assert.ok(one.x > 0 && two.x > one.x)
  assert.ok(one.scale < 1 && two.scale < one.scale)
  assert.ok(one.opacity < 1 && two.opacity < one.opacity)
  assert.ok(one.z > two.z)  // nearer slides stack on top
})

test('a slide is mirrored to the other side of the deck', () => {
  assert.equal(slideAt(-1).x, -slideAt(1).x)
  assert.equal(slideAt(-1).scale, slideAt(1).scale)
})

test('slides beyond the peek window are transparent, not just small', () => {
  assert.equal(slideAt(3).opacity, 0)
})

test('placement is continuous, so a half-finished drag renders half-way', () => {
  const half = slideAt(0.5)
  assert.ok(half.x > slideAt(0).x && half.x < slideAt(1).x)
  assert.ok(half.scale < slideAt(0).scale && half.scale > slideAt(1).scale)
})

test('a drag past the threshold advances one slide, in the drag direction', () => {
  assert.equal(nextIndex(0, -100, 3), 1)   // dragged left → next
  assert.equal(nextIndex(1, 100, 3), 0)    // dragged right → previous
})

test('a short drag springs back to the slide it started on', () => {
  assert.equal(nextIndex(1, -20, 3), 1)
  assert.equal(nextIndex(1, 20, 3), 1)
})

test('a drag never runs off either end of the deck', () => {
  assert.equal(nextIndex(0, 100, 3), 0)    // already first
  assert.equal(nextIndex(2, -100, 3), 2)   // already last
})
