// Gallery.tsx — the Everything grid: search box, type/source filter chips,
// column toggle, item board, and capture FAB.
import { useRef, useState, useEffect } from 'react'
import { Icon, CAT } from '../components/icons'
import { ItemCard } from '../components/Cards'
import { WindowedBoard } from '../components/Board'
import type { Collection, UIItem, UIType, ViewMode } from '../types'
import type { Slot } from '../data/pager'
import { scrollEdges, edgeClass } from '../layout/overflow'

interface GalleryViewProps {
  nav: string
  view: ViewMode
  setView: (v: ViewMode) => void
  search: string
  setSearch: (s: string) => void
  searchFocus: boolean
  setSearchFocus: (b: boolean) => void
  deleteItem: (id: string) => void
  slots: Slot[]
  total: number
  ready: boolean
  onWindow: (first: number, last: number) => void
  /** Selected chip keys — types, sources and 'unavailable' mixed together.
   *  Empty means "All". */
  galFilter: string[]
  setGalFilter: (v: string[]) => void
  typeChips: { key: string; label: string; glyph: string; count: number }[]
  sourceChips: { key: string; label: string; dot: string; glyph?: string; count: number }[]
  unavailableCount: number
  onExpand: (item: UIItem) => void
  collections: Collection[]
  addToCollection: (cid: string, itemId: string) => void
  removeFromCollection: (cid: string, itemId: string) => void
}

// virtual "categories" for the top-nav destinations that aren't storable types
const VIEW_CAT: Record<string, { label: string; glyph: string }> = {
  all: { label: 'Everything', glyph: 'all' },
  spaces: { label: 'Spaces', glyph: 'spark' },
}

export function GalleryView({ nav, view, setView, search, setSearch, searchFocus, setSearchFocus, deleteItem, slots, total, ready, onWindow, galFilter, setGalFilter, typeChips, sourceChips, unavailableCount, onExpand, collections, addToCollection, removeFromCollection }: GalleryViewProps) {
  const cat = CAT[nav as UIType] || VIEW_CAT[nav] || { label: nav, glyph: 'all' }

  const scrollRef = useRef<HTMLDivElement>(null)

  // Chips are multi-select: each one toggles, and "All" is simply the empty
  // selection rather than a chip of its own that has to be deselected.
  const on = (key: string) => galFilter.includes(key)
  const toggle = (key: string) =>
    setGalFilter(on(key) ? galFilter.filter((k) => k !== key) : [...galFilter, key])

  // The filter strip scrolls sideways (11 chips against ~350px on a phone),
  // and did so with no sign that it could: the only hint was a chip clipped
  // mid-word at the edge, which reads as a layout bug rather than an
  // invitation. Fade whichever edge still has chips beyond it.
  const filtersRef = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ left: false, right: false })
  const chipCount = typeChips.length + sourceChips.length + (unavailableCount > 0 ? 1 : 0)
  useEffect(() => {
    const el = filtersRef.current
    if (!el) return setEdges({ left: false, right: false })
    const read = () => setEdges(scrollEdges(el.scrollLeft, el.scrollWidth, el.clientWidth))
    read()
    el.addEventListener('scroll', read, { passive: true })
    // Catches the container being resized; a change to the chips themselves
    // comes through chipCount below, since that leaves the container's own
    // box alone.
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => { el.removeEventListener('scroll', read); ro.disconnect() }
  }, [chipCount, nav])

  return (
    <div className="gallery-view">
      <header className="gal-head">
        <div className={'search-box' + (searchFocus ? ' focus' : '')}>
          <Icon name="search" size={16} />
          <input value={search} placeholder="search anything…" onChange={(e) => setSearch(e.target.value)}
            onFocus={() => setSearchFocus(true)} onBlur={() => setSearchFocus(false)} />
        </div>
      </header>

      <div className="gal-controls">
        {nav === 'all' && (typeChips.length > 0 || sourceChips.length > 0 || unavailableCount > 0)
          ? <div className={'gal-filters' + edgeClass(edges)} ref={filtersRef}>
              <button className={'chip filter-chip' + (galFilter.length === 0 ? ' on' : '')}
                onClick={() => setGalFilter([])}>All</button>
              {typeChips.map((c) => (
                <button key={c.key} className={'chip filter-chip' + (on(c.key) ? ' on' : '')}
                  aria-pressed={on(c.key)} onClick={() => toggle(c.key)}>
                  <span className="fc-ico"><Icon name={c.glyph} size={13} /></span>{c.label}<span className="fc-count">{c.count}</span>
                </button>
              ))}
              {sourceChips.length > 0 && <span className="filter-sep" />}
              {sourceChips.map((c) => (
                <button key={c.key} className={'chip filter-chip' + (on(c.key) ? ' on' : '')}
                  aria-pressed={on(c.key)} onClick={() => toggle(c.key)}>
                  {c.glyph ? <span className="fc-ico"><Icon name={c.glyph} size={13} /></span> : <span className="fc-dot" style={{ background: c.dot }} />}
                  {c.label}<span className="fc-count">{c.count}</span>
                </button>
              ))}
              {/* Last, and only once a check has found something: this is a
                  state the library is in, not a kind of thing in it, and an
                  "Unavailable 0" chip would be a filter for an empty set. */}
              {unavailableCount > 0 && <>
                <span className="filter-sep" />
                <button className={'chip filter-chip' + (on('unavailable') ? ' on' : '')}
                  aria-pressed={on('unavailable')}
                  title="Saved links whose content no longer exists"
                  onClick={() => toggle('unavailable')}>
                  <span className="fc-ico"><Icon name="trash" size={13} /></span>Unavailable<span className="fc-count">{unavailableCount}</span>
                </button>
              </>}
            </div>
          : <span className="gal-filters-spacer" />}
        <div className="view-toggle">
          <button className={view === 'grid4' ? 'on' : ''} onClick={() => setView('grid4')} title="4 columns"><Icon name="grid4" size={16} /></button>
          <button className={view === 'grid6' ? 'on' : ''} onClick={() => setView('grid6')} title="6 columns"><Icon name="grid6" size={16} /></button>
          <button className={view === 'grid8' ? 'on' : ''} onClick={() => setView('grid8')} title="8 columns"><Icon name="grid8" size={16} /></button>
        </div>
      </div>

      <div className="gal-scroll" ref={scrollRef}>
        {total === 0 && ready
          ? <div className="empty"><Icon name={cat.glyph} size={40} /><p>{`NO ${cat.label.toUpperCase()} ${search ? 'MATCH FILTER' : 'YET'}`}</p></div>
          : <WindowedBoard items={slots} view={view} scroller={scrollRef} onWindow={onWindow}
              renderItem={(it) => (
                <ItemCard item={it} onDelete={deleteItem} onExpand={onExpand} collections={collections} onAddTo={addToCollection} onRemoveFrom={removeFromCollection} />
              )} />}
      </div>
    </div>
  )
}
