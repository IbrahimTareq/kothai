// The Instagram fetch queue: a single throttled lane, promotable from the
// client, with a bounded retry budget per note.
//
// Split out of enrich.ts, where it sat as ~160 lines and six pieces of mutable
// module state in the middle of the enrichment pipeline. It is not a variation
// on the other two lanes in that file — the serial enrichChain and the
// bounded-concurrency meta lane — it is a third discipline with its own rules:
// one request at a time behind a >=2.5s throttle, an explicit deque so the
// notes actually on screen can jump the line, and a retry policy for a host
// that soft-bans. Those rules are the whole reason this code exists, and they
// are easier to keep right when they are not interleaved with classify/embed.
//
// The queue does not know what enrichment is. Its one tie back to the pipeline
// is announcing that a caption landed, which arrives here as an injected
// handler rather than an import — so this module has no edge back to enrich.ts
// and the two cannot form a cycle.
import * as store from '../data/notes.ts'
import type { NoteRecord } from '../data/notes.ts'
import { fetchLinkMeta } from './meta.ts'
import { fetchInstagramEmbed, fetchInstagramSlides, isInstagramPost } from './instagram.ts'
import { applyMeta } from './meta-fields.ts'

// A queued fetch. `slides` picks the carousel job over the thumbnail one;
// `resolve` settles the promise queueIgSlides handed its caller. `embed` makes
// it an availability check, which hands the page back and writes nothing.
interface IgJob {
  noteId: string
  url: string
  slides?: boolean
  resolve?: (value?: unknown) => void
  embed?: { resolve: (html: string) => void; reject: (e: unknown) => void }
}

// Called with a noteId once a fetch has produced a caption worth
// re-classifying on. enrich.ts registers the real handler at import; the
// default no-op keeps this module usable (and testable) on its own.
let onCaptionLanded: (noteId: string) => void = () => {}
export function setCaptionHandler(fn: (noteId: string) => void) {
  onCaptionLanded = fn
}

// Instagram embed fetches get their OWN queue, separate from enrichChain
// (same reasoning as before: the >=2.5s throttle must not park classify/embed
// work). Now an explicit deque instead of a promise chain, so the scrolling
// client can PROMOTE the notes actually on screen to the front — thumbnails
// materialize where the user is looking, not in insertion order.
const igQueue: IgJob[] = [] // [{ noteId, url, slides?, resolve? }]
const igQueued = new Set<string>() // noteIds present in igQueue
const igInFlight = new Set<string>() // noteIds currently mid-runIgJob (shifted out, not yet settled)
let igPumping = false
let igPaused = false // test hook

// ---- meta retry policy --------------------------------------------------
// A failed Instagram fetch used to permanently set metaFetched — one bad
// network moment and the note never got a thumbnail. Failures now record a
// try count + earliest-next-attempt; the boot backfill re-queues eligible
// notes, up to 5 tries per note.
const META_MAX_TRIES = 5

export function metaRetryDelay(tries: number) {
  return Math.min(24 * 3600_000, 600_000 * 4 ** tries)
}

export function metaRetryEligible(n: Pick<NoteRecord, 'metaFetched' | 'metaTries' | 'metaNextTry'>, now = Date.now()) {
  if (n.metaFetched) return false
  if ((n.metaTries || 0) >= META_MAX_TRIES) return false
  if (n.metaNextTry && now < n.metaNextTry) return false
  return true
}

// Notes stuck by the OLD failure policy: marked fetched, but no piece of
// metadata actually landed. One retried pass unsticks them.
export function isStuckInstagramNote(n: Pick<NoteRecord, 'url' | 'metaFetched' | 'thumb' | 'siteTitle' | 'siteDesc'>) {
  return !!(n.url && isInstagramPost(n.url) && n.metaFetched && !n.thumb && !n.siteTitle && !n.siteDesc)
}

async function runIgJob({ noteId, url }: IgJob) {
  const patch: Partial<NoteRecord> = {}
  try {
    const m = await fetchLinkMeta(url, noteId)
    patch.metaFetched = true
    applyMeta(patch, m)
  } catch (e) {
    console.error('[enrich] instagram meta fetch failed for', url, '-', e instanceof Error ? e.message : e)
    // Record a try count + earliest-next-attempt instead of permanently
    // setting metaFetched — see the meta retry policy below. metaFetched is
    // deliberately left untouched here (stays whatever it was, usually
    // absent) so this note keeps failing queueMetaBackfill's `!n.metaFetched`
    // gate on the non-IG path AND stays eligible for metaRetryEligible until
    // the try budget is exhausted.
    const n = store.getNote(noteId)
    const tries = (n?.metaTries || 0) + 1
    patch.metaTries = tries
    patch.metaNextTry = Date.now() + metaRetryDelay(tries - 1)
  }
  await store.updateNote(noteId, patch)
  if (patch.siteTitle || patch.siteDesc) onCaptionLanded(noteId)
}

