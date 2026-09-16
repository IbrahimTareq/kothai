// The React half of the scroll-edge fade: overflow.ts owns *when* there is a
// hint, this owns the wiring that notices. It was written out three times —
// the Everything filter bar, a space's rule strip, and the expanded item's
// main panel — as the same ref + state + passive listener + ResizeObserver,
// differing only in axis and in what re-runs it.
//
// It lives beside overflow.ts rather than inside it so that module stays
// React-free and directly unit-testable; the arithmetic it calls is already
// covered by test/client/overflow.test.ts.
import { useEffect, useRef, useState } from 'react'
import { scrollEdges, edgeClass, edgeClassY } from './overflow'

export function useScrollEdges(
  axis: 'x' | 'y',
  deps: unknown[],
  opts: { resetScroll?: boolean } = {},
): { ref: React.RefObject<HTMLDivElement | null>; className: string } {
  const ref = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ left: false, right: false })
  const { resetScroll = false } = opts
  useEffect(() => {
    const el = ref.current
    // No element means no strip on screen, so no hint either — clear rather
    // than leaving the last measurement's class behind.
    if (!el) return setEdges({ left: false, right: false })
    if (resetScroll) el.scrollTop = 0
    const read = () =>
      setEdges(
        axis === 'x'
          ? scrollEdges(el.scrollLeft, el.scrollWidth, el.clientWidth)
          : scrollEdges(el.scrollTop, el.scrollHeight, el.clientHeight),
      )
    read()
    el.addEventListener('scroll', read, { passive: true })
    // Catches the container being resized, and content that changes height
    // after mount without a scroll event of its own — most commonly an image
    // finishing its load and growing the stage taller than it first measured.
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', read)
      ro.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, axis, resetScroll])
  return { ref, className: axis === 'x' ? edgeClass(edges) : edgeClassY(edges) }
}
