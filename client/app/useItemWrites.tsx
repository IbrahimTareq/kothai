// The writes the app makes to a saved item from somewhere that may be gone by
// the time the answer comes back, and the one bar that answers for them.
//
// A delete waits out an undo window before it reaches the server. Undo is a
// local restore, never a server one: the server's delete takes the note's
// uploaded files and its place in every space and canvas with it, and has no
// way back. So the DELETE is only sent once the window closes. Until then the
// server still has the note, and anything that refetches a board would show it
// again — so a change of `scope` (leaving the board, or changing what it shows)
// sends the delete early and takes the Undo with it. So does leaving the page,
// on a keepalive request that outlives it.
//
// It hands back its own bar. Unlike capture's, a delete's answer cannot sit on
// the button that asked: that button went with its card. The bar is always
// mounted, so the live region exists before it has anything to announce. It
// takes focus when it appears, and its window waits while the pointer or focus
// is on it: focus had fallen to <body> with the card, and the Undo sat after
// the whole board in tab order, out of a keyboard's reach in six seconds
// (test/client/undo-bar). `offer` puts the same Undo on an action already done.
//
// The same holds for any write whose control is gone by the time it fails —
// a tag or note saved from a panel since closed — so `fail` says so here too.
// They had been swallowed, and the screen kept a change the server never took.
// `say` is the unseen half: capture's "Added" is shown on its own button, but
// a fade on a button is never announced (test/client/accessible-names).
//
// While the item view is open the bar lives inside it. That view is a modal:
// everything outside it is hidden from a screen reader, blocked to the pointer
// and out of focus's reach — so an Undo for a tag removed there, drawn in its
// usual place, could be neither seen nor pressed (test/client/undo-bar).
import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type ReactNode,
  type SetStateAction,
} from 'react'
import { createPortal } from 'react-dom'
import { API } from '../data/api'
import type { NoteSource } from '../data/useNotes'
import { Button } from '../ui/Button'
import type { UIItem } from '../types'

const UNDO_MS = 6000

