// Gallery.tsx — the Everything grid: search box, type/source filter chips,
// column toggle, item board, and capture FAB.
import { useRef } from 'react'
import { Icon, CAT, CATEGORIES } from '../components/icons'
import { SOURCES } from '../domain/source'
import { ItemCard } from '../components/Cards'
import { WindowedBoard } from '../components/Board'
import type { Collection, UIItem, NoteType, ViewMode } from '../types'
import type { Facets, Slot } from '../data/pager'
import { useScrollEdges } from '../layout/useScrollEdges'
import { PageHeader } from '../ui/PageHeader'
import { Chip } from '../ui/Chip'
import { Segmented } from '../ui/Segmented'
import { UnavailableBar } from '../components/UnavailableBar'

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
  galSort: 'newest' | 'oldest'
  setGalSort: (v: 'newest' | 'oldest') => void
  /** Server counts over the search-filtered set, whatever chips are on. */
  facets: Facets
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

export function GalleryView({
  nav,
  view,
  setView,
  search,
  setSearch,
  searchFocus,
  setSearchFocus,
  deleteItem,
  slots,
  total,
  ready,
  onWindow,
  galFilter,
  setGalFilter,
  galSort,
  setGalSort,
  facets,
  onExpand,
  collections,
  addToCollection,
  removeFromCollection,
}: GalleryViewProps) {
  const cat = CAT[nav as NoteType] || VIEW_CAT[nav] || { label: nav, glyph: 'all' }

  const scrollRef = useRef<HTMLDivElement>(null)

  // Chips are multi-select: each one toggles, and "All" is simply the empty
  // selection rather than a chip of its own that has to be deselected.
  const on = (key: string) => galFilter.includes(key)
  const toggle = (key: string) => setGalFilter(on(key) ? galFilter.filter(k => k !== key) : [...galFilter, key])

  // Only types/sources actually present in the (search-filtered) set, with
  // live counts straight from the server. A selected chip stays at 0:
  // deleting the last GitHub note under the GitHub filter otherwise hid the
  // chip and kept the filter, an empty board with nothing lit to say why.
  const shown = (c: { key: string; count: number }) => c.count > 0 || on(c.key)
  const typeChips = CATEGORIES.map(c => ({
    key: c.id as string,
    label: c.label,
    glyph: c.glyph,
    count: facets.types[c.id] || 0,
  })).filter(shown)
  const sourceChips = SOURCES.map(s => ({
    key: s.key,
    label: s.label,
    dot: s.dot,
    glyph: s.glyph,
    count: facets.sources[s.key] || 0,
  })).filter(shown)
  const unavailableCount = facets.unavailable || 0

  // The filter strip scrolls sideways (11 chips against ~350px on a phone),
  // and did so with no sign that it could: the only hint was a chip clipped
  // mid-word at the edge, which reads as a layout bug rather than an
  // invitation. Fade whichever edge still has chips beyond it.
  // A change to the chips themselves comes through chipCount, since that
  // leaves the container's own box alone and so fires no ResizeObserver.
  // Kept while selected even at 0, like the chips above.
  const showUnavailable = unavailableCount > 0 || on('unavailable')
  const chipCount = typeChips.length + sourceChips.length + (showUnavailable ? 1 : 0)
  const { ref: filtersRef, className: filtersFade } = useScrollEdges('x', [chipCount, nav])

  // Sort order and column count are ways of looking at a pile, and below three
  // items there is no pile to look at — an empty board carried a toolbar for
  // nothing. Facets ignore the chips, so with no search their type counts are
  // the whole library. A search skips the check: narrowing to one match would
  // otherwise pull the controls out from under the typing.
  const libraryCount = Object.values(facets.types).reduce((n, c) => n + c, 0)
  const showDisplay = search !== '' || libraryCount >= 3

  return (
    <div className="gallery-view">
      <PageHeader
        title={cat.label}
        // `total > 0` keeps the previous filter's count up while the next one
        // loads, alongside its cards, instead of blanking it for a round-trip.
        meta={ready || total > 0 ? `${total.toLocaleString()} item${total === 1 ? '' : 's'}` : null}
        actions={
          <div className={`search-box${searchFocus ? ' focus' : ''}`}>
            <Icon name="search" size={16} />
            <input
              value={search}
              placeholder="search anything…"
              onChange={e => setSearch(e.target.value)}
              onFocus={() => setSearchFocus(true)}
              onBlur={() => setSearchFocus(false)}
            />
          </div>
        }
        filters={
          nav === 'all' && (typeChips.length > 0 || sourceChips.length > 0 || showUnavailable) ? (
            <div className={`gal-filters${filtersFade}`} ref={filtersRef}>
              <Chip on={galFilter.length === 0} onClick={() => setGalFilter([])}>
                All
              </Chip>
              {typeChips.map(c => (
                <Chip on={on(c.key)} key={c.key} onClick={() => toggle(c.key)}>
                  <span className="fc-ico">
                    <Icon name={c.glyph} size={13} />
                  </span>
                  {c.label}
                  <span className="fc-count">{c.count}</span>
                </Chip>
              ))}
              {sourceChips.length > 0 && <span className="filter-sep" />}
              {sourceChips.map(c => (
                <Chip on={on(c.key)} key={c.key} onClick={() => toggle(c.key)}>
                  {c.glyph ? (
                    <span className="fc-ico">
                      <Icon name={c.glyph} size={13} />
                    </span>
                  ) : (
                    <span className="fc-dot" style={{ background: c.dot }} />
                  )}
                  {c.label}
                  <span className="fc-count">{c.count}</span>
                </Chip>
              ))}
              {/* Last, and only once a check has found something: this is a
                  state the library is in, not a kind of thing in it, and an
                  "Unavailable 0" chip would be a filter for an empty set. */}
              {showUnavailable && (
                <>
                  <span className="filter-sep" />
                  <Chip
                    on={on('unavailable')}
                    title="Saved links whose content is gone — deleted, or no longer public"
                    onClick={() => toggle('unavailable')}
                  >
                    <span className="fc-ico">
                      <Icon name="trash" size={13} />
                    </span>
                    Unavailable<span className="fc-count">{unavailableCount}</span>
                  </Chip>
                </>
              )}
            </div>
          ) : undefined
        }
        display={
          showDisplay && (
            <>
              {/* Sort sits with the density toggle, not with the chips: both answer
            "how is this board presented", where a chip answers "what is on
            it". They share <Segmented> and its height, so the two read
            as one cluster opposite the filters.

            Unlike the density toggle, this stays visible on a phone — which
            column count you get matters less there than what order you are
            reading in. */}
              <Segmented
                label="Sort order"
                value={galSort}
                onChange={setGalSort}
                options={[
                  { value: 'newest', label: 'Newest', title: 'Newest first' },
                  { value: 'oldest', label: 'Oldest', title: 'Oldest first' },
                ]}
              />
              <Segmented
                label="Columns"
                className="view-toggle"
                value={view}
                onChange={setView}
                options={[
                  { value: 'grid4', label: <Icon name="grid4" size={16} />, title: '4 columns' },
                  { value: 'grid6', label: <Icon name="grid6" size={16} />, title: '6 columns' },
                  { value: 'grid8', label: <Icon name="grid8" size={16} />, title: '8 columns' },
                ]}
              />
            </>
          )
        }
      />

      {/* Hidden while a search is typed: the chip counts only matching notes,
          but removal deletes every marked one, so the number on the bar would
          not be the number deleted — the server would refuse it. */}
      {nav === 'all' && on('unavailable') && unavailableCount > 0 && !search && (
        <UnavailableBar
          count={unavailableCount}
          onRemoved={() => setGalFilter(galFilter.filter(k => k !== 'unavailable'))}
        />
      )}

      <div className="gal-scroll" ref={scrollRef}>
        {total === 0 && ready ? (
          <div className="empty">
            {nav === 'all' ? (
              <img src="/empty-2.svg" alt="" width={80} height={80} />
            ) : (
              <Icon name={cat.glyph} size={40} />
            )}
            {search ? <p>{`No ${cat.label.toLowerCase()} match this filter`}</p> : <p>Nothing added yet</p>}
          </div>
        ) : (
          <WindowedBoard
            items={slots}
            view={view}
            scroller={scrollRef}
            onWindow={onWindow}
            ready={ready}
            renderItem={it => (
              <ItemCard
                item={it}
                onDelete={deleteItem}
                onExpand={onExpand}
                collections={collections}
                onAddTo={addToCollection}
                onRemoveFrom={removeFromCollection}
              />
            )}
          />
        )}
      </div>
    </div>
  )
}
