// The fast metadata lane: link metadata fetched a few at a time, off the
// model's job chain.
//
// Split out of enrich.ts, which reaches it only to re-export queueLinkMeta and
// to reuse what it wrote (enrichNote skips its own fetch for a note this lane
// already filled).
import * as store from '../data/notes.ts'
import type { NoteRecord } from '../data/notes.ts'
import { fetchLinkMeta } from './meta.ts'
import type { LinkMeta } from './meta.ts'
import { isInstagramPost } from './instagram.ts'
import { applyMeta } from './meta-fields.ts'
import { queueThumbRetry } from './thumb-retry.ts'
import { queueIgMeta } from './instagram-queue.ts'

// Cheap, network-bound work — oEmbed/OpenGraph: a caption, an author, a
// thumbnail — split OUT of the job chain (../ai/queue.ts), which is strictly
// serial because the local model can only run one pass at a time.
//
// Welded together (which is how this worked) a ~300ms metadata fetch waits
// behind someone else's multi-second vision+classify pass, so a 197-item
// import leaves every tile blank for the best part of an hour: measured at
// 5-25s per note, ~50 minutes for a real export. Split, the grid fills with
// real captions and thumbnails in a minute or two and the model work carries
// on behind it. This is the usual fast-path/slow-path split — the expensive
// pass still runs, it just stops gating what the user can see.
//
// Bounded concurrency rather than firing all of them at once: these are
// outbound requests to a handful of hosts, and 197 simultaneous fetches is how
// you earn a rate-limit. Instagram is handed to its own queue instead, on a
// >=2.5s throttle for exactly that reason (see queueIgMeta).
interface MetaJob {
  noteId: string
  url: string
}

const META_CONCURRENCY = 4
let metaActive = 0
const metaQueue: MetaJob[] = []

export function queueLinkMeta(noteId: string, url: string) {
  if (!noteId || !url) return
  // Instagram has its own throttled lane. Left to enrichNote, each post's
  // fetch waited for the serial model chain to reach it (~15s a post), so an
  // import's off-screen captions arrived at model speed.
  if (isInstagramPost(url)) {
    queueIgMeta(noteId, url)
    return
  }
  metaQueue.push({ noteId, url })
  pumpMeta()
}

function pumpMeta() {
  // Dequeue first and break on empty rather than testing metaQueue.length in
  // the loop head: Array.shift() is declared possibly-undefined and the job
  // goes straight to runMetaJob. Same dequeue order and same stopping point —
  // a shift on an empty queue neither mutates nor loops. ./instagram-queue.ts's pumpIg
  // restructured its own loop head for exactly this reason.
  while (metaActive < META_CONCURRENCY) {
    const job = metaQueue.shift()
    if (!job) break
    metaActive++
    runMetaJob(job)
      .catch(() => {})
      .finally(() => {
        metaActive--
        pumpMeta()
      })
  }
}

async function runMetaJob({ noteId, url }: MetaJob) {
  let m: LinkMeta | null = null
  try {
    m = await fetchLinkMeta(url, noteId)
  } catch (e) {
    // Leave the note untouched and metaFetched unset: enrichNote's own fetch
    // still runs later, so a failure here costs nothing but a retry.
    console.error('[enrich] fast meta fetch failed:', e instanceof Error ? e.message : e)
    return
  }
  if (!m) return
  const existing = store.getNote(noteId)
  if (!existing) return // deleted (or rolled back) while the fetch was in flight
  const patch: Partial<NoteRecord> = { metaFetched: true }
  applyMeta(patch, m)
  // The provisional title is the whole point of this lane: the card renders
  // `title`, not siteTitle, so without this the tile keeps the importer's
  // placeholder ("TikTok video") until classify eventually runs. Gated on
  // `pending` so it can only ever replace an importer placeholder — a note the
  // user has touched is not pending, and classify overwrites this with a
  // cleaner title when it gets there anyway.
  if (existing.pending && m.siteTitle) patch.title = m.siteTitle
  if (m.author && !existing.account) patch.account = m.author
  try {
    await store.updateNote(noteId, patch)
    if (patch.thumbSrc) queueThumbRetry(noteId)
  } catch (e) {
    console.error('[enrich] fast meta write failed:', e instanceof Error ? e.message : e)
  }
}
