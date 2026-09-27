// NotePager — the one client-side data source for note lists. Holds a sparse
// window over the server's canonical order (newest first): loaded pages fill
// indices, everything else renders as a placeholder slot the board shows as a
// skeleton card. Pure module: fetching/polling live in useNotes.ts.
import type { UIItem } from '../types'
import { SOURCE_BY_KEY } from '../domain/source.ts'
import { matchesLocal, type PagerQuery } from '../domain/boardQuery.ts'

export const PAGE = 120

export interface Placeholder {
  id: string
  ph: true
}
export type Slot = UIItem | Placeholder
export function isPlaceholder(s: Slot): s is Placeholder {
  return (s as Placeholder).ph === true
}

export interface Facets {
  types: Record<string, number>
  sources: Record<string, number>
  unavailable?: number
}
export interface NotesPage {
  notes: UIItem[]
  total: number
  offset: number
  facets: Facets
  pendingTotal: number
  rev?: number
  bootId?: string
}
export interface NotesDelta {
  notes: UIItem[]
  deleted: string[]
  pendingTotal: number
}
export class NotePager {
  total = 0
  facets: Facets = { types: {}, sources: {} }
  pendingTotal = 0
  // The current drain, for pendingEta: start time, notes to get through (a
  // mid-run rise joins it rather than restarting the clock), and last count
  // seen. Survives reset() — the count is library-wide, a filter click isn't.
  private drain: { t: number; n: number; last: number } | null = null
  // Starting point for the next delta poll — set from whichever page
  // response landed most recently, then advanced by applyDelta's caller.
  rev = 0
  bootId = ''
  private arr: (UIItem | undefined)[] = []
  private idToIndex = new Map<string, number>()
  private inflight = new Set<number>()
  private phCache: Placeholder[] = []
  private slotCache: Slot[] | null = null
  // Notes the user is actively waiting on — right now, whatever they just
  // captured. Enrichment lands server-side within a second or two, but the
  // delta poll's normal cadence is tuned for background backfill (15s once
  // the library has a real pending backlog), so without this the card the
  // user is staring at keeps its heuristic title until the next slow tick.
  // id -> expiry, bounded so a note stuck behind a long queue can't pin the
  // fast cadence on forever.
  private watching = new Map<string, number>() // id -> expiry (epoch ms)
  // Ids removed locally. A delete waits out App's undo window before it
  // reaches the server, so a delta in that window still carries the note —
  // and a fresh capture's enrichment lands in exactly that window, which put
  // the card straight back. Only restoreLocal (the Undo) brings one back.
  private gone = new Set<string>()
  // Which query's pages are current. A query switch used to reset() on the
  // spot, which emptied facets as well as slots: Everything's chip strip is
  // built from facets, so it unmounted along with every card until the new
  // page arrived — a full blink of the page on each chip click. Now the old
  // results stay on screen and the first page of the new query replaces them.
  private gen = 0
  private replacing = false
  private facetReq = 0
  private facetsFrom = 0 // ticket of the counts currently held

  get generation(): number {
    return this.gen
  }

  beginQuery(): number {
    this.gen++
    this.replacing = true
    this.inflight.clear()
    return this.gen
  }

  // Chip counts are the server's: they cover every note the search matches,
  // whatever chips are on, so the loaded window can't recount them. They used
  // to arrive only with a page, so deleting the one GitHub note left "GitHub 1"
  // on the strip, opening an empty board. useNotes' refreshFacets re-asks
  // after each add or remove. Every request that brings counts back, page or
  // refresh, takes a ticket as it is sent, and counts are only replaced by a
  // later ticket's: two quick deletes send two refreshes, and a page asked for
  // before a delete landed still counts the note, and either can answer last.
  requestFacets(): number {
    return ++this.facetReq
  }

  applyFacets(f: Facets, req: number): boolean {
    if (req < this.facetsFrom) return false
    this.facetsFrom = req
    this.facets = f
    return true
  }

  reset(): void {
    this.total = 0
    this.arr = []
    this.idToIndex.clear()
    this.inflight.clear()
    this.slotCache = null
    // Counts are left to applyFacets: a refresh sent after the query switch
    // can land before its first page, and its counts are the newer ones.
    this.pendingTotal = 0
    this.watching.clear()
    // Zeroing bootId (not just rev) matters: it forces a stale delta-poll
    // timeout from a superseded query — scheduled before reset() ran, still
    // in flight — to fail the server's boot !== bootId check and resync
    // instead of applying old-query data onto this fresh pager.
    this.rev = 0
    this.bootId = ''
  }

  markInflight(offset: number): void {
    this.inflight.add(offset)
  }
  clearInflight(offset: number): void {
    this.inflight.delete(offset)
  }