async function pumpIg() {
  if (igPumping || igPaused) return
  igPumping = true
  // Dequeue in the loop head rather than `while (igQueue.length)` with a shift
  // inside: Array.shift() is declared possibly-undefined for an empty array, and
  // the job is handed straight to runIgJob/runSlidesJob. Same dequeue order and
  // same stopping point — a shift on an empty queue neither mutates nor loops.
  for (let job = igQueue.shift(); job; job = igQueue.shift()) {
    // An availability check is not tracked in igQueued or igInFlight: those
    // mean "this note's meta fetch is spoken for", and a note being checked
    // may still need one — queueIgMeta would skip it.
    if (job.embed) {
      await fetchInstagramEmbed(job.url).then(job.embed.resolve, job.embed.reject)
      continue
    }
    // Only thumbnail jobs are tracked in igQueued — a slides job for the same
    // note must not clear a still-pending thumbnail job's marker, which would
    // let queueIgMeta enqueue a second fetch for work already in the queue.
    if (!job.slides) igQueued.delete(job.noteId)
    // Mark in-flight for the FULL duration of the job — including its
    // store.updateNote, which can land well after the throttled fetch
    // itself resolves. Without this, a prioritize call arriving in that
    // window sees the note as neither queued nor fetched (metaFetched is
    // still false until the write lands) and re-queues a wholly redundant
    // fetch for a job that's already running — burning a scarce, soft-ban-
    // relevant throttle slot for nothing. See queueIgMeta below.
    igInFlight.add(job.noteId)
    try {
      await (job.slides ? runSlidesJob(job) : runIgJob(job))
    } catch (e) {
      console.error('[enrich] instagram meta job failed:', e instanceof Error ? e.message : e)
    } finally {
      igInFlight.delete(job.noteId)
      job.resolve?.()
    }
  }
  igPumping = false
}

export function queueIgMeta(noteId: string, url: string) {
  if (igQueued.has(noteId) || igInFlight.has(noteId)) return
  igQueued.add(noteId)
  // Ahead of any availability checks: a sweep queues hundreds, and a new
  // save's caption and thumbnail must not wait out the whole run.
  const firstCheck = igQueue.findIndex(j => j.embed)
  igQueue.splice(firstCheck < 0 ? igQueue.length : firstCheck, 0, { noteId, url })
  pumpIg()
}

// The embed page for an availability check, at the very back of the queue.
// Rejects when the fetch fails. No note is written, so the url stands in as
// the id the inspection hook reports.
export function queueIgEmbed(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    igQueue.push({ noteId: url, url, embed: { resolve, reject } })
    pumpIg()
  })
}

// ---- carousel slides ----------------------------------------------------
// Multi-photo posts are fetched LAZILY — only when the user actually opens one
// in the expanded view — never swept in bulk. A library of a few thousand saved
// posts would otherwise mean hours against the 2.5s throttle and thousands of
// images on disk to serve a deck nobody has looked at.
//
// `slidesFetched` records that a post has been checked, so a single-image post
// is never re-scraped; a FAILED fetch deliberately leaves it unset, so simply
// opening the item again retries.
async function runSlidesJob({ noteId, url }: IgJob) {
  let slides: string[]
  try {
    slides = await fetchInstagramSlides(url, noteId)
  } catch (e) {
    console.error('[enrich] instagram slides fetch failed for', url, '-', e instanceof Error ? e.message : e)
    return
  }
  // One slide means the post is a single image, not a carousel — record that
  // it was checked, but store no deck for the client to page through.
  await store.updateNote(noteId, slides.length > 1 ? { slidesFetched: true, slides } : { slidesFetched: true })
}

// Resolves once this note's slides have landed (or the attempt failed).
// Enqueued at the FRONT for the same reason promoteIgMeta exists: this note is
// the one on screen right now. Concurrent callers share one fetch rather than
// each burning a throttle slot on the same post.
const slidesWaiters = new Map<string, Promise<unknown>>() // noteId → in-flight promise

export function queueIgSlides(noteId: string, url: string) {
  const running = slidesWaiters.get(noteId)
  if (running) return running
  let resolve: IgJob['resolve']
  const done = new Promise(r => {
    resolve = r
  })
  const p = done.finally(() => slidesWaiters.delete(noteId))
  slidesWaiters.set(noteId, p)
  igQueue.unshift({ noteId, url, slides: true, resolve })
  pumpIg()
  return p
}

// Move the given noteIds (those still queued) to the FRONT, preserving the
// caller's order. Unknown / already-fetched ids are ignored — callers send
// whatever is on screen without checking.
export function promoteIgMeta(ids: string[]) {
  const want = ids.filter(id => igQueued.has(id))
  if (!want.length) return 0
  const wantSet = new Set(want)
  const rest = igQueue.filter(j => !wantSet.has(j.noteId))
  const front = want.map(id => igQueue.find(j => j.noteId === id)).filter(j => j !== undefined)
  igQueue.length = 0
  igQueue.push(...front, ...rest)
  return front.length
}

// test-only inspection/pause hooks
export const _igQueueState = {
  pause() {
    igPaused = true
  },
  resume() {
    igPaused = false
    pumpIg()
  },
  clear() {
    igQueue.length = 0
    igQueued.clear()
    igInFlight.clear()
    igPaused = false
  },
  ids() {
    return igQueue.map(j => j.noteId)
  },
  pumping() {
    return igPumping
  },
  inFlight() {
    return [...igInFlight]
  },
}
