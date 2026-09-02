// App.tsx — Kothai shell: capture console, reactor states, gallery, ask thread, tweaks.
import { useState, useEffect, useRef } from 'react'
import { Icon, CATEGORIES, CAT } from '../components/icons'
import { API, Collections } from '../data/api'
import { useNotes } from '../data/useNotes'
import type { NoteSource } from '../data/useNotes'
import { isPlaceholder } from '../data/pager'
import { ExpandedView } from '../views/Expanded'
import { SettingsView } from '../views/Settings'
import { Onboarding } from '../views/Onboarding'
import { CaptureModal } from '../components/Capture'
import { useTweaks, TweaksPanel, TweakSection, TweakColor, TweakToggle, TweakRadio } from '../components/Tweaks'
import { pathToRoute, routeToPath, chatPath } from './router'
import { ACCENTS, SOURCES, SOURCE_BY_KEY, sourceGlyph } from '../domain/source'
import { CoreView } from '../views/Core'
import { GalleryView } from '../views/Gallery'
import { SpacesView, CollectionView } from '../views/Spaces'
import type {
  ChatSummary, Collection, ThreadMsg, UIItem, UIType, VaultStatus, ViewMode,
} from '../types'

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  'accent': '#ffffff',
  'defaultView': 'grid4',
  'texture': true,
}/*EDITMODE-END*/

