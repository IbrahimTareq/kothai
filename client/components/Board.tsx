// Board.tsx — the windowed masonry board shared by the Everything gallery and
// the single-space view. One layout, one implementation: a board rendered any
// other way gets no layout at all (see test/board-layout.test.ts).
import { useLayoutEffect, useRef, useState, useEffect, useMemo } from 'react'
import type { UIItem, ViewMode } from '../types'
import { columnCount, packColumns, visibleBoxes, columnWidth, clampScrollTop, HeightBook, GAP } from '../layout/masonry'
import { isPlaceholder } from '../data/pager'
import type { Slot } from '../data/pager'

// Windowed masonry board.
//
// The previous version put every card in the DOM and re-measured all of them
// on each layout pass — 1,675 cards meant 42k DOM nodes and ~20s of blocked
// main thread, and every thumbnail that finished loading kicked off another
// full pass. Here the layout is arithmetic (see layout/masonry.ts): heights come
// from a cache measured once per card, packing is pure, and only the cards
// intersecting the viewport are mounted. The mounted count tracks the
// viewport, not the library, so a 20,000-item board costs the same as a
// 200-item one.
export function WindowedBoard({ items, view, scroller, renderItem, onWindow }: {
  items: Slot[]
  view: ViewMode
  scroller: React.RefObject<HTMLDivElement | null>
  renderItem: (item: UIItem) => React.ReactNode
  onWindow?: (first: number, last: number) => void
}) {
  const boardRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [viewportH, setViewportH] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  // Measured card heights + self-calibrating estimates for cards not yet seen.
  // A ref (not state) because writing to it must not itself re-render —
  // `heightVersion` below is the explicit signal that the layout needs
  // recomputing, and only a real height change bumps it.
  const heights = useRef(new HeightBook())
  const [heightVersion, setHeightVersion] = useState(0)

  // Track the board's width and the scroller's height. Both feed the layout,
  // and both change on window resize / density toggle.
  useLayoutEffect(() => {
    const board = boardRef.current
    const sc = scroller.current
    if (!board || !sc) return
    const read = () => { setWidth(board.clientWidth); setViewportH(sc.clientHeight) }
    read()
    const ro = new ResizeObserver(read)
    ro.observe(board)
    ro.observe(sc)
    return () => ro.disconnect()
  }, [scroller])

  // Follow the scroll position.
  //
  // Deliberately NOT rAF-throttled. Scroll events are already frame-aligned,
  // React batches the resulting state updates, and setScrollTop bails out when
  // the value is unchanged — so a throttle buys nothing here while adding a
  // dependency on requestAnimationFrame firing. That matters: rAF is
  // suspended entirely in background/hidden contexts, and a scroll handler
  // that only commits its update inside a rAF callback stops updating the
  // window at all there.
  useEffect(() => {
    const sc = scroller.current
    if (!sc) return
    const onScroll = () => setScrollTop(sc.scrollTop)
    sc.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => sc.removeEventListener('scroll', onScroll)
  }, [scroller])

  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])
  const cols = columnCount(width, view)
  const colW = columnWidth(width, cols, GAP)

  const { boxes, total } = useMemo(() => packColumns(
    items.map((i) => i.id),
    cols,
    (id) => {
      const slot = byId.get(id)
      if (!slot) return 200
      // placeholder height is unknown until its page loads — the measured
      // global average is a far better guess than any single-type estimate.
      return isPlaceholder(slot) ? heights.current.avg() : heights.current.get(slot)
    },
    GAP,
  // heightVersion is a deliberate dependency: it is how a newly measured card
  // (or a thumbnail finishing its load) re-triggers the pack.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [items, cols, byId, heightVersion])

  // Before the board has a real width there is no correct layout to show;
  // rendering a guess would only flash mispositioned cards for a frame.
  // Clamped, because `total` shrinks as estimated heights are replaced by
  // measured ones — a scroll position recorded against the taller board would
  // otherwise point past the end of the content and match nothing at all.
  const visible = useMemo(
    () => (colW > 0 ? visibleBoxes(boxes, clampScrollTop(scrollTop, total, viewportH), viewportH) : []),
    [boxes, total, scrollTop, viewportH, colW],
  )

  // Report the slot-index range currently covered by the visible window, so
  // the data layer can fetch whatever pages that range touches. Keyed off
  // `visible` + `items` identity, not scrollTop directly — `visible` already
  // debounces to real layout changes.
  const indexOf = useMemo(() => new Map(items.map((s, i) => [s.id, i])), [items])
  useEffect(() => {
    if (!onWindow || visible.length === 0) return
    let first = Infinity
    let last = -Infinity
    for (const b of visible) {
      const i = indexOf.get(b.id)
      if (i === undefined) continue
      if (i < first) first = i
      if (i > last) last = i
    }
    if (last >= 0) onWindow(first, last)
  }, [visible, indexOf, onWindow])

  // Measure whatever is currently mounted and cache it. Only a real change
  // bumps the version — without that threshold, sub-pixel noise from a
  // reflow would loop measure → re-pack → measure forever.
  //
  // This also re-reads the board width and scroller height on every render,
  // rather than trusting the ResizeObserver above to be the only source. The
  // observer's first callback can arrive late (or, in some embedded contexts,
  // never), and a board stuck at width 0 packs the wrong column count and
  // computes a zero column width — cards present in the DOM but invisible.
  // Re-reading here is one cheap layout read and makes the board
  // self-correcting.
  const cellRefs = useRef(new Map<string, HTMLElement>())
  useLayoutEffect(() => {
    const board = boardRef.current
    const sc = scroller.current
    if (board && board.clientWidth !== width) setWidth(board.clientWidth)
    if (sc && sc.clientHeight !== viewportH) setViewportH(sc.clientHeight)
    let dirty = false
    for (const [id, el] of cellRefs.current) {
      const h = el.getBoundingClientRect().height
      if (!h) continue
      const slot = byId.get(id)
      if (heights.current.set(id, h, slot && !isPlaceholder(slot) ? slot.type : undefined)) dirty = true
    }
    if (dirty) setHeightVersion((v) => v + 1)
  })

  // Cards grow after mount when their thumbnail loads. Observing only the
  // mounted window keeps this to a few dozen observers instead of 1,675.
  useEffect(() => {
    const ro = new ResizeObserver((entries) => {
      let dirty = false
      for (const e of entries) {
        const id = (e.target as HTMLElement).dataset.noteId
        if (!id) continue
        const h = e.contentRect.height
        const slot = byId.get(id)
        if (h && heights.current.set(id, h, slot && !isPlaceholder(slot) ? slot.type : undefined)) dirty = true
      }
      if (dirty) setHeightVersion((v) => v + 1)
    })
    for (const el of cellRefs.current.values()) ro.observe(el)
    return () => ro.disconnect()
  }, [visible])

  return (
    <div ref={boardRef} className={'board ' + view} style={{ height: total }}>
      {visible.map((b) => {
        const slot = byId.get(b.id)
        if (!slot) return null
        if (isPlaceholder(slot)) {
          // Not measured, never mounted into cellRefs — its height stays a
          // guess (HeightBook.avg) until the real note replaces this slot.
          return (
            <div
              key={b.id}
              className="masonry-cell"
              style={{ transform: `translate3d(${b.col * (colW + GAP)}px, ${b.top}px, 0)`, width: colW }}
            >
              <div className="card-skeleton" style={{ height: b.height }} />
            </div>
          )
        }
        return (
          <div
            key={b.id}
            className="masonry-cell"
            data-note-id={b.id}
            ref={(el) => {
              if (el) cellRefs.current.set(b.id, el)
              else cellRefs.current.delete(b.id)
            }}
            style={{ transform: `translate3d(${b.col * (colW + GAP)}px, ${b.top}px, 0)`, width: colW }}
          >
            {renderItem(slot)}
          </div>
        )
      })}
    </div>
  )
}
