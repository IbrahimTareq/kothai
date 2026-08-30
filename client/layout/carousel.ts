// carousel.ts — the pure geometry behind the swipeable card deck. Kept out of
// the component (and free of JSX) so the placement and commit rules are
// directly testable, the same way masonry.ts and pager.ts are.

export const PEEK = 2        // slides drawn either side of the active one
export const SWIPE_PX = 56   // drag distance that commits to the neighbouring slide
export const SLOP_PX = 6     // movement below this is still a click, not a drag

export interface SlidePos { x: number; scale: number; opacity: number; z: number }

// Placement of one slide, given its signed distance from the active index.
// Continuous in `dist` so a half-finished drag renders half-way between two
// resting states instead of snapping when it crosses the commit threshold.
export function slideAt(dist: number): SlidePos {
  const clamped = Math.max(-PEEK, Math.min(PEEK, dist))
  const far = Math.abs(clamped)
  return {
    x: clamped * 26,
    scale: 1 - far * 0.08,
    opacity: Math.abs(dist) > PEEK + 0.6 ? 0 : 1 - far * 0.34,
    z: 10 - Math.round(far * 2),
  }
}

// Index after a drag of `dx` px from `from`, clamped to the deck — a swipe past
// either end is what the user feels as the deck's edge.
export function nextIndex(from: number, dx: number, count: number): number {
  const step = Math.abs(dx) > SWIPE_PX ? (dx < 0 ? 1 : -1) : 0
  return Math.max(0, Math.min(count - 1, from + step))
}
