// A delete that waits out an undo window before it reaches the server.
//
// Undo is a local restore, never a server one: the server's delete takes the
// note's uploaded files and its place in every space and canvas with it, and
// has no way back. So the DELETE is only sent once the window closes. Until
// then the server still has the note, and anything that refetches a board
// would show it again — so a change of `scope` (leaving the board, or changing
// what it shows) sends the delete early and takes the Undo with it. So does
// leaving the page, on a keepalive request that outlives it.
//
// It hands back its own bar. Unlike capture's, a delete's answer cannot sit on
// the button that asked: that button went with its card. The bar is always
// mounted, so the live region exists before it has anything to announce.
import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { API } from '../data/api'
import type { NoteSource } from '../data/useNotes'
import { Button } from '../ui/Button'
import type { UIItem } from '../types'

const UNDO_MS = 6000

export function useHeldDelete(notes: NoteSource, spaceNotes: MutableRefObject<NoteSource | null>, scope: string) {
  const held = useRef<{ item: UIItem; at: number; spaceAt: number; timer: number } | null>(null)
  const [item, setItem] = useState<UIItem | null>(null)

  const take = () => {
    const h = held.current
    if (h) clearTimeout(h.timer)
    held.current = null
    setItem(null)
    return h
  }
  const commit = () => {
    const h = take()
    // After the delete lands, not alongside it: asked any sooner, the server
    // still counts the note.
    if (h)
      API.del(h.item.id)
        .then(notes.refreshFacets)
        .catch(() => {})
  }
  useEffect(() => {
    window.addEventListener('pagehide', commit)
    return () => {
      window.removeEventListener('pagehide', commit)
      commit()
    }
  }, [scope])

  // One Undo at a time: a second delete sends the first.
  const remove = (it: UIItem) => {
    commit()
    const at = notes.slots.findIndex(s => s.id === it.id)
    const spaceAt = spaceNotes.current?.slots.findIndex(s => s.id === it.id) ?? -1
    notes.removeLocal(it.id)
    spaceNotes.current?.removeLocal(it.id)
    held.current = { item: it, at, spaceAt, timer: window.setTimeout(commit, UNDO_MS) }
    setItem(it)
  }
  const undo = () => {
    const h = take()
    if (!h) return
    if (h.at >= 0) notes.restoreLocal(h.item, h.at)
    if (h.spaceAt >= 0) spaceNotes.current?.restoreLocal(h.item, h.spaceAt)
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
  const bar = (
    <div className="undo-bar" role="status">
      {item && (
        <>
          <span className="undo-bar-text">Deleted {item.title && <b>{item.title}</b>}</span>
          <Button size="xs" onClick={undo}>
            Undo
          </Button>
        </>
      )}
    </div>
  )
  return { remove, bar }
}
