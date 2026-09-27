// Space.tsx — one space: its name (rename, nest, move, delete), its
// description, the smart rule tags that fill it, its sub-spaces, and its items
// as a grid or a canvas. The landing that lists every space is Spaces.tsx.
import { useState, useRef, type MutableRefObject } from 'react'
import { Icon } from '../components/icons'
import { ItemCard } from '../components/Cards'
import { WindowedBoard } from '../components/Board'
import { useScrollEdges } from '../layout/useScrollEdges'
import { suggestTags } from '../domain/tagSuggest'
import { CanvasLoading, LazyCanvas } from '../components/LazyCanvas'
import type { NoteSource } from '../data/useNotes'
import { useSpaceMembers } from '../data/useSpaceMembers'
import type { CanvasDoc, Collection, UIItem, ViewMode } from '../types'
import { Button } from '../ui/Button'
import { PageHeader } from '../ui/PageHeader'
import { Chip } from '../ui/Chip'
import { Segmented } from '../ui/Segmented'
import { Popover } from '../ui/Popover'
import { Input } from '../ui/Input'
import { useDemo } from '../components/Demo'
import { Tooltip } from '../ui/Tooltip'
import { SpaceDescription } from '../components/SpaceDescription'
import { SpaceActions } from '../components/SpaceActions'
import { SpaceGrid } from './Spaces'
import { spacePath } from '../domain/spaceTree'