export default function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS)
  const [collections, setCollections] = useState<Collection[]>([])
  const [expanded, setExpanded] = useState<UIItem | null>(null)
  const [pendingImg, setPendingImg] = useState<string | null>(null)
  const [vault, setVault] = useState<VaultStatus>({ state: 'loading', txt: 'BOOTING', pct: 0 })
  const [llmOff, setLlmOff] = useState(false)
  const [llmWarming, setLlmWarming] = useState('')
  // First-run gate: null until the first /api/status poll resolves; true shows the
  // model picker (fresh install), false enters the normal app. Onboarding flips
  // it false once the chosen models finish loading.
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null)
  // nav/mode are the two-part app location; seed them from the URL so deep links
  // and refreshes land on the right screen.
  const initialRoute = pathToRoute(typeof location !== 'undefined' ? location.pathname : '/')
  const [nav, setNav] = useState<string>(initialRoute.nav)
  const [captureOpen, setCaptureOpen] = useState(false)
  const [text, setText] = useState('')
  const [focus, setFocus] = useState(false)
  const [view, setView] = useState<ViewMode>(TWEAK_DEFAULTS.defaultView as ViewMode)
  const [thread, setThread] = useState<ThreadMsg[]>([])
  const [chatId, setChatId] = useState<string | null>(null)   // active server-side chat
  const [chatList, setChatList] = useState<ChatSummary[]>([]) // saved chat history (paged)
  const [chatTotal, setChatTotal] = useState(0)               // how many exist server-side
  const [search, setSearch] = useState('')
  const [searchFocus, setSearchFocus] = useState(false)
  const [galFilter, setGalFilter] = useState<string>('all')  // Everything-page type/source filter
  // Drives the capture button's "Added" state after a successful save.
  const [captured, setCaptured] = useState(false)
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    (typeof localStorage !== 'undefined' && localStorage.getItem('kothai-theme') === 'light') ? 'light' : 'dark')
  const taRef = useRef<HTMLTextAreaElement>(null)
  const coreRef = useRef<HTMLDivElement>(null)
  const beforeSettings = useRef<string>('all')  // view to restore when settings toggles off
  const pushedItem = useRef(false)  // true while the open item owns a history entry we can pop
  const askedSlides = useRef(new Set<string>())  // ids already checked for carousel slides this session
  const capturedTimer = useRef<number | undefined>(undefined)
  const msgSeq = useRef(0)   // ids for pending answer slots (see sendQuestion)
  const askAbort = useRef<AbortController | null>(null)  // backs the composer's stop button
  const chatIdRef = useRef<string | null>(null)  // live chatId for the mount-time popstate handler
  // CollectionView's own useNotes pager, when a Space is open — deleteItem/
  // updateItem below reach into it too, since ExpandedView (an App-level
  // modal) can trigger edits/deletes while a Space is open, and that pager
  // is a separate instance from the Everything board's.
  const spaceNotesRef = useRef<NoteSource | null>(null)

  // Only pin --accent inline for a real (non-default) tint; otherwise defer to
  // the stylesheet so each theme's default accent applies.
  useEffect(() => {
    const el = document.documentElement
    if (t.accent && t.accent.toLowerCase() !== '#ffffff') el.style.setProperty('--accent', t.accent)
    else el.style.removeProperty('--accent')
  }, [t.accent])
  useEffect(() => { document.documentElement.dataset.theme = theme; try { localStorage.setItem('kothai-theme', theme) } catch { /* ignore */ } }, [theme])
  useEffect(() => { setView(t.defaultView as ViewMode) }, [t.defaultView])
  useEffect(() => { setGalFilter('all') }, [nav])   // clear filter when switching pages
  useEffect(() => { chatIdRef.current = chatId }, [chatId])
  useEffect(() => { const fx = document.getElementById('bg-fx'); if (fx) fx.style.display = t.texture ? '' : 'none' }, [t.texture])

  useEffect(() => { Collections.list().then(setCollections).catch(() => {}) }, [])

  // nav → server query for the Everything board: the chip filter narrows by
  // type or source, a direct type-nav (e.g. /image) filters server-side too.
  const chipSource = SOURCE_BY_KEY[galFilter] ? galFilter : undefined
  const chipType = !chipSource && galFilter !== 'all' ? (galFilter === 'note' ? 'text' : galFilter) : undefined
  const navType = nav !== 'all' && !nav.startsWith('space:') && CAT[nav as UIType] ? (nav === 'note' ? 'text' : nav) : undefined
  const galleryActive = !(nav === 'core' || nav === 'settings' || nav === 'spaces') && !nav.startsWith('space:')
  const notes = useNotes(
    { type: navType ?? chipType, source: chipSource, q: search },
    galleryActive,
  )
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
        (notes.slots.find((s) => !isPlaceholder(s) && s.id === expanded.id) as UIItem | undefined) ??
        (spaceNotesRef.current?.slots.find((s) => !isPlaceholder(s) && s.id === expanded.id) as UIItem | undefined)
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
    API.slides(it.id).then((fresh) => {
      if (stop || !fresh.slides?.length) return
      notes.patchLocal(fresh.id, { slides: fresh.slides })
      spaceNotesRef.current?.patchLocal(fresh.id, { slides: fresh.slides })
      setExpanded((cur) => (cur && cur.id === fresh.id ? { ...cur, slides: fresh.slides } : cur))
    }).catch(() => { askedSlides.current.delete(it.id) })
    return () => { stop = true }
  }, [expanded?.id])

  // live model status (text models + lazy vision model)
  useEffect(() => {
    let stop = false
    const tick = async () => {
      try {
        const s = await API.status()
        // Decide the first-run gate once, from the first successful poll. Onboarding
        // owns flipping it false afterward (so it stays up through the download).
        setNeedsSetup((v) => (v === null ? !s.configured : v))
        setLlmOff(s.roles.llm.state === 'off')
        // Tied to the llm role specifically, not the aggregate — the aggregate
        // can be "loading" because an unrelated role (e.g. vision) is warming
        // up in the background, which would otherwise show a misleading
        // message under a text answer that isn't waiting on that role at all.
        setLlmWarming(s.roles.llm.state === 'loading' ? (s.roles.llm.message || 'Warming up the language model…') : '')
        const a = s.aggregate
        if (a.state === 'error') setVault({ state: 'error', txt: 'FAULT', pct: a.progress || 0, msg: a.message })
        else if (a.state === 'loading') setVault({ state: 'loading', txt: 'LOADING ' + (a.progress || 0) + '%', pct: a.progress || 0, msg: a.message })
        else setVault({ state: 'ready', txt: 'ONLINE', pct: 100, msg: '' })
        // keep polling forever — settings changes flip status back to "loading"
        // at any time (slow tick while ready)
        if (!stop) window.setTimeout(tick, a.state === 'loading' ? 1300 : 4000)
      } catch { if (!stop) window.setTimeout(tick, 2200) }
    }
    tick(); return () => { stop = true }
  }, [])

  const autosize = () => { const ta = taRef.current; if (ta) { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 200) + 'px' } }
  useEffect(autosize, [text])

  // Long enough to read the swap and see it settle, short enough that the
  // button is back to "Capture" before anyone reaches for it again.
  const flashCaptured = () => {
    clearTimeout(capturedTimer.current); setCaptured(true)
    capturedTimer.current = window.setTimeout(() => setCaptured(false), 1900)
  }
  useEffect(() => () => clearTimeout(capturedTimer.current), [])

  // One question at a time: the composer's send button and Enter are both gated
  // on this, so a second ask can't be started while one is still in flight.
  const asking = thread.some((m) => m.pending)

  // Ask: query the vault; used by the Ask (core) view composer.
  const sendQuestion = async () => {
    const raw = text.trim(); const img = pendingImg
    if (asking || (!raw && !img)) return
    // The pending bubble is claimed by id, not by position: a reply used to be
    // written to whatever sat last in the thread, so with two asks in flight
    // the first answer back landed under the second question.
    const slot = 'm' + (msgSeq.current++)
    const at = Date.now()
    setThread((prev) => [...prev,
      { role: 'user', text: raw || '▣ image', img, ts: at },
      { role: 'ai', pending: true, id: slot, ts: at }])
    setText(''); setPendingImg(null)
    const settle = (msg: ThreadMsg) => setThread((prev) => prev.map((m) => (m.id === slot ? msg : m)))
    const ctl = new AbortController()
    askAbort.current = ctl
    // Tokens arrive far faster than anyone reads, so they accumulate and land
    // on a timer — one setState per token re-renders the whole thread hundreds
    // of times for a single answer. This is deliberately NOT
    // requestAnimationFrame: a backgrounded tab stops painting frames, and a
    // slow local answer is exactly when someone switches away, so an rAF flush
    // showed nothing at all until the whole answer had arrived.
    const FLUSH_MS = 60
    let acc = ''
    let timer: number | undefined
    let lastFlush = 0
    const patch = (p: Partial<ThreadMsg>) =>
      setThread((prev) => prev.map((m) => (m.id === slot ? { ...m, ...p } : m)))
    const flush = () => {
      timer = undefined
      lastFlush = Date.now()
      patch({ pending: false, streaming: true, lead: acc, q: raw })
    }
    // Any pending flush has to be dropped before the final patch, or it lands
    // afterwards and puts the message back into its streaming state.
    const stopFlushing = () => { clearTimeout(timer); timer = undefined }
    try {
      const { chatId: cid } = await API.askStream({ question: raw, image: img, chatId }, {
        onSources: (cited) => patch({ cited }),
        onDelta: (t) => {
          acc += t
          if (timer !== undefined) return
          timer = window.setTimeout(flush, Math.max(0, FLUSH_MS - (Date.now() - lastFlush)))
        },
      }, ctl.signal)
      stopFlushing()
      if (cid) {
        setChatId(cid)
        // The chat only exists once the server has recorded it, so this is the
        // first moment the question has an address worth keeping.
        if (location.pathname !== chatPath(cid)) history.replaceState(null, '', chatPath(cid))
      }
      patch({ pending: false, streaming: false, lead: acc, q: raw, ts: Date.now() })
      refreshChats()
    } catch (e) {
      // A stopped answer keeps whatever it managed to say — the tokens were
      // real, and throwing them away to show "Stopped." loses information the
      // user was already reading.
      stopFlushing()
      if (ctl.signal.aborted) patch({ pending: false, streaming: false, lead: acc, q: raw, ts: Date.now(), stopped: true })
      else settle({ role: 'ai', id: slot, lead: '⚠ ' + (e as Error).message, cited: [], q: raw, ts: Date.now() })
    } finally {
      if (askAbort.current === ctl) askAbort.current = null
    }
    // Hand the caret back so the next question is one keystroke away.
    taRef.current?.focus()
  }

  // Stop waiting on the answer in flight. The server is already generating it
  // and will still record it to the chat — this releases the composer, it does
  // not cancel the model.
  const stopAsk = () => askAbort.current?.abort()

  // Store: persist a captured item. Called by the capture modal; resolves to
  // null on success (the modal closes and the button flashes "Added") or to
  // the failure message, which the modal shows inline over the still-filled
  // input — the one place the user can actually retry from.
  const saveCapture = async (raw: string, img: string | null): Promise<string | null> => {
    if (!raw && !img) return 'Nothing to save.'
    try {
      const { note } = await API.save({ text: raw, image: img })
      notes.insertLocal(note)
      flashCaptured()
      return null
    } catch (e) {
      return (e as Error).message || 'Could not save that.'
    }
  }

  // ---- chat history: load list in ask mode; open / delete / start fresh ---
  // One screenful to start; "Load more" walks the rest. Refreshes reload
  // however much is already on screen, so answering a question doesn't collapse
  // a list the reader had expanded.
  const CHAT_PAGE = 8
  const loadChats = (limit = CHAT_PAGE) =>
    API.chats(limit, 0).then(({ chats, total }) => { setChatList(chats); setChatTotal(total) })
  const refreshChats = () => loadChats(Math.max(CHAT_PAGE, chatList.length)).catch(() => {})
  const loadMoreChats = () =>
    API.chats(CHAT_PAGE, chatList.length)
      .then(({ chats, total }) => {
        setChatTotal(total)
        // Filter by id: a chat answered since the first page shifts everything
        // down by one, which would otherwise duplicate a row across pages.
        setChatList((prev) => {
          const seen = new Set(prev.map((c) => c.id))
          return [...prev, ...chats.filter((c) => !seen.has(c.id))]
        })
      })
      .catch(() => {})
  useEffect(() => { if (nav === 'core') loadChats().catch(() => {}) }, [nav])
  const openChat = (c: ChatSummary) => {
    if (location.pathname !== chatPath(c.id)) history.pushState(null, '', chatPath(c.id))
    return showChat(c.id)
  }
  // Load a conversation into the thread without touching history — the URL is
  // either already right (popstate, deep link) or the caller has just set it.
  const showChat = async (id: string) => {
    try {
      const chat = await API.chat(id)
      let lastQ = ''
      setThread(chat.messages.map((m): ThreadMsg => {
        const ts = m.ts ? Date.parse(m.ts) : undefined
        return m.role === 'user'
          ? (lastQ = m.text || '', { role: 'user', text: m.text || '▣ image', img: m.image || null, ts })
          : { role: 'ai', lead: m.text, cited: m.cited || [], q: lastQ, ts }
      }))
      setChatId(chat.id)
      // Resuming a conversation puts you back at the composer, ready to continue.
      setTimeout(() => taRef.current?.focus(), 60)
    } catch {
      // Deleted or unknown id: drop back to a blank Ask rather than stranding
      // the reader on a URL that resolves to nothing.
      setThread([]); setChatId(null)
      if (location.pathname !== '/ask') history.replaceState(null, '', '/ask')
    }
  }
  const newChat = () => {
    setThread([]); setChatId(null)
    if (location.pathname !== '/ask') history.pushState(null, '', '/ask')
    setTimeout(() => taRef.current?.focus(), 60)
  }
  // The list carries the title, so it updates locally; the server is the
  // authority on the trim/length rules and reconciles on the next fetch.
  const renameChat = (id: string, title: string) => {
    setChatList((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)))
    API.renameChat(id, title)
      .then(refreshChats)
      .catch(refreshChats)
  }
  const deleteChat = (id: string) => {
    setChatList((prev) => prev.filter((c) => c.id !== id))
    setChatTotal((n) => Math.max(0, n - 1))
    if (id === chatId) newChat()   // also drops /ask/<id> from the URL
    API.delChat(id).catch(() => {})
  }

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendQuestion() } }
  const onFocus = () => setFocus(true)
  const onBlur = () => setFocus(false)
  const onImageFile = (file: File | null | undefined) => { if (!file) return; const r = new FileReader(); r.onload = () => setPendingImg(r.result as string); r.readAsDataURL(file) }
  const clearImg = () => setPendingImg(null)

  const deleteItem = (id: string) => {
    notes.removeLocal(id)
    spaceNotesRef.current?.removeLocal(id)
    API.del(id).catch(() => {})
  }
  // optimistic tag / mind-note edits from the expanded view; server reconciles
  const updateItem = (id: string, patch: { tags?: string[]; mindNote?: string }) => {
    notes.patchLocal(id, patch)
    spaceNotesRef.current?.patchLocal(id, patch)
    setExpanded((cur) => (cur && cur.id === id ? { ...cur, ...patch } : cur))
    API.update(id, patch).catch(() => {})
  }
  // force a fresh classify/embed pass for one item, discarding its current
  // tags; the server flips `pending` immediately so the existing pending-item
  // UI (already used for fresh saves) shows progress with no new loading state
  const retagItem = (id: string) => {
    API.retag(id).then((note) => {
      notes.patchLocal(id, note)
      spaceNotesRef.current?.patchLocal(id, note)
      setExpanded((cur) => (cur && cur.id === id ? note : cur))
    }).catch(() => {})
  }

  // ---- collections (Spaces) ----------------------------------------------
  const createCollection = async (name: string, tags: string[]) => {
    const c = await Collections.create(name, tags)
    setCollections((prev) => [c, ...prev])
    return c
  }
  const renameCollection = (id: string, name: string) => {
    setCollections((prev) => prev.map((c) => (c.id === id ? { ...c, name } : c)))
    Collections.update(id, { name }).catch(() => {})
  }
  // These three await the server (its response reflects smart-rule backfill /
  // membership); on failure we just refetch the truth rather than leave the UI
  // ahead of the server.
  const syncCollection = (c: Collection) => setCollections((prev) => prev.map((x) => (x.id === c.id ? c : x)))
  const editCollectionTags = async (id: string, tags: string[]) => {
    try { syncCollection(await Collections.update(id, { tags })) }
    catch { Collections.list().then(setCollections).catch(() => {}) }
  }
  const deleteCollection = (id: string) => {
    setCollections((prev) => prev.filter((c) => c.id !== id))
    Collections.remove(id).catch(() => {})
  }
  const addToCollection = async (cid: string, itemId: string) => {
    try { syncCollection(await Collections.addItem(cid, itemId)) }
    catch { Collections.list().then(setCollections).catch(() => {}) }
  }
  const removeFromCollection = async (cid: string, itemId: string) => {
    try { syncCollection(await Collections.removeItem(cid, itemId)) }
    catch { Collections.list().then(setCollections).catch(() => {}) }
  }

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
    // Replace rather than stack when one overlay opens another (mindmap → item),
    // so a single Back always returns to the board.
    if (pathToRoute(location.pathname).item) history.replaceState(null, '', path)
    else { history.pushState(null, '', path); pushedItem.current = true }
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
    API.note(id).then(setExpanded).catch(() => {
      setExpanded(null)
      history.replaceState(null, '', routeToPath(nextNav))
    })
  }
  // Settings acts as a toggle: opening remembers where we were, closing returns there.
  const toggleSettings = () => {
    navigate(nav === 'settings' ? beforeSettings.current : 'settings')
    setSearch('')
  }
  // Mirror browser back/forward into state, and normalize any odd landing URL.
  useEffect(() => {
    const canonical = initialRoute.chat
      ? chatPath(initialRoute.chat)
      : routeToPath(initialRoute.nav, initialRoute.item)
    if (canonical !== location.pathname) history.replaceState(null, '', canonical)
    if (initialRoute.item) showItemById(initialRoute.item, initialRoute.nav)
    // A cold deep link to /ask/<id> arrives with no chat in hand, same as an
    // item deep link does.
    if (initialRoute.chat) showChat(initialRoute.chat)
    const onPop = () => {
      const r = pathToRoute(location.pathname)
      pushedItem.current = false
      setNav(r.nav)
      if (r.item) showItemById(r.item, r.nav)
      else setExpanded(null)
      // Back and forward move through conversations too: into one loads it,
      // out of one empties the thread.
      if (r.nav === 'core') {
        if (r.chat) { if (r.chat !== chatIdRef.current) showChat(r.chat) }
        else { setThread([]); setChatId(null) }
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
    if (nav === 'core') { newChat(); return }
    navigate('core')
    setTimeout(() => taRef.current && taRef.current.focus(), 60)
  }

  // Which destination the phone tab bar's sliding marker sits under. -1 on
  // Settings and on the filtered boards (/type/<t>, /space/<id>), where none
  // of the three is current — there the marker fades out rather than parking
  // under a tab that isn't the one you're on. Order matches the buttons below.
  const TAB_NAV = ['all', 'core', 'spaces', 'settings']
  const tabIndex = TAB_NAV.indexOf(nav)
  // Held so the marker fades out WHERE IT IS. Feeding the bar a 0 whenever no
  // tab is current made it slide back to the first tab on its way out, which
  // is a second piece of motion saying nothing.
  const lastTab = useRef(0)
  if (tabIndex >= 0) lastTab.current = tabIndex

  // filter chips for the Everything nav — only types/sources actually present
  // in the (search-filtered) set, with live counts straight from the server.
  const typeChips = CATEGORIES
    .map((c) => ({ key: c.id as string, label: c.label, glyph: c.glyph, count: notes.facets.types[c.id === 'note' ? 'text' : c.id] || 0 }))
    .filter((c) => c.count > 0)
  const sourceChips = SOURCES
    .map((s) => ({ key: s.key, label: s.label, dot: s.dot, glyph: s.glyph, count: notes.facets.sources[s.key] || 0 }))
    .filter((c) => c.count > 0)

  // Hold the app behind the first-run gate: a brief splash until we know the
  // configured state, then the model picker on a fresh install.
  if (needsSetup === null) return <div className="app app-splash"><span className="mono">BOOTING…</span></div>
  if (needsSetup) return <Onboarding vault={vault} onComplete={() => setNeedsSetup(false)} />

  return (
    <div className="app">
      <header className="topbar"></header>

      <div className="body">
        <nav className="rail">
          <div className="rail-spacer"></div>
          {/* destinations sit above the utility pair, split off by the group rule.
              On phones the active marker is a single pill that slides between
              them (see foundation/responsive.css), driven by --tab. */}
          <div className={'rail-group rail-tabs' + (tabIndex >= 0 ? ' has-active' : '')}
            style={{ '--tab': lastTab.current } as React.CSSProperties}>
            <button className={'rail-btn' + (nav === 'all' ? ' active' : '')} onClick={() => { navigate('all'); setSearch('') }}>
              <Icon name="all" size={20} /><span className="rail-tip">Everything</span>
            </button>
            <button className={'rail-btn' + (nav === 'core' ? ' active' : '')} onClick={goAsk}>
              <Icon name="ask" size={20} /><span className="rail-tip">Ask</span>
            </button>
            <button className={'rail-btn' + (nav === 'spaces' ? ' active' : '')} onClick={() => { navigate('spaces'); setSearch('') }}>
              <Icon name="spaces" size={20} /><span className="rail-tip">Spaces</span>
            </button>
            {/* Settings is a page like the three above it, so it rides the same
                marker. On phones it is the bar's fourth tab; on the desktop
                rail it is the last of the destinations, above the divider. */}
            <button className={'rail-btn' + (nav === 'settings' ? ' active' : '')} onClick={toggleSettings}>
              <Icon name="settings" size={21} /><span className="rail-tip">Settings</span>
            </button>
          </div>
          {/* Appearance, not a destination. Hidden on phones, where the theme
              switch lives at the bottom of Settings instead. */}
          <div className="rail-group">
            <button className="rail-btn" onClick={() => setTheme((v) => v === 'dark' ? 'light' : 'dark')}>
              <Icon name="theme" size={20} /><span className="rail-tip">{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
            </button>
          </div>
        </nav>

        <main className="main" key={nav}>
          {nav === 'core'
            ? <CoreView {...{ focus, onFocus, onBlur, onKey, text, setText, submit: sendQuestion, taRef, coreRef, thread, jumpTo, pendingImg, onImageFile, clearImg, chatList, openChat, newChat, deleteChat, renameChat, chatId, chatTotal, loadMoreChats, llmOff, busy: asking, stop: stopAsk, warming: llmWarming }} />
            : nav === 'settings'
            ? <SettingsView vault={vault} theme={theme} setTheme={setTheme} />
            : nav === 'spaces'
            ? <SpacesView {...{ collections, createCollection, navigate }} />
            : nav.startsWith('space:')
            ? <CollectionView {...{ collection: collections.find((c) => c.id === nav.slice(6)) || null, view, setView, deleteItem, onExpand: openExpanded, collections, addToCollection, removeFromCollection, renameCollection, editCollectionTags, deleteCollection, navigate, notesRef: spaceNotesRef }} />
            : <GalleryView {...{ nav, view, setView, search, setSearch, searchFocus, setSearchFocus, deleteItem, slots: notes.slots, total: notes.total, ready: notes.ready, onWindow: notes.ensure, galFilter, setGalFilter, typeChips, sourceChips, onExpand: openExpanded, collections, addToCollection, removeFromCollection }} />}
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
      <button className={'fab' + (captured ? ' saved' : '')} onClick={() => setCaptureOpen(true)}>
        <span className="fab-ico">
          <Icon name="plus" size={20} stroke={2} />
          <Icon name="check" size={20} stroke={2.2} />
        </span>
        <span className="fab-label">
          <span>Capture</span>
          <span>Added</span>
        </span>
      </button>

      {expanded && <ExpandedView item={expanded} onClose={closeExpanded} onDelete={deleteItem} onUpdate={updateItem} onRetag={retagItem} collections={collections} onAddTo={addToCollection} onRemoveFrom={removeFromCollection} />}

      {captureOpen && <CaptureModal onClose={() => setCaptureOpen(false)} onSave={saveCapture} />}

      <TweaksPanel>
        <TweakSection label="Core" />
        <TweakColor label="Accent signal" value={t.accent} options={ACCENTS} onChange={(v) => setTweak('accent', v)} />
        <TweakToggle label="Ambient texture" value={t.texture} onChange={(v) => setTweak('texture', v)} />
        <TweakSection label="Gallery" />
        <TweakRadio label="Default grid" value={t.defaultView} options={[{ value: 'grid4', label: '4' }, { value: 'grid6', label: '6' }, { value: 'grid8', label: '8' }]} onChange={(v) => setTweak('defaultView', v)} />
      </TweaksPanel>
    </div>
  )
}
