// Spaces.tsx — the Spaces landing (collection cards + inline new-collection
// form) and the single-collection view (rename, smart rule tags, item board).
import { useState, useEffect, useMemo, useRef, type MutableRefObject } from 'react'
import { Icon } from '../components/icons'
import { ItemCard } from '../components/Cards'
import { WindowedBoard } from '../components/Board'
import { useScrollEdges } from '../layout/useScrollEdges'
import { suggestTags } from '../domain/tagSuggest'
import { CanvasLoading, LazyCanvas } from '../components/LazyCanvas'
import { useNotes } from '../data/useNotes'
import type { NoteSource } from '../data/useNotes'
import { isPlaceholder } from '../data/pager'
import type { CanvasDoc, Collection, UIItem, ViewMode } from '../types'
import { Button } from '../ui/Button'
import { PageHeader } from '../ui/PageHeader'
import { Segmented } from '../ui/Segmented'
import { Popover } from '../ui/Popover'

interface SpacesViewProps {
  collections: Collection[]
  createCollection: (name: string, tags: string[]) => Promise<Collection>
  navigate: (next: string) => void
}

// The Spaces landing: a grid of collection cards + an inline "new collection"
// form. A collection's cover is its first few members' thumbnails, resolved
// server-side (collections.ts's withCovers) — no client-side item lookup needed.
export function SpacesView({ collections, createCollection, navigate }: SpacesViewProps) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [tags, setTags] = useState('')

  const submit = async () => {
    const nm = name.trim()
    if (!nm) return
    const tagList = tags
      .split(',')
      .map(t => t.trim())
      .filter(Boolean)
    const c = await createCollection(nm, tagList)
    setName('')
    setTags('')
    setCreating(false)
    navigate(`space:${c.id}`)
  }

  const coverFor = (c: Collection): string | null => {
    for (const it of c.covers ?? []) {
      const src = it.thumb || it.img
      if (src) return src
    }
    return null
  }

  return (
    <div className="spaces-view">
      <PageHeader
        title="Spaces"
        meta={`${collections.length} space${collections.length === 1 ? '' : 's'}`}
        actions={<Button onClick={() => setCreating(v => !v)}>＋ New space</Button>}
      />

      {creating && (
        <div className="space-form">
          <input
            className="space-form-name"
            autoFocus
            placeholder="Space name…"
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') submit()
              if (e.key === 'Escape') setCreating(false)
            }}
          />
          <input
            className="space-form-tags mono"
            placeholder="smart tags (comma-separated, optional)"
            value={tags}
            onChange={e => setTags(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') submit()
              if (e.key === 'Escape') setCreating(false)
            }}
          />
          <Button tone="solid" onClick={submit}>
            Create
          </Button>
        </div>
      )}

      <div className="spaces-scroll">
        {collections.length === 0 && !creating ? (
          <div className="empty">
            <img src="/empty.svg" alt="" width={60} height={60} />
            <p>NO SPACES ADDED YET</p>
          </div>
        ) : (
          <div className="spaces-grid">
            {collections.map(c => {
              const cover = coverFor(c)
              return (
                // The same .tile the Ask thread's citations use — a space
                // card and a citation card are both a cover, a name and a
                // line of small print, so they share one shape.
                <button key={c.id} className="tile space-card" onClick={() => navigate(`space:${c.id}`)}>
                  <div className="tile-media" style={cover ? { backgroundImage: `url(${cover})` } : undefined}>
                    {!cover && <Icon name="spark" size={26} />}
                    {c.tags.length > 0 && (
                      <span className="tile-plate right" title="Smart space">
                        <Icon name="spark" size={11} />
                      </span>
                    )}
                  </div>
                  <div className="tile-cap">
                    <span className="tile-title">{c.name}</span>
                    <span className="tile-meta">
                      {c.count} item{c.count === 1 ? '' : 's'}
                    </span>
                  </div>
                </button>
              )
            })}
          </div>
        )}
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
  saveCanvas: (id: string, doc: CanvasDoc) => void
  deleteCollection: (id: string) => void
  navigate: (next: string) => void
  // App's delete/update handlers also drive the ExpandedView modal, which is
  // mounted at the App level (outside this component) — so a tag edit or
  // delete made from the modal needs a way to reach this collection's own
  // pager too, or the board behind the modal would show stale data until the
  // next full fetch. App hands us its ref; we keep it pointed at our `notes`.
  notesRef?: MutableRefObject<NoteSource | null>
}

