// NotePager — the one client-side data source for note lists. Holds a sparse
// window over the server's canonical order (newest first): loaded pages fill
// indices, everything else renders as a placeholder slot the board shows as a
// skeleton card. Pure module: fetching/polling live in useNotes.ts.
import type { UIItem } from '../types'
import { SOURCE_BY_KEY } from '../domain/source.ts'

export const PAGE = 120

export interface Placeholder { id: string; ph: true }
export type Slot = UIItem | Placeholder
export function isPlaceholder(s: Slot): s is Placeholder {
  return (s as Placeholder).ph === true
}

export interface Facets { types: Record<string, number>; sources: Record<string, number>; unavailable?: number }
export interface NotesPage {
  notes: UIItem[]; total: number; offset: number; facets: Facets; pendingTotal: number
  rev?: number; bootId?: string
}
export interface NotesDelta { notes: UIItem[]; deleted: string[]; pendingTotal: number }
export interface PagerQuery { type?: string; source?: string; q?: string; collection?: string; unavailable?: boolean; sort?: string }

// Client mirror of the server-side filter, for deciding whether an
// optimistically saved note belongs in the current view. `type` here is the
// SERVER type ('text', not 'note') to match the query params sent.
export function matchesLocal(item: UIItem, query: PagerQuery): boolean {
  // Collection membership can't be mirrored client-side — an item alone
  // doesn't say which collections it belongs to, unlike type/source/q which
  // are derivable from the item itself. Without this guard, applyDelta's
  // "is this unknown note newer than what's loaded" check would treat any
  // vault-wide change as belonging to the open collection and leak unrelated
  // items into its board. Members added while a Space is open show up next
  // full fetch instead (Spaces.tsx's CollectionView already handles removal
  // locally via removeLocal, so this only affects the addition path).
  if (query.collection) return false
  const serverType = item.type === 'note' ? 'text' : item.type
  // Mirrors applyFilters' OR-within-a-facet: a note matches if it is ANY of the
  // selected types, and from ANY of the selected sources.
  const types = (query.type || '').split(',').filter(Boolean)
  if (types.length && !types.includes(serverType)) return false
  // Mirrors applyFilters' default: a dead link stays out of an ordinary view
  // and only appears when explicitly asked for.
  if (query.unavailable ? !item.unavailable : item.unavailable) return false
  const sources = (query.source || '').split(',').filter(Boolean)
  if (sources.length && !sources.some((k) => SOURCE_BY_KEY[k]?.test(item))) return false
  if (query.q && query.q.trim()) {
    const hay = [item.text, item.title, item.note, item.name, item.host, (item.tags || []).join(' ')]
      .filter(Boolean).join(' ').toLowerCase()
    if (!hay.includes(query.q.trim().toLowerCase())) return false
  }
  return true
}

export class NotePager {
  total = 0
  facets: Facets = { types: {}, sources: {} }
  pendingTotal = 0
  // Starting point for the next delta poll — set from whichever page
  // response landed most recently, then advanced by applyDelta's caller.
  rev = 0
  bootId = ''
  private arr: (UIItem | undefined)[] = []
  private idToIndex = new Map<string, number>()
  private inflight = new Set<number>()
  private phCache: Placeholder[] = []
  private slotCache: Slot[] | null = null
  // ids the client asked the server to prioritize (client/data/useNotes.ts's
  // ensure()), each mapped to how long the delta-poll loop should keep
  // checking for their thumbnail before giving up. Bounded rather than
  // indefinite: a note stuck in a multi-hour retry backoff (server/ai/
  // enrich.js's metaRetryDelay) shouldn't keep the client polling forever —
  // it'll be picked up whenever the user next revisits or reloads.
  private awaitingThumb = new Map<string, number>() // id -> expiry (epoch ms)
  // Notes the user is actively waiting on — right now, whatever they just
  // captured. Enrichment lands server-side within a second or two, but the
  // delta poll's normal cadence is tuned for background backfill (15s once
  // the library has a real pending backlog), so without this the card the
  // user is staring at keeps its heuristic title until the next slow tick.
  // Same shape as awaitingThumb: id -> expiry, bounded so a note stuck
  // behind a long queue can't pin the fast cadence on forever.
  private watching = new Map<string, number>()     // id -> expiry (epoch ms)

  reset(): void {
    this.total = 0
    this.arr = []
    this.idToIndex.clear()
    this.inflight.clear()
    this.slotCache = null
    this.facets = { types: {}, sources: {} }
    this.pendingTotal = 0
    this.awaitingThumb.clear()
    this.watching.clear()
    // Zeroing bootId (not just rev) matters: it forces a stale delta-poll
    // timeout from a superseded query — scheduled before reset() ran, still
    // in flight — to fail the server's boot !== bootId check and resync
    // instead of applying old-query data onto this fresh pager.
    this.rev = 0
    this.bootId = ''
  }

