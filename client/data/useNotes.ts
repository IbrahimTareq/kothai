// React wrapper around NotePager: owns fetching, query resets, delta
// polling while enrichment lands server-side, and (later) thumbnail
// prioritization. All list state for note-grid views flows through here.
import { useEffect, useMemo, useRef, useState } from 'react'
import { API, mapNote } from './api'
import { NotePager, PAGE, isPlaceholder, matchesLocal } from './pager'
import type { PagerQuery, Slot } from './pager'
import type { UIItem } from '../types'

const SEARCH_DEBOUNCE_MS = 150

export interface NoteSource {
  slots: Slot[]
  total: number
  facets: { types: Record<string, number>; sources: Record<string, number>; unavailable?: number }
  ready: boolean
  ensure: (firstIndex: number, lastIndex: number) => void
  insertLocal: (item: UIItem) => void
  removeLocal: (id: string) => void
  patchLocal: (id: string, patch: Partial<UIItem>) => void
  refreshFacets: () => void
}

// `members` is for results that change server-side under an unchanged query —
// a space's membership. A new count refetches; undefined holds off until the
// caller can take a refetch again.
export function useNotes(query: PagerQuery, enabled = true, members?: number): NoteSource {
  const pager = useRef(new NotePager())
  // Ids already pinged this session — avoids re-sending a priority hint for
  // a note the user has already scrolled past once (server-side promote is
  // a no-op once it's fetched or no longer queued, but there's no reason to
  // keep asking). Not query-scoped: a thumbless id means the same thing
  // (still unfetched) no matter which filtered view it was seen from.
  const sentPriority = useRef(new Set<string>())
  const priorityTimer = useRef<number | undefined>(undefined)
  // ensure() is called imperatively from scroll handlers, not from an
  // effect, so its debounced priorityTimer has no natural useEffect cleanup
  // to hook into. This ref-guard is the minimal fix: it stops the debounced
  // callback from firing API.prioritize after unmount, without restructuring
  // ensure's imperative-call design.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const [, bump] = useState(0)
  const [ready, setReady] = useState(false)
  const rerender = () => bump(v => v + 1)
  // Serialize the query so effect deps compare by value, and debounce q.
  const [live, setLive] = useState(query)
  const key = JSON.stringify(live)
  useEffect(() => {
    if (JSON.stringify(query) === key) return
    const id = window.setTimeout(() => setLive(query), query.q !== live.q ? SEARCH_DEBOUNCE_MS : 0)
    return () => clearTimeout(id)
  })

  const fetchPage = (offset: number) => {
    const q = JSON.parse(key) as PagerQuery
    const gen = pager.current.generation
    pager.current.markInflight(offset)
    API.page({ offset, limit: PAGE, ...q })
      .then(p => {
        if (!pager.current.applyPage(p, gen)) return
        setReady(true)
        rerender()
      })
      .catch(() => {
        // A superseded query's failure must not clear the current query's
        // in-flight mark at the same offset.
        if (gen === pager.current.generation) pager.current.clearInflight(offset) // next scroll tick retries
      })
  }

  // Read at call time: App calls refreshFacets once a delete lands, from a
  // closure that may predate a search typed meanwhile.
  const liveKey = useRef(key)
  liveKey.current = key
  // One note is the smallest page the server will send; only its facets are used.
  const refreshFacets = () => {
    const req = pager.current.requestFacets()
    API.page({ offset: 0, limit: 1, ...(JSON.parse(liveKey.current) as PagerQuery) })
      .then(p => {
        if (pager.current.applyFacets(p.facets, req)) rerender()
      })
      .catch(() => {}) // counts stay stale until the next add, remove or page
  }

  // The old results stay on screen until the new query's first page lands
  // (see beginQuery in pager.ts), but `ready` still drops: it means "these
  // slots are the CURRENT query's", and Spaces' canvas relies on that to know
  // every member has loaded before it reconciles and autosaves.
  const restart = () => {
    pager.current.beginQuery()
    setReady(false)
    fetchPage(0)
  }
  useEffect(() => {
    if (enabled) restart()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled])
  const seenMembers = useRef(members)
  useEffect(() => {
    if (members === undefined || members === seenMembers.current) return
    if (seenMembers.current !== undefined && enabled) restart()
    seenMembers.current = members
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members])

  // Poll "what changed since rev X" while enrichment is landing
  // server-side, instead of refetching whole loaded pages on a timer.
  const [tickCount, setTickCount] = useState(0)
  const loadedPending = pager.current.slots().reduce((n, s) => n + (!isPlaceholder(s) && s.pending ? 1 : 0), 0)
  const pendingTotal = pager.current.pendingTotal
  // Notes the user just captured and is watching enrich on screen. They get a
  // much tighter cadence than the background-backfill rate below: the server
  // finishes a fresh save in a second or two, so waiting out a 15s tick to
  // show its real title/thumbnail reads as "nothing happened, reload the page".
  const hot = pager.current.watchingCount(Date.now()) > 0
  const anyPending = pendingTotal > 0 || loadedPending > 0 || hot || pager.current.awaitingThumbCount(Date.now()) > 0
  useEffect(() => {
    if (!enabled || !anyPending) return
    // The >50 branch is for a library-wide backlog (a bulk re-tag, a fresh
    // import) that nobody is watching tick by tick — it must not slow down
    // the one note the user is actually looking at, hence `hot` first.
    const delay = hot ? 1200 : pager.current.pendingTotal > 50 ? 15000 : 4000
    const id = window.setTimeout(async () => {
      try {
        const d = await API.delta(pager.current.rev, pager.current.bootId)
        if (d.resync) {
          const maxLoaded = pager.current.slots().reduce((m, s, i) => (isPlaceholder(s) ? m : i), 0)
          for (let off = 0; off <= maxLoaded; off += PAGE) fetchPage(off)
        } else {
          pager.current.applyDelta(
            { notes: (d.notes || []).map(mapNote), deleted: d.deleted || [], pendingTotal: d.pendingTotal },
            JSON.parse(key),
          )
          pager.current.rev = d.rev
          pager.current.bootId = d.bootId
          // Enrichment can turn a fresh link into a video, and another device
          // can add or delete, so any change can move a chip's count.
          if (d.notes?.length || d.deleted?.length) refreshFacets()
          rerender()
        }
      } catch {
        /* next tick retries */
      }
      // Bump a plain counter so the dependency array's value changes every
      // tick, forcing the effect to re-arm — a boolean (or a rev number that
      // could plateau) that stays constant across renders would never
      // retrigger it. Same reasoning as the pendingTotal/loadedPending
      // dependency this loop replaced.
      setTickCount(v => v + 1)
    }, delay)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, anyPending, hot, key, ready, tickCount])

  return useMemo(
    () => ({
      slots: pager.current.slots(),
      total: pager.current.total,
      facets: pager.current.facets,
      ready,
      ensure: (first: number, last: number) => {
        // One page of lookahead beyond the visible window.
        for (const off of pager.current.neededPages(Math.max(0, first - PAGE / 2), last + PAGE)) fetchPage(off)
        // Debounced viewport-priority ping: wait for scrolling to settle
        // before telling the server which thumbless Instagram notes are
        // actually on screen, rather than firing one per scroll tick.
        clearTimeout(priorityTimer.current)
        priorityTimer.current = window.setTimeout(() => {
          if (!mounted.current) return
          const ids = pager.current.thumbless(first, last).filter(id => !sentPriority.current.has(id))
          if (!ids.length) return
          ids.forEach(id => {
            sentPriority.current.add(id)
          })
          pager.current.markAwaitingThumb(ids, Date.now(), 20_000)
          rerender()
          API.prioritize(ids)
        }, 500)
      },
      insertLocal: (item: UIItem) => {
        if (!matchesLocal(item, JSON.parse(key))) return
        pager.current.insertLocal(item)
        // A fresh save lands with heuristic metadata only; watch it so the
        // delta poll runs hot until the server's enrichment pass replaces it.
        // The TTL just bounds the fast cadence — an item still pending after
        // it lapses falls back to the normal poll rather than stopping.
        if (item.pending) pager.current.watch([item.id], Date.now(), 90_000)
        rerender()
      },
      removeLocal: (id: string) => {
        pager.current.removeLocal(id)
        rerender()
      },
      patchLocal: (id: string, patch: Partial<UIItem>) => {
        pager.current.patchLocal(id, patch)
        rerender()
      },
      refreshFacets,
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }),
    // facets too: a refreshFacets answer changes the counts and no slot, and
    // without it the chips kept the counts from before.
    [pager.current.slots(), pager.current.facets, ready, key],
  )
}
