// Spaces.tsx — the Spaces landing: a card for every top-level space, and the
// draft card that makes a new one. One space's own view is Space.tsx, which
// draws the spaces inside it with the same SpaceGrid.
import { useState } from 'react'
import { Icon } from '../components/icons'
import type { Collection, UIItem } from '../types'
import { Button } from '../ui/Button'
import { PageHeader } from '../ui/PageHeader'
import { Input } from '../ui/Input'
import { useDemo } from '../components/Demo'

interface SpacesViewProps {
  collections: Collection[]
  createCollection: (name: string, tags: string[]) => Promise<Collection>
  navigate: (next: string) => void
}

// A space's cover is a set, not a picture: its newest three members (withCovers
// in server/data/collections.ts), one large beside two stacked. One thumbnail
// made a space look like an item, and threw away two covers the server sent.
function SpaceCover({ covers = [] }: { covers?: UIItem[] }) {
  return (
    <div className={`tile-media${covers.length ? ' space-cover' : ''}`} data-n={covers.length}>
      {covers.length ? (
        covers.map(it => (
          <div key={it.id} className="space-cover-cell">
            {it.thumb ? (
              <img src={it.thumb} alt="" loading="lazy" />
            ) : (
              <span className="tile-excerpt">{it.title || it.note}</span>
            )}
          </div>
        ))
      ) : (
        <Icon name="spaces" size={22} />
      )}
    </div>
  )
}

interface SpaceGridProps {
  spaces: Collection[] // the cards to draw
  all: Collection[] // every space, to count the ones inside each card's
  creating: boolean
  onCreate: (name: string) => Promise<void>
  onCancel: () => void
  navigate: (next: string) => void
}

// A grid of space cards, led by the draft card while one is being named. The
// landing draws the top level with it; a space draws the spaces inside it. A
// new space asks only for a name: rules are added inside it, from the picker
// that shows each tag's reach — the comma-separated field this replaced was
// typed blind.
export function SpaceGrid({ spaces, all, creating, onCreate, onCancel, navigate }: SpaceGridProps) {
  const [name, setName] = useState('')
  const cancel = () => {
    setName('')
    onCancel()
  }
  const submit = async () => {
    const nm = name.trim()
    if (!nm) return
    await onCreate(nm)
    setName('')
  }
  return (
    <div className="spaces-grid">
      {creating && (
        // Dashed like every other "add one" slot (.chip--add, the item
        // view's add-to-space): a place for a space, not yet a space.
        <div className="tile space-card space-draft">
          <SpaceCover />
          <div className="tile-cap">
            <Input
              compact
              autoFocus
              aria-label="Space name"
              placeholder="Name this space"
              enterKeyHint="done"
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') submit()
                if (e.key === 'Escape') cancel()
              }}
              onBlur={() => !name.trim() && cancel()}
            />
          </div>
        </div>
      )}
      {spaces.map(c => {
        const inside = all.filter(s => s.parentId === c.id).length
        return (
          // The same .tile the Ask thread's citations use — a space
          // card and a citation card are both a cover, a name and a
          // line of small print, so they share one shape.
          <button key={c.id} className="tile space-card" onClick={() => navigate(`space:${c.id}`)}>
            <SpaceCover covers={c.covers} />
            <div className="tile-cap">
              <span className="tile-title">{c.name}</span>
              {/* The smart mark sits in the small print, not on the
                  cover: a badge over a photograph was the loudest thing
                  on the card and said the least. */}
              <span className="tile-meta space-meta">
                {c.tags.length > 0 && (
                  <span className="space-smart" title="Smart space">
                    <Icon name="spark" size={10} />
                  </span>
                )}
                {inside > 0 && `${inside} space${inside === 1 ? '' : 's'} · `}
                {c.count} item{c.count === 1 ? '' : 's'}
              </span>
            </div>
          </button>
        )
      })}
    </div>
  )
}

// The Spaces landing: the top level only. A space inside another is reached
// through it, so listing it here too would show it twice.
export function SpacesView({ collections, createCollection, navigate }: SpacesViewProps) {
  const [creating, setCreating] = useState(false)
  const spent = useDemo()?.spacesLeft === 0 // the demo's daily few (server/routes/demo.ts)
  const roots = collections.filter(c => !c.parentId)

  const create = async (name: string) => {
    const c = await createCollection(name, [])
    setCreating(false)
    navigate(`space:${c.id}`)
  }
  // The plus is the icon Capture and the item view's "Add to space" draw; a
  // full-width ＋ character sat on a different baseline beside them.
  const newSpace = (
    <Button disabled={spent} onClick={() => setCreating(true)}>
      {spent ? (
        'No more spaces today'
      ) : (
        <>
          <Icon name="plus" size={14} /> New space
        </>
      )}
    </Button>
  )

  return (
    <div className="spaces-view">
      <PageHeader title="Spaces" meta={`${roots.length} space${roots.length === 1 ? '' : 's'}`} actions={newSpace} />

      <div className="spaces-scroll">
        {roots.length === 0 && !creating ? (
          <div className="empty">
            <img src="/empty.svg" alt="" width={60} height={60} />
            <p>NO SPACES YET</p>
            {newSpace}
          </div>
        ) : (
          <SpaceGrid
            spaces={roots}
            all={collections}
            creating={creating}
            onCreate={create}
            onCancel={() => setCreating(false)}
            navigate={navigate}
          />
        )}
      </div>
    </div>
  )
}
