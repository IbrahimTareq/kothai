// Chats.tsx — a row in the Ask page's saved-conversation list. Reading,
// renaming and confirming a delete all happen in place: the list is dense, and
// a modal for either would cost more attention than the action is worth.
import { useEffect, useRef, useState } from 'react'
import { Icon } from './icons'
import { relTime } from '../util/format'
import type { ChatSummary } from '../types'

interface RowProps {
  chat: ChatSummary
  active: boolean
  open: (c: ChatSummary) => void
  rename: (id: string, title: string) => void
  remove: (id: string) => void
}

// A row has three states: reading, renaming, and confirming a delete. Renaming
// and deleting both happen in place — a conversation list is dense, and a
// modal for either would cost more attention than the action is worth.
export function ChatRow({ chat, active, open, rename, remove }: RowProps) {
  const [mode, setMode] = useState<'idle' | 'rename' | 'confirm'>('idle')
  const [draft, setDraft] = useState(chat.title)
  const inputRef = useRef<HTMLInputElement>(null)
  // Leaving the input fires blur as well as whatever key caused it, and both
  // want to commit. This makes the second one a no-op.
  const settled = useRef(false)

  useEffect(() => { if (mode === 'rename') { settled.current = false; inputRef.current?.select() } }, [mode])

  const commit = () => {
    if (settled.current) return
    settled.current = true
    const next = draft.trim()
    if (next && next !== chat.title) rename(chat.id, next)
    setMode('idle')
  }
  const cancel = () => { settled.current = true; setDraft(chat.title); setMode('idle') }

  if (mode === 'rename') {
    return (
      <div className="chat-row renaming">
        <Icon name="ask" size={14} />
        <input ref={inputRef} className="chat-rename" value={draft} autoFocus
          aria-label={'Rename chat: ' + chat.title}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            // Escape belongs to the rename here, not to the drawer listening
            // above for the same key — without this, cancelling a rename
            // closed the whole panel with it.
            if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); e.stopPropagation() }
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') cancel()
          }} />
      </div>
    )
  }

  if (mode === 'confirm') {
    return (
      <div className="chat-row confirming">
        <Icon name="trash" size={14} />
        <span className="chat-title">Delete “{chat.title}”?</span>
        <button className="chat-confirm danger" onClick={() => remove(chat.id)}>Delete</button>
        <button className="chat-confirm" onClick={() => setMode('idle')}>Cancel</button>
      </div>
    )
  }

  return (
    <div className={'chat-row' + (active ? ' active' : '')} role="button" tabIndex={0}
      onClick={() => open(chat)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(chat) } }}>
      <Icon name="ask" size={14} />
      <span className="chat-title">{chat.title}</span>
      <span className="chat-meta mono dim">{chat.questions} Q · {relTime(Date.parse(chat.updatedAt))}</span>
      <button className="card-del" aria-label={'Rename chat: ' + chat.title} title="Rename"
        onClick={(e) => { e.stopPropagation(); setDraft(chat.title); setMode('rename') }}>
        <Icon name="retag" size={13} />
      </button>
      <button className="card-del" aria-label={'Delete chat: ' + chat.title} title="Delete"
        onClick={(e) => { e.stopPropagation(); setMode('confirm') }}>
        <Icon name="trash" size={13} />
      </button>
    </div>
  )
}