  markInflight(offset: number): void { this.inflight.add(offset) }
  clearInflight(offset: number): void { this.inflight.delete(offset) }

  applyPage(p: NotesPage): void {
    this.total = p.total
    this.facets = p.facets
    this.pendingTotal = p.pendingTotal
    // Unconditional overwrite, no max-taking against a concurrent delta
    // poll's rev: worst case a stale rev here just makes the next delta
    // poll re-request a bit of already-applied data — applyDelta is
    // idempotent for known ids and gated by matchesLocal + the newest-ts
    // check for unknown ones, so this can never drop or duplicate a note.
    if (p.rev !== undefined) this.rev = p.rev
    if (p.bootId !== undefined) this.bootId = p.bootId
    this.inflight.delete(p.offset)
    if (this.arr.length !== p.total) this.arr.length = p.total
    p.notes.forEach((incoming, i) => {
      const idx = p.offset + i
      if (idx >= this.total) return
      const existing = this.arr[idx]
      // Reuse the held object for JSON-equal notes so unchanged cards keep
      // their identity and never re-render (mergeItems' old job).
      this.arr[idx] = existing && JSON.stringify(existing) === JSON.stringify(incoming) ? existing : incoming
      this.idToIndex.set((this.arr[idx] as UIItem).id, idx)
    })
    this.slotCache = null
  }

  slots(): Slot[] {
    if (this.slotCache) return this.slotCache
    this.slotCache = Array.from({ length: this.total }, (_, i) => {
      const it = this.arr[i]
      if (it) return it
      // Placeholder objects are cached per index so identity is stable
      // across renders (byId maps and React keys depend on it).
      return (this.phCache[i] ??= { id: 'ph:' + i, ph: true })
    })
    return this.slotCache
  }

  // Page-aligned offsets needed to cover [first, last], excluding pages
  // already loaded or in flight. `first`/`last` are slot indices.
  neededPages(first: number, last: number): number[] {
    if (this.total === 0 && this.arr.length === 0 && !this.inflight.has(0)) return [0]
    const out: number[] = []
    const from = Math.max(0, Math.floor(first / PAGE) * PAGE)
    const to = Math.min(Math.max(0, this.total - 1), last)
    for (let off = from; off <= to; off += PAGE) {
      if (this.inflight.has(off)) continue
      let loaded = true
      for (let i = off; i < Math.min(off + PAGE, this.total); i++) {
        if (!this.arr[i]) { loaded = false; break }
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
    const idx = this.idToIndex.get(id)
    if (idx === undefined) return
    this.arr.splice(idx, 1)
    this.total--
    this.reindex()
  }

  patchLocal(id: string, patch: Partial<UIItem>): void {
    const idx = this.idToIndex.get(id)
    if (idx === undefined || !this.arr[idx]) return
    this.arr[idx] = { ...this.arr[idx]!, ...patch }
    this.slotCache = null
  }

  applyDelta(d: NotesDelta, query: PagerQuery): void {
    this.pendingTotal = d.pendingTotal
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
      if ((incoming.ts ?? 0) > baseline && matchesLocal(incoming, query)) fresh.push(incoming)
    }
    // Insert ascending so each insertLocal correctly becomes the new front;
    // a stable sort also means ts ties both survive instead of the second
    // one losing to a strict > comparison.
    fresh.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
    for (const item of fresh) this.insertLocal(item)
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
      if (it && !it.thumb && it.url && (SOURCE_BY_KEY.reels?.test(it) || SOURCE_BY_KEY.igposts?.test(it))) out.push(it.id)
    }
    return out
  }

  markAwaitingThumb(ids: string[], now: number, ttlMs: number): void {
    const until = now + ttlMs
    for (const id of ids) this.awaitingThumb.set(id, until)
  }

  // How many still-awaited ids are worth polling for right now: not yet
  // expired, and not already resolved (a loaded slot may already show the
  // thumbnail by the time this is checked, e.g. right after applyDelta).
  awaitingThumbCount(now: number): number {
    let count = 0
    for (const [id, until] of this.awaitingThumb) {
      if (now > until) { this.awaitingThumb.delete(id); continue }
      const idx = this.idToIndex.get(id)
      const it = idx !== undefined ? this.arr[idx] : undefined
      if (it?.thumb) { this.awaitingThumb.delete(id); continue }
      count++
    }
    return count
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
      if (now > until) { this.watching.delete(id); continue }
      const idx = this.idToIndex.get(id)
      const it = idx !== undefined ? this.arr[idx] : undefined
      // Gone from this view (deleted, or filtered out by a query change)
      // or already enriched — either way there is nothing left to wait for.
      if (!it || !it.pending) { this.watching.delete(id); continue }
      count++
    }
    return count
  }

  private reindex(): void {
    this.idToIndex.clear()
    this.arr.forEach((it, i) => { if (it) this.idToIndex.set(it.id, i) })
    this.slotCache = null
  }
}
