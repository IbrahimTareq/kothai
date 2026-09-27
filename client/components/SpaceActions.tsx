// What you do to a space as a whole, on its header's identity row: start a
// space inside it, and from its "…" menu rename it, move it under another, or
// delete it. Its own module because Space.tsx sits at its line budget.
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
  const [moving, setMoving] = useState(false) // the menu is showing where the space can go
  // On the demo a visitor nests only inside spaces they made (routes/collections.ts),
  // so only those are offered, and a sub-space spends the daily quota as any space does.
  const demoState = useDemo()
  const demo = !!demoState
  if (armed) {
    // Alone while it asks: beside the other actions, it squeezed a phone's title to 0px.
    return <Confirm inline danger confirmLabel="Delete space" onConfirm={onDelete} onCancel={() => setArmed(false)} />
  }
  const moves = [
    ...(collection.parentId ? [{ key: 'top', label: 'Top level', onSelect: () => onMove(null) }] : []),
    ...moveTargets(collections, collection.id)
      .filter(c => !demo || !!c.visitor)
      .map(c => ({ key: c.id, label: spaceLabel(collections, c.id), onSelect: () => onMove(c.id) })),
  ]
  const actions = [
    { key: 'rename', label: 'Rename', onSelect: onRename },
    ...(moves.length
      ? [{ key: 'move', label: 'Move to…', trailing: '›', keepOpen: true, onSelect: () => setMoving(true) }]
      : []),
    // Arms before it fires: one pick from a menu should not lose a space.
    { key: 'delete', label: 'Delete', onSelect: () => setArmed(true) },
  ]
  return (
    <>
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
      {/* One menu rather than an icon each: four icons beside the name left a
          long one about 79px on a phone. */}
      <Menu
        title={moving ? 'Move to' : undefined}
        empty="No other spaces"
        onOpenChange={open => !open && setMoving(false)}
        trigger={
          <Button size="icon" tone="ghost" title="More" aria-label="Space actions">
            <Icon name="more" size={16} />
          </Button>
        }
        items={
          moving
            ? [{ key: 'back', label: '‹ Back', keepOpen: true, onSelect: () => setMoving(false) }, ...moves]
            : actions
        }
      />
    </>
  )
}
