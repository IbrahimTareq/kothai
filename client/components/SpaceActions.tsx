// What you do to a space as a whole, on its header's identity row. Its own
// module because Space.tsx sits at its line budget.
import { useState } from 'react'
import { Icon } from './icons'
import { Button } from '../ui/Button'
import { Confirm } from '../ui/Confirm'

interface SpaceActionsProps {
  onRename: () => void
  onDelete: () => void
}

export function SpaceActions({ onRename, onDelete }: SpaceActionsProps) {
  const [armed, setArmed] = useState(false)
  if (armed) {
    // Alone while it asks: beside rename, it squeezed a phone's title to 0px.
    return <Confirm inline danger confirmLabel="Delete space" onConfirm={onDelete} onCancel={() => setArmed(false)} />
  }
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
      {/* Arms before it fires: one click on a bare icon should not lose a space. */}
      <Button size="icon" tone="ghost" title="Delete space" aria-label="Delete space" onClick={() => setArmed(true)}>
        <Icon name="trash" size={16} />
      </Button>
    </>
  )
}
