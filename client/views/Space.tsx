// Space.tsx — one space: its name (rename, delete), the smart rule tags that
// fill it, and its items as a grid or a canvas. The landing that lists every
// space is Spaces.tsx.
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
import { Chip } from '../ui/Chip'
import { Segmented } from '../ui/Segmented'
import { Popover } from '../ui/Popover'
import { Input } from '../ui/Input'
import { Tooltip } from '../ui/Tooltip'
import { Confirm } from '../ui/Confirm'

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
  const arm = () => setArmed(true)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Self-fetch this collection's members — enabled only once we know which
  // collection to fetch (must be called unconditionally, before the
  // not-found guard below, per the rules of hooks).
  // Membership changes under this same query — a rule tag's backfill showed
  // none of its members until the space was reopened — so the count refetches.
  // Grid only: the canvas would unmount while they load and lose its view.
  const notes = useNotes({ collection: collection?.id }, !!collection, board ? undefined : collection?.itemIds.length)
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
  // `ready` too: a refetch of the same total must reload every page after its first.
  useEffect(() => {
    if (notes.total > 0) notes.ensure(0, notes.total - 1)
  }, [notes.total, notes.ready])

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
    <div className="collection-view" data-mine={collection.visitor ? '' : undefined}>
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
            <Tooltip
              label="Smart space"
              detail="Any item carrying one of the tags below joins this space automatically."
              side="bottom"
            >
              <span className="coll-smart" tabIndex={0} aria-label="Smart space">
                <Icon name="spark" size={13} />
              </span>
            </Tooltip>
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
          renaming ? null : armed ? (
            // Alone while it asks: beside rename, it squeezed a phone's title to 0px.
            <Confirm inline danger confirmLabel="Delete space" onConfirm={del} onCancel={() => setArmed(false)} />
          ) : (
            <>
              <Button
                className="coll-rename"
                size="icon"
                tone="ghost"
                title="Rename space"
                aria-label="Rename space"
                onClick={startRename}
              >
                <Icon name="edit" size={14} />
              </Button>
              {/* Arms before it fires: one click on a bare icon should not lose a space. */}
              <Button size="icon" tone="ghost" title="Delete space" aria-label="Delete space" onClick={arm}>
                <Icon name="trash" size={16} />
              </Button>
            </>
          )
        }
        filters={
          <div className={`coll-rule${ruleFade}`} ref={ruleRef}>
            {/* Named, because this row sits exactly where Everything's filters
                do and draws the same pills — but a click here stops a tag
                filling the space, where a click there only narrows the view. */}
            {collection.tags.length > 0 && <span className="eyebrow coll-rule-label">Auto-adds</span>}
            {collection.tags.map(t => (
              <Chip removable key={t} title="Stop auto-adding this tag" onClick={() => removeTag(t)}>
                {t}
              </Chip>
            ))}
            <div className="coll-ruleadd">
              <Popover
                label="Auto-add a tag"
                open={addingTag}
                onOpenChange={open => (open ? setAddingTag(true) : closeRuleAdd())}
                trigger={<Chip add>{collection.tags.length ? '+ Tag' : '+ Auto-add by tag'}</Chip>}
              >
                <p className="rulepop-hint">Items tagged with any of these automatically join this space.</p>
                <Input
                  compact
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
                    <button key={tag} className="menu-item" onClick={() => addRule(tag)}>
                      <span className="menu-label">{tag}</span>
                      <span className="menu-trailing rulepop-count">
                        {count} item{count === 1 ? '' : 's'}
                      </span>
                    </button>
                  ))}
                  {canAddNew && (
                    <button className="menu-item rulepop-new" onClick={() => addRule(q)}>
                      <span className="menu-label">+ add “{q}”</span>
                      <span className="menu-trailing rulepop-count">new</span>
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
            // Not the spark: that marks a smart space, and this may not be one.
            // The button is the way to fill it, which the message only named.
            <div className="empty">
              <Icon name="spaces" size={40} />
              <p>{collection.tags.length > 0 ? 'NO ITEMS MATCH YET' : 'NO ITEMS YET'}</p>
              <Button className="coll-browse" onClick={() => navigate('all')}>
                Browse Everything
              </Button>
            </div>
          ) : (
            <WindowedBoard
              items={collItems}
              view={view}
              scroller={scrollRef}
              ready={notes.ready}
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
