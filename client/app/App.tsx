// App.tsx — Kothai shell: capture console, reactor states, gallery, ask thread.
import { useState, useEffect, useRef } from 'react'
import { Icon, CATEGORIES, CAT } from '../components/icons'
import { API } from '../data/api'
import { useNotes } from '../data/useNotes'
import { boardQuery } from '../domain/boardQuery'
import { useCollections } from '../data/useCollections'
import { useVaultStatus } from '../data/useVaultStatus'
import { useChat } from '../data/useChat'
import type { NoteSource } from '../data/useNotes'
import { isPlaceholder } from '../data/pager'
import { ExpandedView } from '../views/Expanded'
import { SettingsView } from '../views/Settings'
import { Onboarding } from '../views/Onboarding'
import { CaptureModal } from '../components/Capture'
import { pathToRoute, routeToPath, chatPath } from './router'
import { SOURCES, SOURCE_BY_KEY, sourceGlyph } from '../domain/source'
import { CoreView } from '../views/Core'
import { GalleryView } from '../views/Gallery'
import { SpacesView, CollectionView } from '../views/Spaces'
import type { UIItem, ViewMode } from '../types'
import { RailButton } from '../components/RailButton'
import { DemoBanner } from '../components/Demo'

// The type ids the board understands, taken from the icon catalogue so the two
// cannot drift. boardQuery takes it as an argument rather than importing
// icons.tsx, which carries JSX and would make that module untestable.
const KNOWN_TYPES = new Set(Object.keys(CAT))