export function CollectionView({
  collection,
  view,
  setView,
  deleteItem,
  onExpand,
  collections,
  addToCollection,
  removeFromCollection,
  renameCollection,
  editCollectionTags,
  saveCanvas,
  deleteCollection,
  navigate,
  notesRef,
}: CollectionViewProps) {
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [tagDraft, setTagDraft] = useState('')
  const [addingTag, setAddingTag] = useState(false)
  const [board, setBoard] = useState(false) // false = grid, true = canvas
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

  // Canvas trusts `items` as the full, authoritative membership list (see
  // reconcile in layout/canvas.ts) — mounting it against a partial page would
  // have it silently delete cards/lines for not-yet-loaded members and
  // autosave that damage. Only mount once every page has actually landed.
  const membersReady = notes.ready && !notes.slots.some(isPlaceholder)

  useEffect(() => {
    if (!notesRef) return
    notesRef.current = notes
    return () => {
      notesRef.current = null
    }
  }, [notesRef, notes])

  // Collections are bounded (unlike Everything), so load every page up front
  // rather than fetching on scroll. The board still windows what it MOUNTS —
  // that's the shared layout — this just means it never renders a skeleton.
  useEffect(() => {
    if (notes.total > 0) notes.ensure(0, notes.total - 1)
  }, [notes.total])

  useEffect(() => {
    setArmed(false)
  }, [collection?.id])

  // The rule strip scrolls sideways on phones, so it carries the same fade
  // hints the Everything filter bar does — one module, one behaviour.
  const { ref: ruleRef, className: ruleFade } = useScrollEdges('x', [collection?.tags.length])
  if (!collection) {
    return (
      <div className="collection-view">
        <div className="empty">
          <Icon name="spark" size={40} />
          <p>SPACE NOT FOUND</p>
        </div>
      </div>
    )
  }

  // Board-originated delete/remove: also drop the item from this collection's
  // own pager immediately, rather than waiting on the next fetch.
  const handleDelete = (id: string) => {
    notes.removeLocal(id)
    deleteItem(id)
  }
  const handleRemoveFrom = (cid: string, itemId: string) => {
    if (cid === collection.id) notes.removeLocal(itemId)
    removeFromCollection(cid, itemId)
  }

  const commitName = () => {
    const nm = nameDraft.trim()
    if (nm && nm !== collection.name) renameCollection(collection.id, nm)
    setRenaming(false)
  }
  const startRename = () => {
    setNameDraft(collection.name)
    setRenaming(true)
  }
  const removeTag = (t: string) =>
    editCollectionTags(
      collection.id,
      collection.tags.filter(x => x !== t),
    )
  const del = () => {
    deleteCollection(collection.id)
    navigate('spaces')
  }

  // ---- rule-tag builder ---------------------------------------------------
  // A smart space auto-includes any vault item carrying one of its rule tags,
  // so the picker surfaces every tag in the vault with a live item-count — you
  // pick a rule and see its reach, instead of typing a tag string blind.
  const closeRuleAdd = () => {
    setAddingTag(false)
    setTagDraft('')
  }
  const addRule = (tag: string) => {
    const t = tag.trim().toLowerCase()
    if (t && !collection.tags.includes(t)) editCollectionTags(collection.id, [...collection.tags, t])
    setTagDraft('') // keep the popover open for adding several rules in a row
  }

  // Ranking and the "offer to create this one" rule live in domain/tagSuggest.ts,
  // covered by test/client/tag-suggest.test.ts.
  const q = tagDraft.trim().toLowerCase()
  const { suggestions, canAddNew, poolSize } = suggestTags(collItems, collection.tags, tagDraft)

  return (
    <div className="collection-view">
      {/* The count belongs to the name, so it sits against it. Rename and
          delete are what you do to the SPACE, so they sit on its identity row
          — delete used to be on the view toolbar with only a hairline between
          it and "Canvas", which gave an irreversible action the same weight as
          a view switch. The toolbar is what fills the space on the left and
          how you look at it on the right; density sits at the left of the
          display group so dropping it in canvas mode never moves the view
          switch. */}
      <PageHeader
        lead={
          !renaming &&
          collection.tags.length > 0 && (
            <span className="coll-smart" tabIndex={0} aria-label="Smart space">
              <Icon name="spark" size={13} />
              <span className="coll-smart-pop" role="tooltip">
                <b>Smart space</b>
                Any item tagged with a rule below joins this space automatically.
              </span>
            </span>
          )
        }
        title={
          renaming ? (
            <input
              className="coll-name-input"
              autoFocus
              value={nameDraft}
              onChange={e => setNameDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') commitName()
                if (e.key === 'Escape') setRenaming(false)
              }}
              onBlur={commitName}
            />
          ) : (
            <span className="coll-name" onClick={startRename}>
              {collection.name}
            </span>
          )
        }
        meta={renaming ? null : `${collItems.length} item${collItems.length === 1 ? '' : 's'}`}
        actions={
          !renaming && (
            <>
              <Button size="icon" tone="ghost" title="Rename space" aria-label="Rename space" onClick={startRename}>
                <Icon name="edit" size={14} />
              </Button>
              <button
                className={`coll-del${armed ? ' armed' : ''}`}
                aria-label={armed ? 'Confirm delete space' : 'Delete space'}
                title={armed ? '' : 'Delete space'}
                onClick={() => (armed ? del() : setArmed(true))}
                onBlur={() => setArmed(false)}
                onKeyDown={e => {
                  if (e.key === 'Escape') setArmed(false)
                }}
              >
                {armed ? 'Delete space?' : <Icon name="trash" size={16} />}
              </button>
            </>
          )
        }
        filters={
          <div className={`coll-rule${ruleFade}`} ref={ruleRef}>
            {collection.tags.map(t => (
              <button key={t} className="chip coll-tag" title="Remove rule tag" onClick={() => removeTag(t)}>
                {t}
                <span className="coll-tag-x">×</span>
              </button>
            ))}
            <div className="coll-ruleadd">
              <Popover
                label="Add rule tag"
                open={addingTag}
                onOpenChange={open => (open ? setAddingTag(true) : closeRuleAdd())}
                trigger={<button className={`chip coll-addtag${addingTag ? ' on' : ''}`}>+ rule tag</button>}
              >
                <p className="rulepop-hint">Items tagged with any of these automatically join this space.</p>
                <input
                  className="rulepop-input mono"
                  value={tagDraft}
                  placeholder="filter or add a tag…"
                  onChange={e => setTagDraft(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      const pick = suggestions[0]?.tag ?? q
                      if (pick) addRule(pick)
                    }
                  }}
                />
                <div className="rulepop-list">
                  {suggestions.map(({ tag, count }) => (
                    <button key={tag} className="rulepop-item" onClick={() => addRule(tag)}>
                      <span className="rulepop-tag">{tag}</span>
                      <span className="rulepop-count">
                        {count} item{count === 1 ? '' : 's'}
                      </span>
                    </button>
                  ))}
                  {canAddNew && (
                    <button className="rulepop-item rulepop-new" onClick={() => addRule(q)}>
                      <span className="rulepop-tag">+ add “{q}”</span>
                      <span className="rulepop-count">new</span>
                    </button>
                  )}
                  {!suggestions.length && !canAddNew && (
                    <p className="rulepop-empty">{poolSize ? 'No matching tags' : 'No tags in your vault yet'}</p>
                  )}
                </div>
              </Popover>
            </div>
          </div>
        }
        display={
          <>
            {!board && (
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
            )}
            <Segmented
              label="View mode"
              value={board ? 'canvas' : 'grid'}
              onChange={v => setBoard(v === 'canvas')}
              options={[
                { value: 'grid', label: 'Grid' },
                { value: 'canvas', label: 'Canvas' },
              ]}
            />
          </>
        }
      />

      {board ? (
        membersReady ? (
          <LazyCanvas
            collectionId={collection.id}
            items={collItems}
            doc={collection.canvas}
            onSave={d => saveCanvas(collection.id, d)}
            onExpand={onExpand}
            onRemoveItem={id => handleRemoveFrom(collection.id, id)}
          />
        ) : (
          // Membership isn't fully loaded yet — mounting Canvas now would have
          // it treat not-yet-loaded members as departed and delete their cards
          // (see membersReady above). Wait rather than risk that.
          <CanvasLoading />
        )
      ) : (
        <div className="gal-scroll" ref={scrollRef}>
          {collItems.length === 0 ? (
            <div className="empty">
              <Icon name="spark" size={40} />
              <p>{collection.tags.length > 0 ? 'NO ITEMS MATCH YET' : 'ADD ITEMS FROM EVERYTHING'}</p>
            </div>
          ) : (
            <WindowedBoard
              items={collItems}
              view={view}
              scroller={scrollRef}
              renderItem={it => (
                <ItemCard
                  item={it}
                  onDelete={handleDelete}
                  onExpand={onExpand}
                  collections={collections}
                  onAddTo={addToCollection}
                  onRemoveFrom={handleRemoveFrom}
                />
              )}
            />
          )}
        </div>
      )}
    </div>
  )
}