interface CollectionViewProps {
  collection: Collection | null
  view: ViewMode
  setView: (v: ViewMode) => void
  deleteItem: (item: UIItem) => void
  onExpand: (item: UIItem) => void
  collections: Collection[]
  addToCollection: (cid: string, itemId: string) => void
  removeFromCollection: (cid: string, itemId: string) => void
  renameCollection: (id: string, name: string) => void
  describeCollection: (id: string, description: string) => void
  editCollectionTags: (id: string, tags: string[]) => void
  saveCanvas: (id: string, doc: CanvasDoc) => void
  deleteCollection: (id: string) => void
  createCollection: (name: string, tags: string[], parentId?: string) => Promise<Collection>
  moveCollection: (id: string, parentId: string | null) => void
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
  describeCollection,
  editCollectionTags,
  saveCanvas,
  deleteCollection,
  createCollection,
  moveCollection,
  navigate,
  notesRef,
}: CollectionViewProps) {
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [tagDraft, setTagDraft] = useState('')
  const [addingTag, setAddingTag] = useState(false)
  const [board, setBoard] = useState(false) // false = grid, true = canvas
  const [creating, setCreating] = useState(false) // a sub-space's draft card is showing
  const scrollRef = useRef<HTMLDivElement>(null)

  const { notes, collItems, membersReady } = useSpaceMembers(collection, board, notesRef)

  // The rule strip scrolls sideways on phones, so it carries the same fade
  // hints the Everything filter bar does — one module, one behaviour.
  const { ref: ruleRef, className: ruleFade } = useScrollEdges('x', [collection?.tags.length])
  // On the demo a shared space's canvas is the visitor's to arrange but not to
  // keep: the server refuses its writes (server/routes/demo.ts), so none are
  // sent. It was hidden outright before, and a visitor never saw a canvas.
  const keeps = !useDemo() || !!collection?.visitor
  if (!collection) {
    return (
      <div className="collection-view">
        <div className="empty">
          <Icon name="spark" size={40} />
          <p>Space not found</p>
        </div>
      </div>
    )
  }

  // Board-originated remove: also drop the item from this collection's own
  // pager immediately, rather than waiting on the next fetch. A delete needs
  // no such step — App's deleteItem reaches this pager through notesRef, and
  // has to find the card still in it to put it back on Undo.
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
  const children = collections.filter(c => c.parentId === collection.id)
  // Into the new space, as from the landing: it is empty, and filling it is next.
  const createSub = async (name: string) => {
    const c = await createCollection(name, [], collection.id)
    setCreating(false)
    navigate(`space:${c.id}`)
  }
  // Sub-spaces show in grid mode only (the canvas has no card for one), so
  // starting one leaves the canvas.
  const newSub = () => {
    setBoard(false)
    setCreating(true)
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
  // Column count and grid-or-canvas are ways of looking at items, so an empty
  // space shows neither, as Everything does. A canvas can hold text and frames
  // with no members, though: one that exists, or is open, keeps its switch.
  const showDisplay = board || collection.count > 0 || !!collection.canvas?.nodes.length
  const { suggestions, canAddNew, poolSize } = suggestTags(collItems, collection.tags, tagDraft)

  return (
    <div className="collection-view" data-mine={collection.visitor ? '' : undefined}>
      {/* The count belongs to the name, so it sits against it. Rename, nest,
          move and delete are what you do to the SPACE, so they sit on its
          identity row — delete used to be on the view toolbar with only a
          hairline between it and "Canvas", which gave an irreversible action
          the same weight as a view switch. The toolbar is what fills the space
          on the left and how you look at it on the right; density sits at the
          left of the display group so dropping it in canvas mode never moves
          the view switch. */}
      <PageHeader
        // Drawn on every space, top level included, so the title sits at one
        // height whichever space is open.
        trail={[
          { key: 'spaces', label: 'Spaces', onClick: () => navigate('spaces') },
          ...spacePath(collections, collection.id)
            .slice(0, -1)
            .map(s => ({ key: s.id, label: s.name, onClick: () => navigate(`space:${s.id}`) })),
        ]}
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
          renaming ? null : (
            <SpaceActions
              collection={collection}
              collections={collections}
              onRename={startRename}
              onNewSub={newSub}
              onMove={parentId => moveCollection(collection.id, parentId)}
              onDelete={del}
            />
          )
        }
        summary={<SpaceDescription text={collection.description} onSave={d => describeCollection(collection.id, d)} />}
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
                  className="rulepop-input"
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
          showDisplay && (
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
          )
        }
      />

      {board ? (
        membersReady ? (
          <LazyCanvas
            collectionId={collection.id}
            items={collItems}
            doc={collection.canvas}
            onSave={d => keeps && saveCanvas(collection.id, d)}
            onExpand={onExpand}
            onRemoveItem={id => keeps && handleRemoveFrom(collection.id, id)}
          />
        ) : (
          // Membership isn't fully loaded yet — mounting Canvas now would have
          // it treat not-yet-loaded members as departed and delete their cards
          // (see membersReady above). Wait rather than risk that.
          <CanvasLoading />
        )
      ) : (
        <div className="gal-scroll" ref={scrollRef}>
          {/* Sub-spaces first, like folders above files. The board under them
              windows from where it starts (components/Board.tsx). */}
          {(children.length > 0 || creating) && (
            <SpaceGrid
              spaces={children}
              all={collections}
              creating={creating}
              onCreate={createSub}
              onCancel={() => setCreating(false)}
              navigate={navigate}
            />
          )}
          {collItems.length > 0 ? (
            <WindowedBoard
              items={collItems}
              view={view}
              scroller={scrollRef}
              ready={notes.ready}
              renderItem={it => (
                <ItemCard
                  item={it}
                  onDelete={deleteItem}
                  onExpand={onExpand}
                  collections={collections}
                  onAddTo={addToCollection}
                  onRemoveFrom={handleRemoveFrom}
                />
              )}
            />
          ) : (
            // A space holding only sub-spaces is not empty, so it shows them
            // without the prompt to fill it.
            children.length === 0 &&
            !creating && (
              // Not the spark: that marks a smart space, and this may not be one.
              // The button is the way to fill it, which the message only named.
              <div className="empty">
                <Icon name="spaces" size={40} />
                <p>{collection.tags.length > 0 ? 'NO ITEMS MATCH YET' : 'NO ITEMS YET'}</p>
                <Button className="coll-browse" onClick={() => navigate('all')}>
                  Browse Everything
                </Button>
              </div>
            )
          )}
        </div>
      )}
    </div>
  )
}
