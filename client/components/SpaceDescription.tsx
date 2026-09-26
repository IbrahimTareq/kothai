// A space's description, under its name: what the space is for. Click it to
// edit, as the name is. Its own module because Space.tsx sits at its line budget.
import { useState } from 'react'
import { Button } from '../ui/Button'
import { Textarea } from '../ui/Input'

export function SpaceDescription({ text = '', onSave }: { text?: string; onSave: (text: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  const start = () => {
    setDraft(text)
    setEditing(true)
  }
  const commit = () => {
    if (draft.trim() !== text) onSave(draft.trim())
    setEditing(false)
  }

  if (editing) {
    return (
      <Textarea
        compact
        autoFocus
        rows={2}
        maxLength={500}
        className="coll-desc-input"
        aria-label="Space description"
        placeholder="What is this space for?"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          // Enter saves, as it does for the name; Shift+Enter is the line break.
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            commit()
          }
          if (e.key === 'Escape') setEditing(false)
        }}
        onBlur={commit}
      />
    )
  }
  return text ? (
    <p className="coll-desc" onClick={start}>
      {text}
    </p>
  ) : (
    <Button size="xs" tone="ghost" className="coll-desc-add" onClick={start}>
      Add a description
    </Button>
  )
}