  // False when the page was dropped, so the caller does not mark a query
  // ready on the strength of another query's results.
  applyPage(p: NotesPage, gen = this.gen, req = this.requestFacets(), now = Date.now()): boolean {
    // Two quick chip clicks can land the first query's page after the second
    // has begun; applying it would show the wrong filter's results.
    if (gen !== this.gen) return false
    if (this.replacing) {
      this.reset()
      this.replacing = false
    }
    this.total = p.total
    this.applyFacets(p.facets, req)
    this.setPending(p.pendingTotal, now)
    // Unconditional overwrite, no max-taking against a concurrent delta
    // poll's rev: worst case a stale rev here just makes the next delta
    // poll re-request a bit of already-applied data — applyDelta is
    // idempotent for known ids and gated by matchesLocal + the newest-ts
    // check for unknown ones. A newer rev does skip a note saved elsewhere
    // since the last poll; it shows up as offset drift, handled below.
    if (p.rev !== undefined) this.rev = p.rev
    if (p.bootId !== undefined) this.bootId = p.bootId
    this.inflight.delete(p.offset)
    if (this.arr.length !== p.total) this.arr.length = p.total
    p.notes.forEach((incoming, i) => {
      const idx = p.offset + i
      if (idx >= this.total) return
      // A note already held at another index means the server's offsets have
      // moved since that page came back: a save from Telegram or another
      // device before the next delta poll, or an import landing mid-list with its
      // original date. Written by offset alone, the note sat on both sides of
      // the page boundary. The stale copy goes back to a placeholder, and the
      // board's next window report refetches its page from the current order.
      const was = this.idToIndex.get(incoming.id)
      if (was !== undefined && was !== idx && this.arr[was]?.id === incoming.id) this.arr[was] = undefined
      const existing = this.arr[idx]
      // Reuse the held object for JSON-equal notes so unchanged cards keep
      // their identity and never re-render (mergeItems' old job).
      this.arr[idx] = existing && JSON.stringify(existing) === JSON.stringify(incoming) ? existing : incoming
      this.idToIndex.set((this.arr[idx] as UIItem).id, idx)
    })
    this.slotCache = null
    return true
  }

  slots(): Slot[] {
    if (this.slotCache) return this.slotCache
    this.slotCache = Array.from({ length: this.total }, (_, i) => {
      const it = this.arr[i]
      if (it) return it
      // Placeholder objects are cached per index so identity is stable
      // across renders (byId maps and React keys depend on it).
      this.phCache[i] ??= { id: `ph:${i}`, ph: true }
      return this.phCache[i]
    })
    return this.slotCache
  }

  // Page-aligned offsets needed to cover [first, last], excluding pages
  // already loaded or in flight. `first`/`last` are slot indices.
  neededPages(first: number, last: number): number[] {
    // The slots on screen still belong to the old query, so its total and
    // loaded indices say nothing about which of the new query's pages exist.
    if (this.replacing) return []
    if (this.total === 0 && this.arr.length === 0 && !this.inflight.has(0)) return [0]
    const out: number[] = []
    const from = Math.max(0, Math.floor(first / PAGE) * PAGE)
    const to = Math.min(Math.max(0, this.total - 1), last)
    for (let off = from; off <= to; off += PAGE) {
      if (this.inflight.has(off)) continue
      let loaded = true
      for (let i = off; i < Math.min(off + PAGE, this.total); i++) {
        if (!this.arr[i]) {
          loaded = false
          break
        }
      }
      if (!loaded) out.push(off)
    }
    return out
  }

  insertLocal(item: UIItem): void {
    this.arr.unshift(item)
    this.total++
    this.reindex()
  }

  removeLocal(id: string): void {
    this.gone.add(id)
    const idx = this.idToIndex.get(id)
    if (idx === undefined) return
    this.arr.splice(idx, 1)
    this.total--
    this.reindex()
  }

  // For page requests: the server still has a note deleted here until its
  // Undo lapses, and its offsets must count what the board shows.
  excluded(): string[] {
    return [...this.gone]
  }

  restoreLocal(item: UIItem, at: number): void {
    this.gone.delete(item.id)
    this.arr.splice(at, 0, item)
    this.total++
    this.reindex()
  }

  patchLocal(id: string, patch: Partial<UIItem>): void {
    const idx = this.idToIndex.get(id)
    if (idx === undefined || !this.arr[idx]) return
    this.arr[idx] = { ...this.arr[idx]!, ...patch }
    this.slotCache = null
  }

