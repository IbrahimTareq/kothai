// Spaces.tsx — the Spaces landing: a card for every space, and the inline
// form that makes a new one. One space's own view is Space.tsx.
import { useState } from 'react'
import { Icon } from '../components/icons'
import type { Collection } from '../types'
import { Button } from '../ui/Button'
import { PageHeader } from '../ui/PageHeader'
import { Input } from '../ui/Input'

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
    for (const it of c.covers ?? []) if (it.thumb) return it.thumb
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
          <Input
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
          <Input
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
