// One space's member notes, for Space.tsx: every page loaded up front, in
// membership order. Its own module because Space.tsx sits at its line budget.
import { useEffect, useMemo, type MutableRefObject } from 'react'
import { useNotes, type NoteSource } from './useNotes'
import { isPlaceholder } from './pager'
import type { Collection, UIItem } from '../types'

export function useSpaceMembers(
  collection: Collection | null,
  board: boolean,
  notesRef?: MutableRefObject<NoteSource | null>,
) {
  // Self-fetch this collection's members — enabled only once we know which
  // collection to fetch (must be called unconditionally, before the
  // not-found guard in Space.tsx, per the rules of hooks).
  // Membership changes under this same query — a rule tag's backfill showed
  // none of its members until the space was reopened — so the count refetches.
  // Grid only: the canvas would unmount while they load and lose its view.
  const notes = useNotes({ collection: collection?.id }, !!collection, board ? undefined : collection?.itemIds.length)
  // /api/notes?collection=X just filters by membership — it doesn't preserve
  // itemIds order (newest-added-first). Re-sort here so the board matches the
  // Spaces-grid cover tile, which resolves order from itemIds via withCovers.
  // Anything missing from itemIds (shouldn't normally happen) sorts last.
  // Memoized: the board's packing/window memos key off this array's identity,
  // so rebuilding it every render would re-pack and re-observe on every render.
  const collItems = useMemo(() => {
    const order = new Map((collection?.itemIds ?? []).map((id, i) => [id, i]))
    return notes.slots
      .filter((s): s is UIItem => !isPlaceholder(s))
      .sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity))
  }, [notes.slots, collection?.itemIds])

  // Canvas trusts `items` as the full, authoritative membership list (see
  // reconcile in layout/canvas.ts) — mounting it against a partial page would
  // have it silently delete cards/lines for not-yet-loaded members and
  // autosave that damage. Only mount once every page has actually landed.
  const membersReady = notes.ready && !notes.slots.some(isPlaceholder)

  useEffect(() => {
    if (!notesRef) return
    notesRef.current = notes
    return () => {
      notesRef.current = null
    }
  }, [notesRef, notes])

  // Collections are bounded (unlike Everything), so load every page up front
  // rather than fetching on scroll. The board still windows what it MOUNTS —
  // that's the shared layout — this just means it never renders a skeleton.
  // `ready` too: a refetch of the same total must reload every page after its first.
  useEffect(() => {
    if (notes.total > 0) notes.ensure(0, notes.total - 1)
  }, [notes.total, notes.ready])

  return { notes, collItems, membersReady }
}
