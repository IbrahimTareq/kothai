// Which edges of a horizontally scrolling strip have content beyond them.
//
// Split out of the component so the off-by-one can be tested: scrollWidth and
// clientWidth are integers, but scrollLeft is fractional under browser zoom
// and during momentum scrolling, so a strip scrolled fully right reports
// something like 1015.5 against a max of 1016. Comparing exactly leaves the
// "more this way" hint showing at the very end of the strip, which is the one
// place it is certainly wrong.
const EPSILON = 1

export interface Edges { left: boolean; right: boolean }

export function scrollEdges(scrollLeft: number, scrollWidth: number, clientWidth: number): Edges {
  const max = scrollWidth - clientWidth
  // Nothing overflows: no hint on either side, whatever scrollLeft claims.
  if (max <= EPSILON) return { left: false, right: false }
  return {
    left: scrollLeft > EPSILON,
    right: scrollLeft < max - EPSILON,
  }
}

// The class the strip carries, so the stylesheet owns what a fade looks like
// and this owns when there is one.
export function edgeClass({ left, right }: Edges): string {
  return (left ? ' fade-l' : '') + (right ? ' fade-r' : '')
}

// Same edges, read along the vertical axis instead — e.g. the expanded item
// view's main panel, which scrolls top-to-bottom rather than side-to-side.
// scrollEdges itself doesn't care which axis its three numbers came from
// (scrollTop/scrollHeight/clientHeight work exactly like scrollLeft/
// scrollWidth/clientWidth), so callers reuse it directly and only need a
// different name for the class it produces: `left` is "more above",
// `right` is "more below".
export function edgeClassY({ left, right }: Edges): string {
  return (left ? ' fade-t' : '') + (right ? ' fade-b' : '')
}
