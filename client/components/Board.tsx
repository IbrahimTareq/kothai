// Board.tsx — the windowed masonry board shared by the Everything gallery and
// the single-space view. One layout, one implementation: a board rendered any
// other way gets no layout at all (see test/board-layout.test.ts).
import { useLayoutEffect, useRef, useState, useEffect, useMemo } from 'react'
import type { UIItem, ViewMode } from '../types'
import {
  columnCount,
  packColumns,
  visibleBoxes,
  columnWidth,
  clampScrollTop,
  onScreen,
  HeightBook,
  GAP,
} from '../layout/masonry'
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
export function WindowedBoard({
  items,
  view,
  scroller,
  renderItem,
  onWindow,
  ready,
}: {
  items: Slot[]
  view: ViewMode
  scroller: React.RefObject<HTMLDivElement | null>
  renderItem: (item: UIItem) => React.ReactNode
  onWindow?: (first: number, last: number) => void
  /** The query's readiness (data/useNotes.ts). The render where it turns true
   *  swaps in a new result set, which the board animates. */
  ready?: boolean
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
    const read = () => {
      setWidth(board.clientWidth)
      setViewportH(sc.clientHeight)
    }
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

  const byId = useMemo(() => new Map(items.map(i => [i.id, i])), [items])
  const cols = columnCount(width, view)
  const colW = columnWidth(width, cols, GAP)

  const { boxes, total } = useMemo(
    () =>
      packColumns(
        items.map(i => i.id),
        cols,
        id => {
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
      ),
    [items, cols, byId, heightVersion],
  )

  // Before the board has a real width there is no correct layout to show;
  // rendering a guess would only flash mispositioned cards for a frame.
  // Clamped, because `total` shrinks as estimated heights are replaced by
  // measured ones — a scroll position recorded against the taller board would
  // otherwise point past the end of the content and match nothing at all.
  const visible = useMemo(
    () => (colW > 0 ? visibleBoxes(boxes, clampScrollTop(scrollTop, total, viewportH), viewportH) : []),
    [boxes, total, scrollTop, viewportH, colW],
  )

  // A filter change swaps the whole result set in one render (beginQuery in
  // data/pager.ts), which read as a hard cut: every card gone, a new board in
  // its place. Instead, cards in both sets glide from where they sat on
  // screen, new ones fade in, and departing ones fade out where they were.
  // `shown` is the last committed board — the one the swap replaces.
  const shown = useRef({ visible, byId, scrollTop })
  const [swap, setSwap] = useState<{
    from: Map<string, { x: number; y: number }>
    leaving: { id: string; x: number; y: number; slot: UIItem }[]
  } | null>(null)
  const [wasReady, setWasReady] = useState(ready)
  if (ready !== wasReady) {
    setWasReady(ready)
    const was = shown.current
    const from = ready ? onScreen(was.visible, was.scrollTop, viewportH, colW) : new Map()
    if (from.size > 0) {
      const leaving: { id: string; x: number; y: number; slot: UIItem }[] = []
      for (const [id, at] of from) {
        const slot = was.byId.get(id)
        if (!byId.has(id) && slot && !isPlaceholder(slot)) leaving.push({ id, ...at, slot })
      }
      setSwap({ from, leaving })
    }
  }
  useLayoutEffect(() => {
    shown.current = { visible, byId, scrollTop }
  })
  // A new filter's results start at the top. That used to happen by accident:
  // the board emptied to zero height on every chip click, which clamped the
  // scroll to 0. The old results now stay up until the new ones land, so it
  // happens here on purpose, before paint. The origins in `swap.from` are
  // screen positions on that promise — one frame painted at the old offset
  // would show every card displaced by it.
  useLayoutEffect(() => {
    if (!swap) return
    scroller.current?.scrollTo({ top: 0 })
    setScrollTop(0)
    // Only clears the classes and the faded-out leavers; outlasts the
    // longest of the animations (--dur-slow in gallery.css).
    const id = window.setTimeout(() => setSwap(null), 400)
    return () => clearTimeout(id)
  }, [swap, scroller])

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
    if (dirty) setHeightVersion(v => v + 1)
  })

  // Cards grow after mount when their thumbnail loads. Observing only the
  // mounted window keeps this to a few dozen observers instead of 1,675.
  useEffect(() => {
    const ro = new ResizeObserver(entries => {
      let dirty = false
      for (const e of entries) {
        const id = (e.target as HTMLElement).dataset.noteId
        if (!id) continue
        const h = e.contentRect.height
        const slot = byId.get(id)
        if (h && heights.current.set(id, h, slot && !isPlaceholder(slot) ? slot.type : undefined)) dirty = true
      }
      if (dirty) setHeightVersion(v => v + 1)
    })
    for (const el of cellRefs.current.values()) ro.observe(el)
    return () => ro.disconnect()
  }, [visible])

  return (
    <div ref={boardRef} className={`board ${view}`} style={{ height: total }}>
      {swap?.leaving.map(l => (
        // Same key as the card it was, so React keeps that element (and its
        // loaded thumbnail) rather than mounting a copy to fade out.
        <div
          key={l.id}
          className="masonry-cell leave"
          style={{ transform: `translate3d(${l.x}px, ${l.y}px, 0)`, width: colW }}
        >
          {renderItem(l.slot)}
        </div>
      ))}
      {visible.map(b => {
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
        const from = swap?.from.get(b.id)
        return (
          <div
            key={b.id}
            className={`masonry-cell${swap ? (from ? ' glide' : ' enter') : ''}`}
            data-note-id={b.id}
            ref={el => {
              if (el) cellRefs.current.set(b.id, el)
              else cellRefs.current.delete(b.id)
            }}
            style={
              {
                transform: `translate3d(${b.col * (colW + GAP)}px, ${b.top}px, 0)`,
                width: colW,
                '--glide-from': from && `translate3d(${from.x}px, ${from.y}px, 0)`,
              } as React.CSSProperties
            }
          >
            {renderItem(slot)}
          </div>
        )
      })}
    </div>
  )
}
