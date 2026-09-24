import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { Button } from './Button'
import { Input } from './Input'

// The second step of an action you cannot take back. Six were built by hand:
// three boxed panels in Settings, an inline pair per model file and per chat,
// and a space's bin that turned into "Delete space?" and disarmed on blur. Two
// cancelled on Escape, one moved focus to the decision, and the chat row's
// confirm was an outline button where every other one was filled.
//
// One shape now: a question, a filled confirm, and Cancel. When it appears,
// focus moves to the decision — the confirm, or the field when a word must be
// typed first — and Escape cancels, stopping there so the drawer or dialog it
// sits in does not close with it.
//
//   inline   in a row or header, no box; otherwise the boxed panel
//   danger   destroys something: red box, red confirm
//   guard    a word to type before confirm enables (erasing everything)
//   compact  xs buttons, for the chat row whose height is load-bearing
export function Confirm({
  question,
  confirmLabel,
  busyLabel,
  busy,
  danger,
  guard,
  inline,
  compact,
  className,
  onConfirm,
  onCancel,
}: {
  question?: ReactNode
  confirmLabel: string
  busyLabel?: string
  busy?: boolean
  danger?: boolean
  guard?: string
  inline?: boolean
  compact?: boolean
  className?: string
  onConfirm: () => void
  onCancel: () => void
}) {
  const [typed, setTyped] = useState('')
  const confirmRef = useRef<HTMLButtonElement>(null)
  const guardRef = useRef<HTMLInputElement>(null)
  const guardId = useId()
  useEffect(() => (guard ? guardRef : confirmRef).current?.focus(), [])

  const ready = !busy && (!guard || typed === guard)
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || busy) return
    e.preventDefault()
    e.stopPropagation()
    onCancel()
  }
  const size = compact ? 'xs' : undefined
  const cls = ['confirm', inline && 'confirm--inline', danger && 'confirm--danger', className]

  return (
    <div className={cls.filter(Boolean).join(' ')} role="group" onKeyDown={onKeyDown}>
      {question && (
        <label className="confirm-q" htmlFor={guard ? guardId : undefined}>
          {question}
        </label>
      )}
      <div className="confirm-actions">
        {guard && (
          <Input
            danger
            ref={guardRef}
            id={guardId}
            className="confirm-guard mono"
            value={typed}
            disabled={busy}
            spellCheck={false}
            autoComplete="off"
            placeholder={guard}
            onChange={e => setTyped(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && ready && onConfirm()}
          />
        )}
        <Button ref={confirmRef} size={size} tone="solid" danger={danger} disabled={!ready} onClick={onConfirm}>
          {busy && busyLabel ? busyLabel : confirmLabel}
        </Button>
        <Button size={size} disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
