// swipe.ts — pure gesture-commit rules for the expanded item view's touch
// gestures: swipe down to dismiss, swipe left/right to move to the
// neighbouring item. Mirrors layout/carousel.ts's fixed-distance approach
// rather than a velocity model — simple to reason about, simple to test, and
// consistent with how the carousel deck inside this same view already
// decides a commit.

export const SLOP_PX = 6      // movement below this is still a tap, not a drag
export const DISMISS_PX = 120 // downward drag that commits to closing
export const NAV_PX = 80      // sideways drag that commits to the neighbouring item

export type Axis = 'none' | 'horizontal' | 'vertical'

// Which axis a gesture has committed to, once it clears the slop. Once
// locked, an axis holds for the rest of the gesture — letting it flip
// mid-drag is how an attempt to scroll the sidebar would turn into an
// accidental dismiss or item swap.
export function lockAxis(current: Axis, dx: number, dy: number): Axis {
  if (current !== 'none') return current
  if (Math.abs(dx) < SLOP_PX && Math.abs(dy) < SLOP_PX) return 'none'
  return Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical'
}

// A vertical gesture only ever means "pull down to dismiss" — there is
// nothing further to reveal by dragging up, so it never commits regardless
// of distance.
export function shouldDismiss(dy: number): boolean {
  return dy > DISMISS_PX
}

// -1 = the previous item, 1 = the next, 0 = the drag did not clear the
// commit distance and should spring back to the item already open.
export function navDirection(dx: number): -1 | 0 | 1 {
  if (Math.abs(dx) < NAV_PX) return 0
  return dx < 0 ? 1 : -1
}
