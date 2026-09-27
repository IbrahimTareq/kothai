// What you do to a space as a whole, on its header's identity row: rename it,
// start a space inside it, move it under another, delete it. Its own module
// because Space.tsx sits at its line budget.
import { useState } from 'react'
import { Icon } from './icons'
import { useDemo } from './Demo'
import { moveTargets, spaceLabel } from '../domain/spaceTree'
import type { Collection } from '../types'
import { Button } from '../ui/Button'
import { Confirm } from '../ui/Confirm'
import { Menu } from '../ui/Menu'

interface SpaceActionsProps {
  collection: Collection
  collections: Collection[]
  onRename: () => void
  onNewSub: () => void
  onMove: (parentId: string | null) => void
  onDelete: () => void
}

export function SpaceActions({ collection, collections, onRename, onNewSub, onMove, onDelete }: SpaceActionsProps) {
  const [armed, setArmed] = useState(false)
  // On the demo a visitor nests only inside spaces they made (routes/collections.ts),
  // so only those are offered, and a sub-space spends the daily quota as any space does.
  const demoState = useDemo()
  const demo = !!demoState
  if (armed) {
    // Alone while it asks: beside rename, it squeezed a phone's title to 0px.
    return <Confirm inline danger confirmLabel="Delete space" onConfirm={onDelete} onCancel={() => setArmed(false)} />
  }
  const moves = [
    ...(collection.parentId ? [{ key: 'top', label: 'Top level', onSelect: () => onMove(null) }] : []),
    ...moveTargets(collections, collection.id)
      .filter(c => !demo || !!c.visitor)
      .map(c => ({ key: c.id, label: spaceLabel(collections, c.id), onSelect: () => onMove(c.id) })),
  ]
  return (
    <>
      <Button
        className="coll-rename"
        size="icon"
        tone="ghost"
        title="Rename space"
        aria-label="Rename space"
        onClick={onRename}
      >
        <Icon name="edit" size={14} />
      </Button>
      <Button
        size="icon"
        tone="ghost"
        title={demoState?.spacesLeft === 0 ? 'No more spaces today' : 'New space inside this one'}
        aria-label="New sub-space"
        disabled={demoState?.spacesLeft === 0}
        onClick={onNewSub}
      >
        <Icon name="plus" size={14} />
      </Button>
      <Menu
        title="Move to"
        empty="No other spaces"
        trigger={
          <Button size="icon" tone="ghost" title="Move space" aria-label="Move space">
            <Icon name="spaces" size={14} />
          </Button>
        }
        items={moves}
      />
      {/* Arms before it fires: one click on a bare icon should not lose a space. */}
      <Button size="icon" tone="ghost" title="Delete space" aria-label="Delete space" onClick={() => setArmed(true)}>
        <Icon name="trash" size={16} />
      </Button>
    </>
  )
}
