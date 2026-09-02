// Unit tests for the expanded item view's touch-gesture rules (swipe.ts).
import test from 'node:test'
import assert from 'node:assert/strict'
import { lockAxis, shouldDismiss, navDirection, SLOP_PX, DISMISS_PX, NAV_PX } from '../../client/layout/swipe.ts'

// --- lockAxis --------------------------------------------------------------

test('lockAxis stays "none" below the slop in both dimensions', () => {
  assert.equal(lockAxis('none', 0, 0), 'none')
  assert.equal(lockAxis('none', SLOP_PX - 1, SLOP_PX - 1), 'none')
})

test('lockAxis picks the dominant dimension once past the slop', () => {
  assert.equal(lockAxis('none', 40, 5), 'horizontal')
  assert.equal(lockAxis('none', -40, 5), 'horizontal')
  assert.equal(lockAxis('none', 5, 40), 'vertical')
  assert.equal(lockAxis('none', 5, -40), 'vertical')
})

test('lockAxis holds once locked, whatever the next delta says', () => {
  // a gesture that started vertical and later drifts mostly horizontal must
  // not flip — that is exactly the case that would turn a sidebar scroll
  // into an accidental item swap partway through
  assert.equal(lockAxis('vertical', 200, 5), 'vertical')
  assert.equal(lockAxis('horizontal', 5, 200), 'horizontal')
})

// --- shouldDismiss -----------------------------------------------------

test('shouldDismiss commits past the threshold and not before it', () => {
  assert.equal(shouldDismiss(DISMISS_PX - 1), false)
  assert.equal(shouldDismiss(DISMISS_PX + 1), true)
})

test('shouldDismiss never commits on an upward drag, at any distance', () => {
  // dragging up has nothing to reveal — the sheet is already fully up
  assert.equal(shouldDismiss(-9999), false)
  assert.equal(shouldDismiss(0), false)
})

// --- navDirection --------------------------------------------------------

test('navDirection springs back below the commit distance', () => {
  assert.equal(navDirection(NAV_PX - 1), 0)
  assert.equal(navDirection(-(NAV_PX - 1)), 0)
})

test('navDirection: a leftward drag (content moving left) advances to next', () => {
  assert.equal(navDirection(-(NAV_PX + 1)), 1)
})

test('navDirection: a rightward drag goes back to the previous item', () => {
  assert.equal(navDirection(NAV_PX + 1), -1)
})
