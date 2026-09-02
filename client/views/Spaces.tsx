// Spaces.tsx — the Spaces landing (collection cards + inline new-collection
// form) and the single-collection view (rename, smart rule tags, item board).
import { useState, useEffect, useMemo, useRef, type MutableRefObject } from 'react'
import { Icon } from '../components/icons'
import { ItemCard } from '../components/Cards'
import { WindowedBoard } from '../components/Board'
import { scrollEdges, edgeClass } from '../layout/overflow'
import { Mindmap } from '../components/Mindmap'
import { useNotes } from '../data/useNotes'
import type { NoteSource } from '../data/useNotes'
import { isPlaceholder } from '../data/pager'
import type { Collection, UIItem, ViewMode } from '../types'

interface SpacesViewProps {
  collections: Collection[]
  createCollection: (name: string, tags: string[]) => Promise<Collection>
  navigate: (next: string) => void
}

// The Spaces landing: a grid of collection cards + an inline "new collection"
// form. A collection's cover is its first few members' thumbnails, resolved
// server-side (collections.js's withCovers) — no client-side item lookup needed.
export function SpacesView({ collections, createCollection, navigate }: SpacesViewProps) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [tags, setTags] = useState('')

  const submit = async () => {
    const nm = name.trim()
    if (!nm) return
    const tagList = tags.split(',').map((t) => t.trim()).filter(Boolean)
    const c = await createCollection(nm, tagList)
    setName(''); setTags(''); setCreating(false)
    navigate('space:' + c.id)
  }

  const coverFor = (c: Collection): string | null => {
    for (const it of c.covers ?? []) { const src = it.thumb || it.img; if (src) return src }
    return null
  }

  return (
    <div className="spaces-view">
      <header className="spaces-head">
        <h1 className="spaces-title">Spaces</h1>
        <button className="spaces-new-btn" onClick={() => setCreating((v) => !v)}>＋ New space</button>
      </header>

      {creating && (
        <div className="space-form">
          <input className="space-form-name" autoFocus placeholder="Space name…" value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') setCreating(false) }} />
          <input className="space-form-tags mono" placeholder="smart tags (comma-separated, optional)" value={tags}
            onChange={(e) => setTags(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') setCreating(false) }} />
          <button className="space-form-go" onClick={submit}>Create</button>
        </div>
      )}

      <div className="spaces-scroll">
        {collections.length === 0 && !creating
          ? <div className="empty"><Icon name="spark" size={40} /><p>NO SPACES YET</p></div>
          : <div className="spaces-grid">
              {collections.map((c) => {
                const cover = coverFor(c)
                return (
                  // The same .tile the Ask thread's citations use — a space
                  // card and a citation card are both a cover, a name and a
                  // line of small print, so they share one shape.
                  <button key={c.id} className="tile space-card" onClick={() => navigate('space:' + c.id)}>
                    <div className="tile-media" style={cover ? { backgroundImage: `url(${cover})` } : undefined}>
                      {!cover && <Icon name="spark" size={26} />}
                      {c.tags.length > 0 && <span className="tile-plate right" title="Smart space"><Icon name="spark" size={11} /></span>}
                    </div>
                    <div className="tile-cap">
                      <span className="tile-title">{c.name}</span>
                      <span className="tile-meta">{c.count} item{c.count === 1 ? '' : 's'}</span>
                    </div>
                  </button>
                )
              })}
            </div>}
      </div>
    </div>
  )
}

interface CollectionViewProps {
  collection: Collection | null
  view: ViewMode
  setView: (v: ViewMode) => void
  deleteItem: (id: string) => void
  onExpand: (item: UIItem) => void
  collections: Collection[]
  addToCollection: (cid: string, itemId: string) => void
  removeFromCollection: (cid: string, itemId: string) => void
  renameCollection: (id: string, name: string) => void
  editCollectionTags: (id: string, tags: string[]) => void
  deleteCollection: (id: string) => void
  navigate: (next: string) => void
  // App's delete/update handlers also drive the ExpandedView modal, which is
  // mounted at the App level (outside this component) — so a tag edit or
  // delete made from the modal needs a way to reach this collection's own
  // pager too, or the board behind the modal would show stale data until the
  // next full fetch. App hands us its ref; we keep it pointed at our `notes`.
  notesRef?: MutableRefObject<NoteSource | null>
}

export function CollectionView({ collection, view, setView, deleteItem, onExpand, collections, addToCollection, removeFromCollection, renameCollection, editCollectionTags, deleteCollection, navigate, notesRef }: CollectionViewProps) {
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [tagDraft, setTagDraft] = useState('')
  const [addingTag, setAddingTag] = useState(false)
  const [mind, setMind] = useState(false)
  const [armed, setArmed] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Self-fetch this collection's members — enabled only once we know which
  // collection to fetch (must be called unconditionally, before the
  // not-found guard below, per the rules of hooks).
  const notes = useNotes({ collection: collection?.id }, !!collection)
  // /api/notes?collection=X just filters by membership — it doesn't preserve
  // itemIds order (newest-added-first). Re-sort here so the board matches the
  // Spaces-grid cover tile, which resolves order from itemIds via withCovers.
  // Anything missing from itemIds (shouldn't normally happen) sorts last.
  // Memoized: the board's packing/window memos key off this array's identity,
  // so rebuilding it every render would re-pack and re-observe on every render.
  const collItems = useMemo(() => {
    const order = new Map((collection?.itemIds ?? []).map((id, i) => [id, i]))
    return notes.slots
      .filter((s): s is UIItem => !isPlaceholder(s))
      .sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity))
  }, [notes.slots, collection?.itemIds])

  useEffect(() => {
    if (!notesRef) return
    notesRef.current = notes
    return () => { notesRef.current = null }
  }, [notesRef, notes])

  // Collections are bounded (unlike Everything), so load every page up front
  // rather than fetching on scroll. The board still windows what it MOUNTS —
  // that's the shared layout — this just means it never renders a skeleton.
  useEffect(() => {
    if (notes.total > 0) notes.ensure(0, notes.total - 1)
  }, [notes.total])

  useEffect(() => { setArmed(false) }, [collection?.id])

  if (!collection) {
    return <div className="collection-view"><div className="empty"><Icon name="spark" size={40} /><p>SPACE NOT FOUND</p></div></div>
  }

  // Board-originated delete/remove: also drop the item from this collection's
  // own pager immediately, rather than waiting on the next fetch.
  const handleDelete = (id: string) => { notes.removeLocal(id); deleteItem(id) }
  const handleRemoveFrom = (cid: string, itemId: string) => {
    if (cid === collection.id) notes.removeLocal(itemId)
    removeFromCollection(cid, itemId)
  }

  const commitName = () => {
    const nm = nameDraft.trim()
    if (nm && nm !== collection.name) renameCollection(collection.id, nm)
    setRenaming(false)
  }
  const startRename = () => { setNameDraft(collection.name); setRenaming(true) }
  const removeTag = (t: string) => editCollectionTags(collection.id, collection.tags.filter((x) => x !== t))
  const del = () => { deleteCollection(collection.id); navigate('spaces') }

  // ---- rule-tag builder ---------------------------------------------------
  // A smart space auto-includes any vault item carrying one of its rule tags,
  // so the picker surfaces every tag in the vault with a live item-count — you
  // pick a rule and see its reach, instead of typing a tag string blind.
  const closeRuleAdd = () => { setAddingTag(false); setTagDraft('') }
  const addRule = (tag: string) => {
    const t = tag.trim().toLowerCase()
    if (t && !collection.tags.includes(t)) editCollectionTags(collection.id, [...collection.tags, t])
    setTagDraft('')  // keep the popover open for adding several rules in a row
  }
  // The rule strip scrolls sideways on phones, so it carries the same fade
  // hints the Everything filter bar does — one module, one behaviour.
  const ruleRef = useRef<HTMLDivElement>(null)
  const [ruleEdges, setRuleEdges] = useState({ left: false, right: false })
  useEffect(() => {
    const el = ruleRef.current
    if (!el) return
    const read = () => setRuleEdges(scrollEdges(el.scrollLeft, el.scrollWidth, el.clientWidth))
    read()
    el.addEventListener('scroll', read, { passive: true })
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => { el.removeEventListener('scroll', read); ro.disconnect() }
  }, [collection.tags.length])

  const ruleSet = new Set(collection.tags)
  const q = tagDraft.trim().toLowerCase()
  const tagCounts = new Map<string, number>()
  for (const it of collItems) for (const t of (it.tags || [])) if (!ruleSet.has(t)) tagCounts.set(t, (tagCounts.get(t) || 0) + 1)
  const suggestions = [...tagCounts.entries()]
    .filter(([t]) => !q || t.includes(q))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
  const canAddNew = !!q && !ruleSet.has(q) && !suggestions.some(([t]) => t === q)

  return (
    <div className="collection-view">
      <header className="coll-head">
        {/* Tier 1 — identity: what this space is called and how big it is.
            The board below is the content; this tier only ever says that. */}
        <div className="coll-head-top">
          {renaming
            ? <input className="coll-name-input" autoFocus value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') commitName(); if (e.key === 'Escape') setRenaming(false) }}
                onBlur={commitName} />
            : // The name, its pencil and the count are one group: the pencil
              // stays faint until the group is hovered, so the title reads as
              // a title rather than as a row of controls.
              <div className="coll-title">
                {collection.tags.length > 0 && (
                  <span className="coll-smart" tabIndex={0} aria-label="Smart space">
                    <Icon name="spark" size={13} />
                    <span className="coll-smart-pop" role="tooltip">
                      <b>Smart space</b>
                      Any item tagged with a rule below joins this space automatically.
                    </span>
                  </span>
                )}
                <h1 className="coll-name" onClick={startRename}>{collection.name}</h1>
                {/* The count belongs to the name, so it sits against it — with
                    the pencil between them it read as a detached third thing. */}
                <span className="coll-count mono">{collItems.length} item{collItems.length === 1 ? '' : 's'}</span>
                {/* Rename and delete are what you do to the SPACE, so they live
                    with its name. Delete used to sit on the view toolbar with
                    only a hairline between it and "Mindmap", which gave an
                    irreversible action the same weight as a view switch. */}
                <span className="coll-idactions">
                  <button className="coll-rename" title="Rename space" aria-label="Rename space" onClick={startRename}>
                    <Icon name="edit" size={14} />
                  </button>
                  <button className={'coll-del' + (armed ? ' armed' : '')} aria-label={armed ? 'Confirm delete space' : 'Delete space'}
                    title={armed ? '' : 'Delete space'}
                    onClick={() => (armed ? del() : setArmed(true))}
                    onBlur={() => setArmed(false)}
                    onKeyDown={(e) => { if (e.key === 'Escape') setArmed(false) }}>
                    {armed ? 'Delete space?' : <Icon name="trash" size={16} />}
                  </button>
                </span>
              </div>}
        </div>

        {/* Tier 2 — one bar: what fills the space on the left, how you look at
            it on the right. Density sits at the left of the tool group so that
            dropping it in mindmap mode never moves the view switch or the bin. */}
        <div className="coll-bar">
          <div className={'coll-rule' + edgeClass(ruleEdges)} ref={ruleRef}>
            {collection.tags.map((t) => (
              <button key={t} className="chip coll-tag" title="Remove rule tag" onClick={() => removeTag(t)}>{t}<span className="coll-tag-x">×</span></button>
            ))}
            <div className="coll-ruleadd">
              <button className={'chip coll-addtag' + (addingTag ? ' on' : '')} aria-haspopup="dialog" aria-expanded={addingTag} onClick={() => (addingTag ? closeRuleAdd() : setAddingTag(true))}>+ rule tag</button>
              {addingTag && (
                <>
                  <div className="menu-backdrop" onClick={closeRuleAdd} />
                  <div className="rulepop" role="dialog" aria-label="Add rule tag">
                    <p className="rulepop-hint">Items tagged with any of these automatically join this space.</p>
                    <input className="rulepop-input mono" autoFocus value={tagDraft} placeholder="filter or add a tag…"
                      onChange={(e) => setTagDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); const pick = suggestions[0]?.[0] ?? q; if (pick) addRule(pick) } if (e.key === 'Escape') closeRuleAdd() }} />
                    <div className="rulepop-list">
                      {suggestions.map(([t, c]) => (
                        <button key={t} className="rulepop-item" onClick={() => addRule(t)}>
                          <span className="rulepop-tag">{t}</span>
                          <span className="rulepop-count">{c} item{c === 1 ? '' : 's'}</span>
                        </button>
                      ))}
                      {canAddNew && (
                        <button className="rulepop-item rulepop-new" onClick={() => addRule(q)}>
                          <span className="rulepop-tag">+ add “{q}”</span>
                          <span className="rulepop-count">new</span>
                        </button>
                      )}
                      {!suggestions.length && !canAddNew && (
                        <p className="rulepop-empty">{tagCounts.size ? 'No matching tags' : 'No tags in your vault yet'}</p>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="coll-tools">
            {!mind && (
              <div className="view-toggle">
                <button className={view === 'grid4' ? 'on' : ''} onClick={() => setView('grid4')} title="4 columns"><Icon name="grid4" size={16} /></button>
                <button className={view === 'grid6' ? 'on' : ''} onClick={() => setView('grid6')} title="6 columns"><Icon name="grid6" size={16} /></button>
                <button className={view === 'grid8' ? 'on' : ''} onClick={() => setView('grid8')} title="8 columns"><Icon name="grid8" size={16} /></button>
              </div>
            )}
            <div className="seg" role="tablist" aria-label="View mode">
              <button role="tab" aria-selected={!mind} className={'seg-btn' + (!mind ? ' on' : '')} onClick={() => setMind(false)}>Grid</button>
              <button role="tab" aria-selected={mind} className={'seg-btn' + (mind ? ' on' : '')} onClick={() => setMind(true)}>Mindmap</button>
            </div>
          </div>
        </div>
      </header>

      {mind
        ? <Mindmap items={collItems} spaceName={collection.name} onExpand={onExpand} />
        : <div className="gal-scroll" ref={scrollRef}>
            {collItems.length === 0
              ? <div className="empty"><Icon name="spark" size={40} /><p>{collection.tags.length > 0 ? 'NO ITEMS MATCH YET' : 'ADD ITEMS FROM EVERYTHING'}</p></div>
              : <WindowedBoard items={collItems} view={view} scroller={scrollRef}
                  renderItem={(it) => (
                    <ItemCard item={it} onDelete={handleDelete} onExpand={onExpand}
                      collections={collections} onAddTo={addToCollection} onRemoveFrom={handleRemoveFrom} />
                  )} />}
          </div>}
    </div>
  )
}