  applyDelta(d: NotesDelta, query: PagerQuery, now = Date.now()): void {
    this.setPending(d.pendingTotal, now)
    for (const id of d.deleted) this.removeLocal(id)
    // Capture the "newest loaded" ts once, before the loop, instead of
    // re-reading arr[0] on each iteration. changedSince() returns newly-added
    // notes newest-first (store does unshift() on add), so a 2+-note batch
    // arrives non-ascending; comparing against a live arr[0] would check
    // later notes against an earlier note in this same batch (already
    // inserted) rather than against what was actually loaded before the
    // delta, silently dropping anything not strictly newer than that.
    const baseline = this.arr[0] ? (this.arr[0].ts ?? 0) : -Infinity
    const fresh: UIItem[] = []
    for (const incoming of d.notes) {
      const idx = this.idToIndex.get(incoming.id)
      if (idx !== undefined && this.arr[idx]) {
        if (JSON.stringify(this.arr[idx]) !== JSON.stringify(incoming)) {
          this.arr[idx] = incoming
          this.slotCache = null
        }
        continue
      }
      // Unknown id: only a note newer than everything loaded before this
      // delta can be safely placed. Anything older lives in unloaded
      // territory and will arrive when its page is fetched.
      if (this.gone.has(incoming.id)) continue
      if ((incoming.ts ?? 0) > baseline && matchesLocal(incoming, query)) fresh.push(incoming)
    }
    // Insert ascending so each insertLocal correctly becomes the new front;
    // a stable sort also means ts ties both survive instead of the second
    // one losing to a strict > comparison.
    fresh.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
    for (const item of fresh) this.insertLocal(item)
  }

  private setPending(n: number, now: number): void {
    const d = this.drain
    if (!d || d.last === 0) this.drain = { t: now, n, last: n }
    else {
      if (n > d.last) d.n += n - d.last
      d.last = n
    }
    this.pendingTotal = n
  }

  // Ms until nothing is pending at the rate the count has fallen since the
  // drain started, or null while there's too little to go on (one pass takes 5-25s).
  pendingEta(now: number): number | null {
    const d = this.drain
    if (!d || !this.pendingTotal) return null
    const done = d.n - this.pendingTotal
    const spent = now - d.t
    if (spent < 120_000 || done < 5) return null
    return (this.pendingTotal * spent) / done
  }

  // Loaded slots in [first,last] that are Instagram posts still missing a
  // thumbnail — candidates for priority meta fetching. Reuses source.ts's
  // own reels/igposts matchers (already precise: /reel/ vs /p/) instead of
  // a third, looser "is this Instagram" regex — the server's isInstagramPost
  // remains authoritative either way (handlePrioritize filters non-posts
  // back out), so this is just avoiding a redundant definition, not a
  // correctness fix.
  thumbless(first: number, last: number): string[] {
    const out: string[] = []
    for (let i = Math.max(0, first); i <= Math.min(last, this.total - 1); i++) {
      const it = this.arr[i]
      if (it && !it.thumb && it.url && (SOURCE_BY_KEY.reels?.test(it) || SOURCE_BY_KEY.igposts?.test(it)))
        out.push(it.id)
    }
    return out
  }

  // Ms until the next delta poll. It never stops: it used to run only while
  // something was pending, so a note saved from Telegram onto a quiet library
  // never reached an open board — nothing was pending when it was saved, and
  // it was enriched before anything asked again. The 15s rate is for a
  // library-wide backlog (a bulk re-tag, a fresh import) nobody watches tick
  // by tick; it must not slow down a note the user just captured, hence the
  // watched check first.
  pollDelay(now: number): number {
    if (this.watchingCount(now) > 0) return 1200
    return this.pendingTotal > 50 ? 15000 : 4000
  }

  // Mark ids worth polling fast for until they finish enriching.
  watch(ids: string[], now: number, ttlMs: number): void {
    const until = now + ttlMs
    for (const id of ids) this.watching.set(id, until)
  }

  // How many watched ids are still worth the fast cadence: not expired, still
  // loaded in this view, and still flagged pending by the server. Anything
  // else is dropped so the poll falls back to its normal rate.
  watchingCount(now: number): number {
    let count = 0
    for (const [id, until] of this.watching) {
      if (now > until) {
        this.watching.delete(id)
        continue
      }
      const idx = this.idToIndex.get(id)
      const it = idx !== undefined ? this.arr[idx] : undefined
      // Gone from this view (deleted, or filtered out by a query change)
      // or already enriched — either way there is nothing left to wait for.
      if (!it?.pending) {
        this.watching.delete(id)
        continue
      }
      count++
    }
    return count
  }

  private reindex(): void {
    this.idToIndex.clear()
    this.arr.forEach((it, i) => {
      if (it) this.idToIndex.set(it.id, i)
    })
    this.slotCache = null
  }
}