export function useItemWrites(
  notes: NoteSource,
  spaceNotes: MutableRefObject<NoteSource | null>,
  scope: string,
  expanded: UIItem | null,
  setExpanded: Dispatch<SetStateAction<UIItem | null>>,
) {
  const held = useRef<{ item: UIItem; at: number; spaceAt: number } | null>(null)
  // What the bar offers to take back, and what happens when its window closes.
  const [shown, setShown] = useState<{ text: ReactNode; undo: () => void } | null>(null)
  const expire = useRef(() => {})
  const timer = useRef(0)
  const undoRef = useRef<HTMLButtonElement>(null)
  const arm = () => {
    clearTimeout(timer.current)
    timer.current = window.setTimeout(() => expire.current(), UNDO_MS)
  }
  const pause = () => clearTimeout(timer.current)
  useEffect(() => {
    if (shown) undoRef.current?.focus()
  }, [shown])
  // Looked for frame by frame: the dialog is portaled in some renders after the
  // one that opens it, and a single look one frame on found nothing, leaving
  // the bar behind the modal, hidden and unpressable. Bounded, in case it never comes.
  const [host, setHost] = useState<Element | null>(null)
  useEffect(() => {
    setHost(null)
    if (!expanded) return
    let frame = 0
    let tries = 60
    const look = () => {
      const dialog = document.querySelector('[role="dialog"]')
      if (dialog) setHost(dialog)
      else if (tries--) frame = requestAnimationFrame(look)
    }
    look()
    return () => cancelAnimationFrame(frame)
  }, [!!expanded])

  const [notice, setNotice] = useState<string | null>(null)
  const [spoken, setSpoken] = useState('')
  // Cleared first, so saying the same words twice is still a change to announce.
  const say = (words: string) => {
    setSpoken('')
    requestAnimationFrame(() => setSpoken(words))
  }
  const noticeTimer = useRef(0)
  const fail = (message: string) => {
    clearTimeout(noticeTimer.current)
    setNotice(message)
    noticeTimer.current = window.setTimeout(() => setNotice(null), UNDO_MS)
  }

  const commit = () => {
    const h = held.current
    held.current = null
    // After the delete lands, not alongside it: asked any sooner, the server
    // still counts the note.
    if (h)
      API.del(h.item.id)
        .then(notes.refreshFacets)
        .catch(() => {
          // The server still has it, so the board does too.
          notes.restoreLocal(h.item, h.at)
          if (h.spaceAt >= 0) spaceNotes.current?.restoreLocal(h.item, h.spaceAt)
          fail(`Could not delete ${h.item.title || 'that item'}`)
        })
  }
  const close = () => {
    clearTimeout(timer.current)
    setShown(null)
  }
  useEffect(() => {
    window.addEventListener('pagehide', commit)
    return () => {
      window.removeEventListener('pagehide', commit)
      commit()
      close()
    }
  }, [scope])

  // One Undo at a time: a new one sends a held delete and drops the last offer.
  const offer = (text: ReactNode, undo: () => void) => {
    commit()
    expire.current = close
    setShown({
      text,
      undo: () => {
        close()
        undo()
      },
    })
    arm()
  }
  const remove = (it: UIItem) => {
    commit()
    const at = notes.slots.findIndex(s => s.id === it.id)
    const spaceAt = spaceNotes.current?.slots.findIndex(s => s.id === it.id) ?? -1
    notes.removeLocal(it.id)
    spaceNotes.current?.removeLocal(it.id)
    held.current = { item: it, at, spaceAt }
    expire.current = () => {
      commit()
      close()
    }
    setShown({ text: <>Deleted {it.title && <b>{it.title}</b>}</>, undo: () => restore(it.id) })
    arm()
  }
  const restore = (id: string) => {
    const h = held.current
    held.current = null
    close()
    if (!h) return
    if (h.at >= 0) notes.restoreLocal(h.item, h.at)
    if (h.spaceAt >= 0) spaceNotes.current?.restoreLocal(h.item, h.spaceAt)
    // Back onto the card it came from, which the bar had taken focus from, once
    // the restore has rendered it.
    setTimeout(() => document.querySelector<HTMLElement>(`.card-open[href$="${id}"]`)?.focus())
    // The pager drops deltas for a note deleted locally, so one still
    // enriching then missed its result and would have kept its spinner.
    if (h.item.pending)
      API.note(h.item.id)
        .then(fresh => {
          notes.patchLocal(fresh.id, fresh)
          spaceNotes.current?.patchLocal(fresh.id, fresh)
        })
        .catch(() => {})
  }

  // One item's fields, everywhere it is drawn: the board, the open space, the panel.
  const patch = (id: string, p: Partial<UIItem>) => {
    notes.patchLocal(id, p)
    spaceNotes.current?.patchLocal(id, p)
    setExpanded(cur => (cur && cur.id === id ? { ...cur, ...p } : cur))
  }
  // Optimistic tag / note edits; a failed save is put back and said (test/client/silent-writes).
  const update = (id: string, p: { tags?: string[]; mindNote?: string }) => {
    const before = { tags: expanded?.tags, mindNote: expanded?.mindNote } // only the open item edits
    patch(id, p)
    API.update(id, p).catch(() => {
      patch(id, before)
      fail('Could not save that change')
    })
    const gone = (before.tags ?? []).filter(t => !p.tags?.includes(t))
    if (p.tags && gone.length === 1)
      offer(
        <>
          Removed tag <b>{gone[0]}</b>
        </>,
        () => update(id, { tags: before.tags ?? [] }),
      )
  }
  // force a fresh classify/embed pass for one item, discarding its current
  // tags; the server flips `pending` immediately so the existing pending-item
  // UI (already used for fresh saves) shows progress with no new loading state
  const retag = (id: string) =>
    API.retag(id)
      .then(note => patch(id, note))
      .catch(() => fail('Could not start a re-tag'))

  const bar = (
    <>
      <div
        className="undo-bar"
        role="status"
        onMouseEnter={() => shown && pause()}
        onMouseLeave={() => shown && arm()}
        onFocus={() => shown && pause()}
        onBlur={() => shown && arm()}
      >
        {shown ? (
          <>
            <span className="undo-bar-text">{shown.text}</span>
            <Button size="xs" ref={undoRef} onClick={shown.undo}>
              Undo
            </Button>
          </>
        ) : (
          notice && <span className="undo-bar-text">{notice}</span>
        )}
      </div>
      <span className="sr-only" role="status">
        {spoken}
      </span>
    </>
  )
  return { remove, update, retag, patch, offer, fail, say, bar: host ? createPortal(bar, host) : bar }
}