export default function App() {
  const { vault, llmOff, llmWarming, needsSetup, setNeedsSetup } = useVaultStatus()
  const {
    collections,
    createCollection,
    renameCollection,
    saveCanvas,
    editCollectionTags,
    deleteCollection,
    addToCollection,
    removeFromCollection,
  } = useCollections()
  const [expanded, setExpanded] = useState<UIItem | null>(null)
  // id of the item whose Instagram carousel slides are in flight, if any
  const [slidesLoading, setSlidesLoading] = useState<string | null>(null)
  // nav/mode are the two-part app location; seed them from the URL so deep links
  // and refreshes land on the right screen.
  const initialRoute = pathToRoute(typeof location !== 'undefined' ? location.pathname : '/')
  const [nav, setNav] = useState<string>(initialRoute.nav)
  // After nav: useChat reloads the saved-conversation list on entering Ask.
  const chat = useChat(nav)
  const [captureOpen, setCaptureOpen] = useState(false)
  const [view, setView] = useState<ViewMode>('grid4')
  const [search, setSearch] = useState('')
  const [searchFocus, setSearchFocus] = useState(false)
  // Everything-page filters, multi-select. Chip keys are mixed (types, sources
  // and the 'unavailable' state) and split apart below; an empty set is "All".
  const [galFilter, setGalFilter] = useState<string[]>([])
  // Board order: by the date on the tile, newest or oldest first.
  const [galSort, setGalSort] = useState<'newest' | 'oldest'>('newest')
  // Drives the capture button's "Added" state after a successful save.
  const [captured, setCaptured] = useState(false)
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    typeof localStorage !== 'undefined' && localStorage.getItem('kothai-theme') === 'light' ? 'light' : 'dark',
  )
  const coreRef = useRef<HTMLDivElement>(null)
  const beforeSettings = useRef<string>('all') // view to restore when settings toggles off
  const pushedItem = useRef(false) // true while the open item owns a history entry we can pop
  const askedSlides = useRef(new Set<string>()) // ids already checked for carousel slides this session
  const capturedTimer = useRef<number | undefined>(undefined)
  // CollectionView's own useNotes pager, when a Space is open — deleteItem/
  // updateItem below reach into it too, since ExpandedView (an App-level
  // modal) can trigger edits/deletes while a Space is open, and that pager
  // is a separate instance from the Everything board's.
  const spaceNotesRef = useRef<NoteSource | null>(null)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem('kothai-theme', theme)
    } catch {
      /* ignore */
    }
  }, [theme])
  useEffect(() => {
    setGalFilter([])
  }, [nav]) // clear filters when switching pages

  // nav + chips → the server query for the Everything board. The rules (OR
  // within a facet, AND across them; "unavailable" as a state rather than a
  // facet; the note→text rename) live in domain/boardQuery.ts, where they are
  // covered by test/client/board-query.test.ts.
  const { query: boardQ, active: galleryActive } = boardQuery(nav, galFilter, search, galSort, KNOWN_TYPES, k =>
    Boolean(SOURCE_BY_KEY[k]),
  )
  const notes = useNotes(boardQ, galleryActive)
  // Keep the open detail modal in sync with background completions (e.g.
  // Re-tag) that land via the pager's delta poll: ExpandedView reads from
  // this standalone `expanded` snapshot, not live pager data, so without
  // this nothing would ever clear its `pending` state or show the item's
  // fresh tags once the server-side job finishes. Checks both pagers the
  // same way deleteItem/updateItem/retagItem already dual-write to them.
  // The interval (rather than relying solely on the effect's deps) is a
  // safety net for the Space-pager case: CollectionView owns its own
  // useNotes poll and re-renders itself, not App, so App has no other way
  // to notice that pager's update.
  useEffect(() => {
    if (!expanded?.pending) return
    const sync = () => {
      const fresh =
        (notes.slots.find(s => !isPlaceholder(s) && s.id === expanded.id) as UIItem | undefined) ??
        (spaceNotesRef.current?.slots.find(s => !isPlaceholder(s) && s.id === expanded.id) as UIItem | undefined)
      if (fresh && !fresh.pending) setExpanded(fresh)
    }
    sync()
    const id = window.setInterval(sync, 2000)
    return () => clearInterval(id)
  }, [expanded, notes.slots])
  // Carousel slides are fetched the first time an Instagram post is actually
  // opened — never swept in bulk (see queueIgSlides on the server). The single
  // thumbnail keeps showing until they land, so the view never blanks; a post
  // that turns out to be one image comes back unchanged and is never asked
  // about again this session.
  useEffect(() => {
    const it = expanded
    if (!it || it.slides || sourceGlyph(it) !== 'instagram') return
    if (askedSlides.current.has(it.id)) return
    askedSlides.current.add(it.id)
    let stop = false
    // The fetch can run for several seconds on a big sidecar, so the id being
    // waited on is state, not a ref: ExpandedView shows a "Loading slides"
    // affordance over the still-single thumbnail while it is set.
    setSlidesLoading(it.id)
    API.slides(it.id)
      .then(fresh => {
        if (stop || !fresh.slides?.length) return
        notes.patchLocal(fresh.id, { slides: fresh.slides })
        spaceNotesRef.current?.patchLocal(fresh.id, { slides: fresh.slides })
        setExpanded(cur => (cur && cur.id === fresh.id ? { ...cur, slides: fresh.slides } : cur))
      })
      .catch(() => {
        askedSlides.current.delete(it.id)
      })
      .finally(() => setSlidesLoading(cur => (cur === it.id ? null : cur)))
    return () => {
      stop = true
    }
  }, [expanded?.id])

  // Long enough to read the swap and see it settle, short enough that the
  // button is back to "Capture" before anyone reaches for it again.
  const flashCaptured = () => {
    clearTimeout(capturedTimer.current)
    setCaptured(true)
    capturedTimer.current = window.setTimeout(() => setCaptured(false), 1900)
  }
  useEffect(() => () => clearTimeout(capturedTimer.current), [])

  // Store: persist a captured item. Called by the capture modal; resolves to
  // null on success (the modal closes and the button flashes "Added") or to
  // the failure message, which the modal shows inline over the still-filled
  // input — the one place the user can actually retry from.
  const saveCapture = async (raw: string): Promise<string | null> => {
    try {
      const { note } = await API.save({ text: raw })
      notes.insertLocal(note)
      flashCaptured()
      return null
    } catch (e) {
      return (e as Error).message || 'Could not save that.'
    }
  }

  const deleteItem = (id: string) => {
    notes.removeLocal(id)
    spaceNotesRef.current?.removeLocal(id)
    API.del(id).catch(() => {})
  }
  // optimistic tag / mind-note edits from the expanded view; server reconciles
  const updateItem = (id: string, patch: { tags?: string[]; mindNote?: string }) => {
    notes.patchLocal(id, patch)
    spaceNotesRef.current?.patchLocal(id, patch)
    setExpanded(cur => (cur && cur.id === id ? { ...cur, ...patch } : cur))
    API.update(id, patch).catch(() => {})
  }
  // force a fresh classify/embed pass for one item, discarding its current
  // tags; the server flips `pending` immediately so the existing pending-item
  // UI (already used for fresh saves) shows progress with no new loading state
  const retagItem = (id: string) => {
    API.retag(id)
      .then(note => {
        notes.patchLocal(id, note)
        spaceNotesRef.current?.patchLocal(id, note)
        setExpanded(cur => (cur && cur.id === id ? note : cur))
      })
      .catch(() => {})
  }

  // ---- collections (Spaces) ----------------------------------------------
  // Central navigation: update state and push a matching URL so the back/forward
  // buttons and shareable links work.
  const navigate = (next: string) => {
    if (next !== 'settings') beforeSettings.current = next
    setNav(next)
    setExpanded(null)
    const path = routeToPath(next)
    if (location.pathname !== path) history.pushState(null, '', path)
  }

  // Expanding a tile is a location change too: /item/<id> hangs off whatever
  // board it was opened from, so the URL is shareable, a refresh reopens the
  // same item, and Back closes the overlay onto the view underneath.
  const openExpanded = (item: UIItem) => {
    setExpanded(item)
    const path = routeToPath(nav, item.id)
    if (location.pathname === path) return
    // Replace rather than stack when one overlay opens another (canvas → item),
    // so a single Back always returns to the board.
    if (pathToRoute(location.pathname).item) history.replaceState(null, '', path)
    else {
      history.pushState(null, '', path)
      pushedItem.current = true
    }
  }
  // Undo our own pushState when we made one — that fires popstate, which clears
  // `expanded`. A cold deep link has no entry to pop, so rewrite in place
  // instead of sending the user back off the app.
  const closeExpanded = () => {
    if (pushedItem.current) return history.back()
    setExpanded(null)
    const path = routeToPath(nav)
    if (location.pathname !== path) history.replaceState(null, '', path)
  }
  // Resolve an id straight from the server: back/forward into an item and a
  // cold deep link both arrive with no card in hand. A deleted id just drops
  // back to the board underneath.
  const showItemById = (id: string, nextNav: string) => {
    API.note(id)
      .then(setExpanded)
      .catch(() => {
        setExpanded(null)
        history.replaceState(null, '', routeToPath(nextNav))
      })
  }
  // Swipe-navigate between items inside the expanded overlay, on whatever
  // board it was opened from. Only ever steps into an already-loaded
  // neighbour — never fetches, never skips over an unloaded placeholder to
  // find one further out. The windowed board loads a whole page (120 items)
  // at once, so a visible item's immediate neighbour is almost always in the
  // same page and this just works; the rare miss (right at a page boundary)
  // is a no-op, not a wrong answer — skipping ahead to the next LOADED item
  // regardless of distance would silently jump the reader past everything in
  // between, which is worse than the swipe doing nothing.
  const navExpanded = (dir: -1 | 1) => {
    if (!expanded) return
    const slots = nav.startsWith('space:') ? (spaceNotesRef.current?.slots ?? []) : notes.slots
    const idx = slots.findIndex(s => !isPlaceholder(s) && s.id === expanded.id)
    if (idx < 0) return
    const neighbor = slots[idx + dir]
    if (!neighbor || isPlaceholder(neighbor)) return
    setExpanded(neighbor)
    const path = routeToPath(nav, neighbor.id)
    if (location.pathname !== path) history.replaceState(null, '', path)
  }
  // Settings acts as a toggle: opening remembers where we were, closing returns there.
  const toggleSettings = () => {
    navigate(nav === 'settings' ? beforeSettings.current : 'settings')
    setSearch('')
  }
  // Mirror browser back/forward into state, and normalize any odd landing URL.
  useEffect(() => {
    const canonical = initialRoute.chat ? chatPath(initialRoute.chat) : routeToPath(initialRoute.nav, initialRoute.item)
    if (canonical !== location.pathname) history.replaceState(null, '', canonical)
    if (initialRoute.item) showItemById(initialRoute.item, initialRoute.nav)
    // A cold deep link to /ask/<id> arrives with no chat in hand, same as an
    // item deep link does.
    if (initialRoute.chat) chat.showChat(initialRoute.chat)
    const onPop = () => {
      const r = pathToRoute(location.pathname)
      pushedItem.current = false
      setNav(r.nav)
      if (r.item) showItemById(r.item, r.nav)
      else setExpanded(null)
      // Back and forward move through conversations too: into one loads it,
      // out of one empties the thread.
      if (r.nav === 'core') {
        if (r.chat) {
          if (r.chat !== chat.chatIdRef.current) chat.showChat(r.chat)
        } else chat.clearChat()
      }
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // Jumping from an Ask citation opens the cited note itself, on its own
  // board: navigate() alone only switched boards and dropped the item, so the
  // click landed on a grid with nothing expanded. Can't reuse navigate() +
  // openExpanded() here — openExpanded reads `nav` from the render closure,
  // which is still the Ask view at this point — so push the combined path.
  const jumpTo = (item: UIItem) => {
    beforeSettings.current = item.type
    setNav(item.type)
    setExpanded(item)
    const path = routeToPath(item.type, item.id)
    if (location.pathname === path) return
    history.pushState(null, '', path)
    pushedItem.current = true
  }

  // The Ask tab is a way back to the Ask page, not just a no-op once you are on
  // it: clicking it from inside a conversation returns to the blank composer
  // and the history list. The conversation is saved, so nothing is lost.
  const goAsk = () => {
    if (nav === 'core') {
      chat.newChat()
      return
    }
    navigate('core')
    chat.focusComposer()
  }

  // Which destination the phone tab bar's sliding marker sits under. -1 on
  // Settings and on the filtered boards (/type/<t>, /space/<id>), where none
  // of the three is current — there the marker fades out rather than parking
  // under a tab that isn't the one you're on. Order matches the buttons below.
  const TAB_NAV = ['all', 'core', 'spaces', 'settings']
  // Inside a space `nav` is `space:<id>`, which is in none of these — so the
  // bar marked no tab at all and the one screen you can get lost on was the
  // one that never said where you were. A space IS the Spaces destination.
  const navTab = nav.startsWith('space:') ? 'spaces' : nav
  const tabIndex = TAB_NAV.indexOf(navTab)
  // Held so the marker fades out WHERE IT IS. Feeding the bar a 0 whenever no
  // tab is current made it slide back to the first tab on its way out, which
  // is a second piece of motion saying nothing.
  const lastTab = useRef(0)
  if (tabIndex >= 0) lastTab.current = tabIndex

  // filter chips for the Everything nav — only types/sources actually present
  // in the (search-filtered) set, with live counts straight from the server.
  const typeChips = CATEGORIES.map(c => ({
    key: c.id as string,
    label: c.label,
    glyph: c.glyph,
    count: notes.facets.types[c.id] || 0,
  })).filter(c => c.count > 0)
  const sourceChips = SOURCES.map(s => ({
    key: s.key,
    label: s.label,
    dot: s.dot,
    glyph: s.glyph,
    count: notes.facets.sources[s.key] || 0,
  })).filter(c => c.count > 0)
  // Only offered once a check has actually found something — a permanent
  // "Unavailable 0" chip is a filter for an empty set.
  const unavailableCount = notes.facets.unavailable || 0

  // Hold the app behind the first-run gate: a brief splash until we know the
  // configured state, then the model picker on a fresh install.
  if (needsSetup === null)
    return (
      <div className="app app-splash">
        <span className="mono">BOOTING…</span>
      </div>
    )
  if (needsSetup) return <Onboarding vault={vault} onComplete={() => setNeedsSetup(false)} />

  return (
    <div className="app">
      <header className="topbar">
        <DemoBanner />
      </header>

      <div className="body">
        <nav className="rail">
          <div className="rail-spacer"></div>
          {/* destinations sit above the utility pair, split off by the group rule.
              On phones the active marker is a single pill that slides between
              them (see foundation/responsive.css), driven by --tab. */}
          <div
            className={`rail-group rail-tabs${tabIndex >= 0 ? ' has-active' : ''}`}
            style={{ '--tab': lastTab.current } as React.CSSProperties}
          >
            <RailButton
              label="Everything"
              icon="all"
              active={nav === 'all'}
              onClick={() => {
                navigate('all')
                setSearch('')
              }}
            />
            <RailButton label="Ask" icon="ask" active={nav === 'core'} onClick={goAsk} />
            <RailButton
              label="Spaces"
              icon="spaces"
              active={navTab === 'spaces'}
              onClick={() => {
                navigate('spaces')
                setSearch('')
              }}
            />
            {/* Settings is a page like the three above it, so it rides the same
                marker. On phones it is the bar's fourth tab; on the desktop
                rail it is the last of the destinations, above the divider. */}
            <RailButton
              label="Settings"
              icon="settings"
              size={21}
              active={nav === 'settings'}
              onClick={toggleSettings}
            />
          </div>
          {/* Appearance, not a destination. Hidden on phones, where the theme
              switch lives at the bottom of Settings instead. */}
          <div className="rail-group">
            <RailButton
              label={theme === 'dark' ? 'Light mode' : 'Dark mode'}
              icon="theme"
              onClick={() => setTheme(v => (v === 'dark' ? 'light' : 'dark'))}
            />
          </div>
        </nav>

        <main className="main" key={nav}>
          {nav === 'core' ? (
            <CoreView
              {...chat}
              {...{
                coreRef,
                jumpTo,
                llmOff,
                warming: llmWarming,
                submit: chat.sendQuestion,
                busy: chat.asking,
                stop: chat.stopAsk,
              }}
            />
          ) : nav === 'settings' ? (
            <SettingsView vault={vault} theme={theme} setTheme={setTheme} />
          ) : nav === 'spaces' ? (
            <SpacesView {...{ collections, createCollection, navigate }} />
          ) : nav.startsWith('space:') ? (
            <CollectionView
              {...{
                collection: collections.find(c => c.id === nav.slice(6)) || null,
                view,
                setView,
                deleteItem,
                onExpand: openExpanded,
                collections,
                addToCollection,
                removeFromCollection,
                renameCollection,
                editCollectionTags,
                saveCanvas,
                deleteCollection,
                navigate,
                notesRef: spaceNotesRef,
              }}
            />
          ) : (
            <GalleryView
              {...{
                nav,
                view,
                setView,
                search,
                setSearch,
                searchFocus,
                setSearchFocus,
                deleteItem,
                slots: notes.slots,
                total: notes.total,
                ready: notes.ready,
                onWindow: notes.ensure,
                galFilter,
                setGalFilter,
                galSort,
                setGalSort,
                typeChips,
                sourceChips,
                unavailableCount,
                onExpand: openExpanded,
                collections,
                addToCollection,
                removeFromCollection,
              }}
            />
          )}
        </main>
      </div>

      {/* Capture is a global action, so the button is app-level rather than the
          gallery's: on phones it is the right-hand circle of the bottom
          cluster (see foundation/responsive.css) and has to be there on every
          page, not only Everything.
          Confirmation lives in the button itself rather than a toast: the
          click happened here, so this is where the answer belongs. Both icon
          and label are rendered at once and cross-faded so the pill never
          resizes mid-transition; `saved` drives the whole sequence. */}
      <button className={`fab${captured ? ' saved' : ''}`} onClick={() => setCaptureOpen(true)}>
        <span className="fab-ico">
          <Icon name="plus" size={20} stroke={2} />
          <Icon name="check" size={20} stroke={2.2} />
        </span>
        <span className="fab-label">
          <span>Capture</span>
          <span>Added</span>
        </span>
      </button>

      {expanded && (
        <ExpandedView
          item={expanded}
          onClose={closeExpanded}
          onDelete={deleteItem}
          onUpdate={updateItem}
          onRetag={retagItem}
          collections={collections}
          onAddTo={addToCollection}
          onRemoveFrom={removeFromCollection}
          onNav={navExpanded}
          slidesLoading={slidesLoading === expanded.id}
        />
      )}

      {captureOpen && <CaptureModal onClose={() => setCaptureOpen(false)} onSave={saveCapture} />}
    </div>
  )
}
