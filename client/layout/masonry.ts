// Windowed masonry: pure layout arithmetic for the Everything board.
//
// The board previously used CSS grid row-spans computed by measuring every
// card with getBoundingClientRect on every layout pass. At 1,675 cards that
// was ~20 seconds of blocked main thread to mount the list, and every
// thumbnail that finished loading triggered another full pass.
//
// Here the layout is computed instead of measured: card heights come from a
// cache (measured once each, on mount) with a per-type estimate for cards not
// yet seen, and packing is plain arithmetic. Only the boxes intersecting the
// viewport are handed back to render, so the mounted-card count depends on
// the size of the WINDOW, never on the size of the library.
import type { UIItem, ViewMode } from '../types'

// How far beyond the viewport to keep cards mounted, in px. Generous enough
// that a fast flick doesn't outrun the render, small enough that the DOM stays
// a few dozen cards.
export const OVERSCAN = 800

export interface Box { id: string; col: number; top: number; height: number }

// Mirrors the column rules in styles/foundation/responsive.css. Kept in sync by the
// tests in test/masonry-window.test.ts — this is the one place the CSS
// breakpoints are duplicated, and the layout is wrong if they drift.
export function columnCount(width: number, view: ViewMode): number {
  const base = view === 'grid8' ? 8 : view === 'grid6' ? 6 : 4
  if (width <= 640) return 2               // phone: pinned to two columns
  if (width <= 900) return Math.min(base, view === 'grid8' ? 5 : 4) // tablet: thin the dense grids
  return Math.max(1, base)
}

// Width of one column, clamped. An unmeasured board (width 0, before the
// resize observer has reported) otherwise yields (0 - gap*(cols-1))/cols — a
// negative width, which React drops from the style object entirely, leaving
// every card with no width at all. Seen live: the board sat at width 0 and
// rendered a column of styleless cards.
export function columnWidth(boardWidth: number, cols: number, gap: number): number {
  const n = Math.max(1, cols)
  const w = (boardWidth - gap * (n - 1)) / n
  return Number.isFinite(w) && w > 0 ? w : 0
}

// Shortest-column packing: each item drops into whichever column is currently
// shortest, which is what gives masonry its even bottom edge.
export function packColumns(
  ids: string[],
  cols: number,
  heightOf: (id: string) => number,
  gap: number,
): { boxes: Box[]; total: number } {
  const n = Math.max(1, cols)
  const colH = new Array<number>(n).fill(0)
  const boxes: Box[] = []
  for (const id of ids) {
    let col = 0
    for (let c = 1; c < n; c++) if (colH[c] < colH[col]) col = c
    const height = heightOf(id)
    // The gap goes BEFORE every card except the first in its column, so a
    // column's height is cards + gaps between them and no trailing gap.
    const top = colH[col] === 0 ? 0 : colH[col] + gap
    boxes.push({ id, col, top, height })
    colH[col] = top + height
  }
  return { boxes, total: Math.max(0, ...colH) }
}

// Clamp a recorded scroll position into a board of the given height.
//
// Card heights are estimated until measured, so the packed total CHANGES as
// the user scrolls — observed shrinking from 130,060px to 71,072px on a
// 1,675-card board as real heights replaced the guesses. When the board
// shrinks past the recorded position, windowing against that stale position
// matches no boxes at all and the board renders blank (reproduced: scrollTop
// 70,388, zero cells mounted). Clamping guarantees the window always lands on
// real content, whatever the layout does underneath it.
export function clampScrollTop(scrollTop: number, total: number, viewportH: number): number {
  return Math.max(0, Math.min(scrollTop, total - viewportH))
}

// The window: every box whose vertical extent intersects the viewport padded
// by OVERSCAN on both sides. Linear, and cheap enough to run per scroll frame
// at these list sizes; if a library ever gets large enough for this to show
// up, the boxes are already sorted well enough to binary-search by `top`.
export function visibleBoxes(boxes: Box[], scrollTop: number, viewportH: number): Box[] {
  const top = scrollTop - OVERSCAN
  const bottom = scrollTop + viewportH + OVERSCAN
  return boxes.filter((b) => b.top + b.height >= top && b.top <= bottom)
}

// Height guess for a card we haven't measured yet. Only ever used for cards
// that have never been on screen; once a card mounts, its real measured
// height replaces this in the cache. Rough is fine — being wrong just means
// the scrollbar settles slightly as you scroll into new territory.
export function estimateHeight(item: UIItem): number {
  // Media cards are dominated by the thumbnail; Instagram's are portrait.
  if (item.type === 'image' || item.type === 'video') return 340
  if (item.type === 'link') return item.thumb ? 300 : 150
  if (item.type === 'code') return 220
  const chars = (item.text || item.summary || item.note || '').length
  return Math.min(360, 110 + Math.ceil(chars / 42) * 17)
}

// Measured card heights plus a self-calibrating estimate for cards not yet
// seen.
//
// A static per-type guess carries a systematic bias: measured live, the board
// claimed a total height of 130,060px while the content really ended at
// ~125,024px, leaving ~5,000px of dead space below the last row because every
// unmeasured card was assumed taller than it is. Averaging the cards of the
// same type we HAVE measured removes that bias as the user scrolls, so the
// scrollbar converges on the truth instead of staying wrong.
export class HeightBook {
  private measured = new Map<string, number>()
  private sum = new Map<string, number>()
  private count = new Map<string, number>()

  // Returns whether this was a real change — sub-pixel jitter from a reflow
  // must not trigger a re-pack, or measure → pack → measure loops forever.
  set(id: string, height: number, type = 'link'): boolean {
    const prev = this.measured.get(id)
    if (prev != null && Math.abs(prev - height) <= 1) return false
    if (prev != null) {
      this.sum.set(type, (this.sum.get(type) || 0) - prev)
      this.count.set(type, (this.count.get(type) || 1) - 1)
    }
    this.measured.set(id, height)
    this.sum.set(type, (this.sum.get(type) || 0) + height)
    this.count.set(type, (this.count.get(type) || 0) + 1)
    return true
  }

  get(item: UIItem): number {
    const exact = this.measured.get(item.id)
    if (exact != null) return exact
    const n = this.count.get(item.type) || 0
    if (n > 0) return (this.sum.get(item.type) || 0) / n
    return estimateHeight(item)
  }

  // Global average across every measured card — the height guess for
  // placeholder slots, whose type is unknown until their page loads.
  avg(): number {
    let s = 0
    let c = 0
    for (const [type, n] of this.count) {
      s += this.sum.get(type) || 0
      c += n
    }
    return c > 0 ? s / c : 260
  }
}
