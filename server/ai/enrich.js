// Background enrichment pipeline — the second phase of the two-phase save.
//
// A note is persisted instantly with heuristic metadata; these jobs then patch
// it in place: caption images, fetch link/video metadata, LLM-classify
// (grammar-constrained JSON), and embed. Jobs run one at a time (FIFO) so rapid
// saves don't contend for the model, and each waits for boot() — notes saved
// while models are still loading get enriched as soon as they're ready instead
// of staying heuristic forever. Any failure just leaves the heuristic version.
import path from 'node:path'
import * as store from '../data/notes.js'
import * as tags from '../lib/tags.js'
import * as tagvocab from '../data/tagvocab.js'
import * as inference from './index.js'
import { fetchLinkMeta, fetchInstagramSlides, isInstagramPost, isYouTubeVideo, fetchYouTubeCaptions } from './meta.js'
import * as collections from '../data/collections.js'
import * as settings from '../data/settings.js'
import { stepsFor } from './backlog.js'
import { DESCRIBE_THUMB_PROMPT, EMBED_RECIPE } from './prompts.js'
import { UPLOAD_DIR } from '../data/notes.js'

let enrichChain = Promise.resolve()

// Enqueue an arbitrary job on the FIFO chain. Also used by the settings
// re-embed so it can't race in-flight enrichment. Returns the chain promise
// so callers that care when it lands (tests; queueIgMeta below) can await
// it — fire-and-forget callers just ignore the return value.
export function queueJob(fn) {
  enrichChain = enrichChain.then(fn).catch((e) => console.error('[enrich] failed:', e.message))
  return enrichChain
}

export function queueEnrich(noteId, job) {
  return queueJob(() => enrichNote(noteId, job))
}

// ---- fast metadata lane ---------------------------------------------------
// Cheap, network-bound work — oEmbed/OpenGraph: a caption, an author, a
// thumbnail — split OUT of enrichChain, which is strictly serial because the
// local model can only run one pass at a time.
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
// you earn a rate-limit. Deliberately NOT used for Instagram, which has its
// own queue on a >=2.5s throttle for exactly that reason (see queueIgMeta).
const META_CONCURRENCY = 4
let metaActive = 0
const metaQueue = []

export function queueLinkMeta(noteId, url) {
  if (!noteId || !url || isInstagramPost(url)) return
  metaQueue.push({ noteId, url })
  pumpMeta()
}

// Read by tests and by anything wanting to know the lane is drained.
export function metaLaneDepth() {
  return metaQueue.length + metaActive
}

function pumpMeta() {
  while (metaActive < META_CONCURRENCY && metaQueue.length) {
    const job = metaQueue.shift()
    metaActive++
    runMetaJob(job).catch(() => {}).finally(() => { metaActive--; pumpMeta() })
  }
}

async function runMetaJob({ noteId, url }) {
  let m
  try {
    m = await fetchLinkMeta(url, noteId)
  } catch (e) {
    // Leave the note untouched and metaFetched unset: enrichNote's own fetch
    // still runs later, so a failure here costs nothing but a retry.
    console.error('[enrich] fast meta fetch failed:', e.message)
    return
  }
  if (!m) return
  const existing = store.allNotes().find((n) => n.id === noteId)
  if (!existing) return // deleted (or rolled back) while the fetch was in flight
  const patch = { metaFetched: true }
  for (const k of ['siteTitle', 'siteDesc', 'siteName', 'thumb', 'article']) {
    if (m[k]) patch[k] = m[k]
  }
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
  } catch (e) {
    console.error('[enrich] fast meta write failed:', e.message)
  }
}

// Describes a note's downloaded thumbnail with the vision model, so
// classify/embed get a second, independent signal beyond whatever the creator
// chose to caption — often just hashtags. Runs for ANY note carrying a thumb,
// not only Instagram ones: the cover frame of a TikTok, a YouTube video or an
// og:image is the same kind of evidence, and short-form covers in particular
// carry burned-in hook text that the prompt (see DESCRIBE_THUMB_PROMPT)
// explicitly asks to be transcribed — usually the single best retrieval key
// the video has. Idempotent via ai.thumbVision so a note only pays for this
// once, even across multiple enrich/reclassify attempts (a transient failure
// just leaves it unset, same tradeoff as every other AI marker in this file —
// see igReclassified's comment below). Mutates `ai` in place on success,
// matching the other steps' pattern of collecting markers into one object as
// they land.
//
// Done-ness is decided by the stored description, NOT by the ai.thumbVision
// marker: this step originally folded its output into a throwaway `richText`
// local and persisted nothing, so an existing library carries thousands of
// notes marked `thumbVision: true` whose description no longer exists
// anywhere. For those the marker is simply wrong, and only the artifact tells
// the truth. The marker is still written, because it is what the enrichment
// backlog and deriveAiMarkers read elsewhere. See stepsFor's matching note.
async function describeThumb(note, residency, ai) {
  if (residency.vision === 'off' || !note.thumb || note.thumbDescription) return ''
  try {
    const absPath = path.join(UPLOAD_DIR, path.basename(note.thumb))
    const description = await inference.describeImage({ absPath, prompt: DESCRIBE_THUMB_PROMPT })
    ai.thumbVision = true
    return description
  } catch (e) {
    console.error('[enrich] thumbnail vision describe failed:', e.message)
    return ''
  }
}

// Re-runs classify + embed for a note once its Instagram caption has landed
// (see queueIgMeta below), using the note's OWN stored fields — never
// re-fetching link metadata. This is deliberately NOT a re-queued enrichNote
// pass: enrichNote recomputes `url` from the note's content, would see the
// Instagram URL again, and call queueIgMeta again — an endless fetch/patch
// cycle. reclassifyWithCaption never calls fetchLinkMeta or queueIgMeta, so
// that cycle can't happen here by construction. The `ai.igReclassified`
// marker makes a run idempotent per note, which matters if queueIgMeta ever
// fires twice for the same id (e.g. a boot-time backfill racing an
// in-flight import): that can add at most ONE extra reclassify, never an
// unbounded chain of them, and the marker turns that extra one into a no-op.
//
// igReclassified is only set when classify or embed actually SUCCEEDED this
// run — never unconditionally. A transient model failure here still leaves
// `ai.classify: true` from enrichNote's earlier URL-only pass, so if the
// marker were set regardless, stepsFor would never re-offer classify AND
// this marker would block every future reclassify attempt too — stranding
// the note on URL-only metadata forever. Leaving the marker unset just costs
// a redundant (self-healing) reclassify next time something re-triggers it
// (the boot sweep in queueMetaBackfill below, or another queueIgMeta call) —
// this codebase already prefers that tradeoff (see backlog.js's
// deriveAiMarkers comment on the same false-positive-vs-false-negative call).
async function reclassifyWithCaption(id) {
  const residency = settings.getResidency()
  const runClassify = residency.llm !== 'off'
  const runEmbed = residency.embed !== 'off'
  if (!runClassify && !runEmbed) return // both roles off — nothing to (re)run

  const existing = store.allNotes().find((n) => n.id === id)
  if (!existing || existing.ai?.igReclassified) return // deleted, or already re-run once

  const ai = { ...existing.ai }
  // The thumbnail queueIgMeta just fetched is guaranteed to be on disk by the
  // time this runs, so this is where an Instagram note's frame gets described.
  // enrichNote runs the same step for every other kind of note; whichever
  // reaches a given note first wins, and the marker makes the other a no-op.
  const thumbDescription = await describeThumb(existing, residency, ai)

  // Built from stored fields (content + the siteTitle/siteDesc queueIgMeta
  // just patched in) plus the thumbnail description above — no network call
  // for the text fields, mirrors enrichNote's richText assembly otherwise.
  // A description already on the note (from an earlier pass) is reused, so a
  // reclassify that skips the vision call still embeds the same text.
  const thumbText = thumbDescription || existing.thumbDescription || ''
  const richText = [existing.content, existing.siteTitle, existing.siteDesc, existing.article, thumbText]
    .filter(Boolean).join('\n\n')
  if (!richText) return

  const patch = {}
  // Persisted, not just folded into richText: Ask's answer prompt builds its
  // context from the same fields the embedding used (see prompts.js), so a
  // reel retrieved on the strength of its thumbnail description is useless
  // if that description only ever existed as a local in this function.
  // textSearch reads it too.
  if (thumbDescription) patch.thumbDescription = thumbDescription
  let madeProgress = false

  if (runClassify) {
    try {
      const knownTags = tags.buildVocabulary(store.allNotes())
      // The caption's own hashtags are creator-supplied candidate tags —
      // classify() gets a head start reusing them instead of having to
      // re-discover them from unstructured caption prose.
      const candidateTags = tags.extractHashtags(existing.siteDesc)
      const meta = await inference.classify({
        text: richText,
        hasImage: false,
        isUrl: true,
        now: new Date().toISOString(),
        knownTags,
        candidateTags,
      })
      meta.tags = await tagvocab.canonicalize(meta.tags)
      meta.tags = tags.withAccountTag(meta.tags, existing.account)
      Object.assign(patch, meta)
      ai.classify = true
      madeProgress = true
    } catch (e) {
      console.error('[enrich] instagram re-classify failed:', e.message)
    }
  }

  // A user's own tag edit (server/routes/notes.js's handleUpdateNote) always
  // wins over a re-classify: reclassifyWithCaption bypasses stepsFor's normal
  // "already classified, don't touch tags" protection (see enrichNote's own
  // comment on why that protection exists), and the window for a hand edit
  // to land while this note is still sitting in the throttled IG queue can be
  // minutes to tens of minutes — long enough to matter. The caption still
  // improves title/summary/category/embedding either way; only the tags
  // array itself is left alone. This MUST run before the embed block below:
  // toEmbed falls back to `patch.tags ?? existing.tags`, so deleting
  // patch.tags after embedText already ran would still bake the discarded
  // AI tags into the embedding — corrupting semantic search for exactly the
  // notes a user cared enough to hand-curate.
  if (existing.ai?.tagsEdited) delete patch.tags

  if (runEmbed) {
    try {
      const toEmbed = [
        patch.title ?? existing.title,
        patch.summary ?? existing.summary,
        richText,
        (patch.tags ?? existing.tags ?? []).join(' '),
      ].filter(Boolean).join('\n')
      patch.embedding = await inference.embedText(toEmbed || richText)
      ai.embed = true
      madeProgress = true
    } catch (e) {
      console.error('[enrich] instagram re-embed failed:', e.message)
    }
  }

  if (madeProgress) ai.igReclassified = true

  patch.ai = ai
  if (!(await store.updateNote(id, patch))) return // note was deleted mid-run — don't resurrect it via autoAdd
  if (Array.isArray(patch.tags) && patch.tags.length) {
    await collections.autoAdd(id, patch.tags)
  }
}

// Instagram embed fetches get their OWN queue, separate from enrichChain
// (same reasoning as before: the >=2.5s throttle must not park classify/embed
// work). Now an explicit deque instead of a promise chain, so the scrolling
// client can PROMOTE the notes actually on screen to the front — thumbnails
// materialize where the user is looking, not in insertion order.
const igQueue = []          // [{ noteId, url, slides?, resolve? }]
const igQueued = new Set()  // noteIds present in igQueue
const igInFlight = new Set() // noteIds currently mid-runIgJob (shifted out, not yet settled)
let igPumping = false
let igPaused = false        // test hook

// ---- meta retry policy --------------------------------------------------
// A failed Instagram fetch used to permanently set metaFetched — one bad
// network moment and the note never got a thumbnail. Failures now record a
// try count + earliest-next-attempt; the boot backfill re-queues eligible
// notes, up to 5 tries per note.
const META_MAX_TRIES = 5

export function metaRetryDelay(tries) {
  return Math.min(24 * 3600_000, 600_000 * 4 ** tries)
}

export function metaRetryEligible(n, now = Date.now()) {
  if (n.metaFetched) return false
  if ((n.metaTries || 0) >= META_MAX_TRIES) return false
  if (n.metaNextTry && now < n.metaNextTry) return false
  return true
}

// Notes stuck by the OLD failure policy: marked fetched, but no piece of
// metadata actually landed. One retried pass unsticks them.
export function isStuckInstagramNote(n) {
  return !!(n.url && isInstagramPost(n.url) && n.metaFetched && !n.thumb && !n.siteTitle && !n.siteDesc)
}

async function runIgJob({ noteId, url }) {
  const patch = {}
  try {
    const m = await fetchLinkMeta(url, noteId)
    patch.metaFetched = true
    for (const k of ['siteTitle', 'siteDesc', 'siteName', 'thumb', 'article']) {
      if (m[k]) patch[k] = m[k]
    }
  } catch (e) {
    console.error('[enrich] instagram meta fetch failed for', url, '-', e.message)
    // Record a try count + earliest-next-attempt instead of permanently
    // setting metaFetched — see the meta retry policy below. metaFetched is
    // deliberately left untouched here (stays whatever it was, usually
    // absent) so this note keeps failing queueMetaBackfill's `!n.metaFetched`
    // gate on the non-IG path AND stays eligible for metaRetryEligible until
    // the try budget is exhausted.
    const n = store.allNotes().find((x) => x.id === noteId)
    const tries = (n?.metaTries || 0) + 1
    patch.metaTries = tries
    patch.metaNextTry = Date.now() + metaRetryDelay(tries - 1)
  }
  await store.updateNote(noteId, patch)
  if (patch.siteTitle || patch.siteDesc) queueJob(() => reclassifyWithCaption(noteId))
}

async function pumpIg() {
  if (igPumping || igPaused) return
  igPumping = true
  while (igQueue.length) {
    const job = igQueue.shift()
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
      console.error('[enrich] instagram meta job failed:', e.message)
    } finally {
      igInFlight.delete(job.noteId)
      job.resolve?.()
    }
  }
  igPumping = false
}

export function queueIgMeta(noteId, url) {
  if (igQueued.has(noteId) || igInFlight.has(noteId)) return
  igQueued.add(noteId)
  igQueue.push({ noteId, url })
  pumpIg()
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
async function runSlidesJob({ noteId, url }) {
  let slides
  try {
    slides = await fetchInstagramSlides(url, noteId)
  } catch (e) {
    console.error('[enrich] instagram slides fetch failed for', url, '-', e.message)
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
const slidesWaiters = new Map()  // noteId → in-flight promise

export function queueIgSlides(noteId, url) {
  const running = slidesWaiters.get(noteId)
  if (running) return running
  let resolve
  const done = new Promise((r) => { resolve = r })
  const p = done.finally(() => slidesWaiters.delete(noteId))
  slidesWaiters.set(noteId, p)
  igQueue.unshift({ noteId, url, slides: true, resolve })
  pumpIg()
  return p
}

// Move the given noteIds (those still queued) to the FRONT, preserving the
// caller's order. Unknown / already-fetched ids are ignored — callers send
// whatever is on screen without checking.
export function promoteIgMeta(ids) {
  const want = ids.filter((id) => igQueued.has(id))
  if (!want.length) return 0
  const wantSet = new Set(want)
  const rest = igQueue.filter((j) => !wantSet.has(j.noteId))
  const front = want.map((id) => igQueue.find((j) => j.noteId === id)).filter(Boolean)
  igQueue.length = 0
  igQueue.push(...front, ...rest)
  return front.length
}

// test-only inspection/pause hooks
export const _igQueueState = {
  pause() { igPaused = true },
  resume() { igPaused = false; pumpIg() },
  clear() { igQueue.length = 0; igQueued.clear(); igInFlight.clear(); igPaused = false },
  ids() { return igQueue.map((j) => j.noteId) },
  pumping() { return igPumping },
  inFlight() { return [...igInFlight] },
}

// One-shot backfill for link/video notes saved before metadata support (or
// while offline): fetch their oEmbed/OpenGraph data on boot.
export function queueMetaBackfill() {
  for (const n of store.allNotes()) {
    // Note: the outer gate here does NOT check !n.metaFetched — a note stuck
    // by the OLD permanent-failure policy has metaFetched: true with nothing
    // else landed, and still needs to reach the Instagram branch below to be
    // unstuck. The non-IG generic branch re-adds its own !n.metaFetched gate
    // — its unconditional "tried once, done forever" behavior is unchanged.
    if ((n.type === 'link' || n.type === 'video') && n.url && !n.siteTitle) {
      // Same off-chain reasoning as queueIgMeta above: a boot with many
      // stale Instagram notes (e.g. the process died mid-import before their
      // Instagram meta queue job landed) must not stall backfill for every other note.
      if (isInstagramPost(n.url)) {
        if (isStuckInstagramNote(n)) {
          // Stuck by the OLD policy (permanent metaFetched:true, no retry).
          // Clear the stale flag and give it a fresh, bounded retry budget so
          // this and future boots actually attempt it again.
          store.updateNote(n.id, { metaFetched: false, metaTries: 1, metaNextTry: 0 }).catch(() => {})
          queueIgMeta(n.id, n.url)
        } else if (metaRetryEligible(n)) {
          queueIgMeta(n.id, n.url)
        }
        continue
      }
      if (!n.metaFetched) {
        queueJob(async () => {
          const patch = { metaFetched: true }
          try {
            const m = await fetchLinkMeta(n.url, n.id)
            for (const k of ['siteTitle', 'siteDesc', 'siteName', 'thumb', 'article']) {
              if (m[k]) patch[k] = m[k]
            }
          } catch (e) {
            console.error('[enrich] meta backfill failed for', n.url, '-', e.message)
          }
          await store.updateNote(n.id, patch)
        })
      }
    }
    // Separate sweep, not an `else if`: a note can have its caption (from a
    // completed IG fetch) while still lacking a reclassify — e.g. the
    // process restarted between queueIgMeta's store.updateNote and its
    // queueJob(reclassifyWithCaption) call, or the reclassify itself failed
    // (see reclassifyWithCaption's comment on why it doesn't set the marker
    // on failure). Such a note fails BOTH gates above (metaFetched is
    // already true, so the block above skips it) and stepsFor's classify gate
    // (ai.classify is already true from the original URL-only pass) — so
    // without this, it would stay on URL-only metadata forever. On a large
    // import a restart inside the ~2.5s/post throttle window is routine, not
    // an edge case.
    if (isInstagramPost(n.url) && (n.siteTitle || n.siteDesc) && !n.ai?.igReclassified) {
      queueJob(() => reclassifyWithCaption(n.id))
    }
    // Captions arrived after these notes were saved, so they carry no
    // `ai.captions` marker and none of the gates above would reach them: a
    // YouTube note that already has its oEmbed title fails the `!n.siteTitle`
    // check, and stepsFor never offers a step that needs no model. One
    // enrichNote pass per video, self-limiting — the marker (set on success
    // OR on a definitive "this video has no captions") stops the next boot
    // from re-queuing it.
    if (n.url && isYouTubeVideo(n.url) && !n.ai?.captions) {
      queueEnrich(n.id, enrichArgsFor(n))
    }
  }
}

// Enrich one note under the current residency: each step runs only if its
// role is enabled AND the note doesn't already carry that step's marker —
// `steps` (from stepsFor) is the single source of truth for "what's actually
// missing," computed once against the note's state as of the start of this
// run. This matters beyond avoiding wasted compute: rerunning classify on an
// already-classified note would silently overwrite any tags the user has
// since edited by hand (Object.assign(patch, meta) → store.updateNote's
// shallow merge), and rerunning vision would duplicate the caption into
// note.content. A fresh note has no `ai` markers yet, so stepsFor naturally
// returns every applicable step — this covers both the original
// just-saved path and a later backlog resweep with the same function.
// Link metadata needs no model and always runs regardless of `steps`.
async function enrichNote(id, { absPath, text, isUrl, hasImage }) {
  const residency = settings.getResidency()
  const existing = store.allNotes().find((n) => n.id === id)
  const steps = stepsFor(existing || {}, residency)
  const ai = {}

  let visionDescription = ''
  if (hasImage && absPath && steps.includes('vision')) {
    try {
      visionDescription = await inference.describeImage({ absPath })
      ai.vision = true
    } catch (e) {
      console.error('[enrich] vision describe failed:', e.message)
    }
  }

  // Link/video metadata (oEmbed / OpenGraph), fetched once and cached locally.
  // Done before classification so the page title/description inform the LLM
  // and the embedding — "QWEN3 docs" beats "https://docs.qvac…" for search.
  // Instagram is the one exception: its fetch is routed to queueIgMeta's own
  // FIFO instead of awaited here (see queueIgMeta above for why). But on a
  // RESWEEP (queueBacklog re-running this note after its Instagram fetch
  // already completed — e.g. the embed role got switched on after import),
  // the caption is already sitting in siteTitle/siteDesc on disk: reuse it
  // here rather than leaving richText caption-less (which would silently
  // regress classify/embed back to URL-only quality on every resweep) or
  // re-queuing another throttled fetch for data that's already there. On a
  // genuinely first pass `existing` has no siteTitle yet, so this is null —
  // first-pass behavior (richText excludes the caption; queueIgMeta fires)
  // is unchanged.
  //
  // metaFetched alone isn't enough to skip the re-fetch, though: a FAILED
  // fetch now leaves metaFetched falsy (tracked instead via metaTries/
  // metaNextTry — see the meta retry policy above), so `!existing?.metaFetched`
  // already fires directly for a still-failing note; the `|| !(siteTitle ||
  // siteDesc)` half is just a caption-check fallback for the edge case where
  // metaFetched is true but nothing landed (i.e. a note isStuckInstagramNote
  // hasn't unstuck yet). A 429/soft-ban is common mid-bulk-import, exactly
  // when this fires. A resweep is user-initiated (a role toggle), not
  // boot-time, so retrying here doesn't reintroduce the startup-hammering
  // this design avoids.
  const url = isUrl ? text : inference.extractUrl(text)
  const isIgUrl = !!url && isInstagramPost(url)
  let linkMeta = isIgUrl ? { siteTitle: existing?.siteTitle ?? null, siteDesc: existing?.siteDesc ?? null } : null
  if (url && !hasImage) {
    if (isIgUrl) {
      if (!existing?.metaFetched || !(existing?.siteTitle || existing?.siteDesc)) queueIgMeta(id, url)
    } else if (existing?.metaFetched && (existing.siteTitle || existing.siteDesc || existing.thumb)) {
      // The fast lane above already fetched this note's metadata. Reuse it
      // rather than paying for a second identical request — and reuse it as a
      // linkMeta OBJECT, not by skipping the step, because richText below
      // feeds siteTitle/siteDesc/article to classify and embed. Skipping
      // outright would quietly downgrade every fast-lane note's classification
      // to URL-only.
      linkMeta = {
        siteTitle: existing.siteTitle ?? null,
        siteDesc: existing.siteDesc ?? null,
        siteName: existing.siteName ?? null,
        thumb: existing.thumb ?? null,
        article: existing.article ?? null,
        author: null, // account was already resolved by the fast lane
      }
    } else {
      try {
        linkMeta = await fetchLinkMeta(url, id)
      } catch (e) {
        console.error('[enrich] meta fetch failed:', e.message)
      }
    }
  }

  // Thumbnail vision, for any note that has a cover frame — the link meta
  // fetched just above downloads one for most links, and a resweep sees the
  // one already on disk from an earlier pass. Kept separate from the `vision`
  // step above, which is about an image the USER attached: these are two
  // different pictures with two different prompts, and a note can have both.
  const thumb = linkMeta?.thumb || existing?.thumb
  const thumbDescription = thumb
    ? await describeThumb({ ...existing, thumb }, residency, ai)
    : ''

  // YouTube captions — the actual content of a saved video, and the one
  // platform that publishes a transcript for the asking (no download, no
  // speech-to-text; see meta.js). Not a model step, so it is gated on its own
  // `ai.captions` marker rather than on residency: a video's transcript is
  // worth having for textSearch and the answer prompt even with every model
  // role off. `done` distinguishes "this video has no captions" (final —
  // record it and never ask again) from "not right now" (leave the marker
  // unset so a later pass retries), matching how every other marker in this
  // file treats permanent versus transient outcomes.
  let captions = null
  if (url && !hasImage && !existing?.ai?.captions && isYouTubeVideo(url)) {
    const result = await fetchYouTubeCaptions(url)
    if (result.done) ai.captions = true
    if (result.text) captions = result.text
  }

  const richText = [text, visionDescription, linkMeta?.siteTitle, linkMeta?.siteDesc, linkMeta?.article, captions, thumbDescription]
    .filter(Boolean)
    .join('\n\n')

  // Instagram notes must not get a `metaFetched` KEY here at all — not even
  // `false`. queueIgMeta usually finishes before this slower classify/embed
  // pass does (fetch is fast, classify is slow), so if this patch carried
  // `metaFetched: false`, store.updateNote's shallow-merge Object.assign
  // would clobber the `true` queueIgMeta already wrote back to `false`. That
  // re-opens queueMetaBackfill's `!n.siteTitle && !n.metaFetched` gate on
  // every boot for any IG note whose fetch found nothing (the common case in
  // a bulk import) — re-fetching the whole set at 2.5s each on every
  // restart, exactly the boot-time hammering this design exists to avoid.
  // The deferred queueIgMeta job sets `metaFetched` itself once it actually
  // runs, so a crash between "queued" and "fetched" still can't leave a note
  // permanently marked as attempted when the attempt never happened.
  const patch = { pending: false }
  if (!isIgUrl) patch.metaFetched = !!url
  // Persisted for the same reason reclassifyWithCaption persists it: the
  // answer prompt and textSearch both read this field off the note.
  if (thumbDescription) patch.thumbDescription = thumbDescription
  if (captions) {
    // The transcript IS the article for a video note — Readability on a
    // watch page yields player chrome, not content, so there is nothing of
    // value to preserve here.
    patch.article = captions
    // New text the note has never been embedded with. Without this, a
    // YouTube note swept up by the caption backfill below would already
    // carry ai.embed from its original URL-only pass, stepsFor would not
    // offer 'embed', and the transcript would sit on disk contributing
    // nothing to retrieval — the exact asymmetry this whole change set
    // exists to remove.
    if (residency.embed !== 'off' && !steps.includes('embed')) steps.push('embed')
  }
  // Same reasoning for a thumbnail description arriving on a note that was
  // classified and embedded before this step reached it.
  if (thumbDescription && residency.embed !== 'off' && !steps.includes('embed')) steps.push('embed')
  if (visionDescription) {
    patch.description = visionDescription
    patch.content = [text, visionDescription].filter(Boolean).join('\n\n')
    patch.summary = visionDescription
  }
  const applyLinkMeta = () => {
    if (!linkMeta) return
    for (const k of ['siteTitle', 'siteDesc', 'siteName', 'thumb', 'article']) {
      if (linkMeta[k]) patch[k] = linkMeta[k]
    }
    // `author` → `account` (different names, so not part of the loop above).
    // Only when the note has none: an importer that already knows the handle
    // (Instagram reads it straight from the export) and a handle the user has
    // edited by hand both outrank a provider's display name.
    if (linkMeta.author && !existing?.account) patch.account = linkMeta.author
  }
  if (isUrl) applyLinkMeta()

  if (richText && steps.includes('classify')) {
    try {
      const knownTags = tags.buildVocabulary(store.allNotes())
      const meta = await inference.classify({
        text: richText,
        hasImage,
        isUrl,
        now: new Date().toISOString(),
        knownTags,
      })
      // Snap LLM-generated tags to existing semantic equivalents (forward-only).
      meta.tags = await tagvocab.canonicalize(meta.tags)
      // Deterministic — never routed through the LLM/junk-filter/canonicalize,
      // since a handle is an identity, not a concept those steps should judge.
      // patch.account first: applyLinkMeta may have just learned the handle
      // in THIS run (see above), and reading only `existing` would tag the
      // note on the next sweep instead of now — or never, since a later run
      // sees classify already done.
      meta.tags = tags.withAccountTag(meta.tags, patch.account ?? existing?.account)
      if (hasImage) meta.type = 'image' // an attached image is always an image note
      // The LLM may upgrade plain text to link/video (e.g. "check out
      // www.foo.com") — make sure the card has a URL to open, or demote it
      // back to text so it doesn't render as a dead link.
      if (!isUrl && (meta.type === 'link' || meta.type === 'video')) {
        if (url) {
          patch.url = url
          applyLinkMeta()
        } else meta.type = 'text'
      }
      Object.assign(patch, meta)
      // A hand edit always wins over a re-classify, exactly as it does in
      // reclassifyWithCaption. This never mattered while classify only ran on
      // notes that had never been classified — a note cannot have edited tags
      // and no classification. retagAll changed that: it re-opens the step
      // across the whole library at once, so without this a single bulk action
      // would erase every tag the user had corrected by hand. The rest of the
      // re-classification (title, summary, category, embedding) still lands.
      if (existing?.ai?.tagsEdited) delete patch.tags
      ai.classify = true
    } catch (e) {
      console.error('[enrich] AI classify failed, keeping heuristics:', e.message)
    }
  }

  if (richText && steps.includes('embed')) {
    try {
      // classify may not have run this pass (already done, or its role is
      // off) — fall back to the note's existing title/summary/tags so the
      // embedding still reflects full context, not just the raw richText.
      const toEmbed = [
        patch.title ?? existing?.title,
        patch.summary ?? existing?.summary,
        richText,
        (patch.tags ?? existing?.tags ?? []).join(' '),
      ].filter(Boolean).join('\n')
      patch.embedding = await inference.embedText(toEmbed || richText)
      ai.embed = true
      ai.embedRecipe = EMBED_RECIPE
    } catch (e) {
      console.error('[enrich] embed failed:', e.message)
    }
  }

  patch.ai = { ...existing?.ai, ...ai }
  // Mirrors reclassifyWithCaption's own guard: if the note was deleted (or,
  // for an import, never actually persisted — see routes/import.js's flush
  // rollback) mid-run, updateNote returns null. Without this check, a ghost
  // id would still reach autoAdd below and land permanently in a smart
  // collection's itemIds — nothing ever calls deleteItemEverywhere for a
  // note that was never really there to begin with.
  if (!(await store.updateNote(id, patch))) return
  // Smart-collection auto-add: the LLM only sets tags on success, so
  // heuristic-only notes carry none and simply match nothing.
  if (Array.isArray(patch.tags) && patch.tags.length) {
    await collections.autoAdd(id, patch.tags)
  }
}

// Re-embed every note in the library, in one batched write.
//
// Two things invalidate the whole vector set: swapping the embedding model
// (a different model is a different space) and changing the recipe — the task
// prefixes, or which fields feed the input (see prompts.js's EMBED_RECIPE).
// Both used to be handled by a loop inlined in routes/settings.js that only
// the model-swap path could reach; it lives here now so the boot-time recipe
// check runs exactly the same code.
//
// The input mirrors enrichNote's own toEmbed assembly rather than the shorter
// title/summary/content/tags list the inlined version used. That list predated
// link enrichment and quietly dropped siteTitle, siteDesc, the article body
// and the thumbnail description — so every re-embed silently downgraded the
// library's vectors to less than the original enrichment had produced.
//
// Failures are per-note: one unembeddable note must not abandon the other
// 1,700. `{ persist: false }` batches the writes into a single transaction at
// the end, exactly as before.
export function embedBodyFor(note) {
  return [
    note.title,
    note.summary,
    note.content,
    note.siteTitle,
    note.siteDesc,
    note.article,
    note.thumbDescription,
    (note.tags || []).join(' '),
  ].filter(Boolean).join('\n')
}

export async function reembedAll(reason = 'settings') {
  const notes = store.allNotes()
  console.log(`[enrich] re-embedding ${notes.length} notes (${reason})…`)
  for (const n of notes) {
    try {
      const body = embedBodyFor(n)
      if (body) {
        await store.updateNote(n.id, { embedding: await inference.embedText(body) }, { persist: false })
      }
    } catch (e) {
      console.error('[enrich] re-embed failed for', n.id, '-', e.message)
    }
  }
  await store.flush() // one write for the whole batch, not one per note
  await settings.save({ embedRecipe: EMBED_RECIPE })
  console.log('[enrich] re-embedding done')
  return notes.length
}

// Queue a full re-embed when the stored vectors were built under a different
// recipe than the one this build uses — called once at boot. Returns whether
// anything was queued, so index.js can say so.
//
// Deliberately silent when the embed role is off: with no embedding model
// there is nothing to re-embed, and recording the new recipe anyway would
// mean the sweep never runs once the role IS switched on. Leaving the marker
// stale is the self-healing choice, the same call every AI marker in this
// file makes.
export function queueRecipeReembed() {
  if (settings.getResidency().embed === 'off') return false
  if (settings.getEmbedRecipe() === EMBED_RECIPE) return false
  if (!store.count()) {
    settings.save({ embedRecipe: EMBED_RECIPE }).catch(() => {})
    return false
  }
  queueJob(() => reembedAll(`recipe ${settings.getEmbedRecipe() || 'unset'} → ${EMBED_RECIPE}`))
  return true
}

// Build the enrichNote job args for an existing note — same shape a fresh
// /api/save posts, so a resweep or a forced retag behaves identically to a
// brand-new save.
function enrichArgsFor(note) {
  return {
    absPath: note.image ? path.join(UPLOAD_DIR, path.basename(note.image)) : null,
    text: note.content,
    isUrl: inference.isLikelyUrl(note.content),
    hasImage: !!note.image,
  }
}

// Queue every note that is missing a step the current residency can perform.
// Returns how many were queued (surfaced by the settings backlog endpoint).
export function queueBacklog() {
  // A provider whose circuit is open cannot do useful work — enqueueing here
  // would burn the whole backlog against a dead (and possibly metered)
  // endpoint. Returning 0 lets the route tell the user why nothing happened.
  if (!inference.available()) return 0
  const residency = settings.getResidency()
  const todo = store.allNotes().filter((n) => stepsFor(n, residency).length > 0)
  for (const n of todo) queueEnrich(n.id, enrichArgsFor(n))
  return todo.length
}

// Re-run classify + embed across the WHOLE library — the "re-tag everything"
// action in Settings. Queues the same enrichNote pass a fresh save gets, so a
// note ends up classified from everything it now carries: its caption, its
// article or transcript, and its thumbnail description. That last one is the
// point of the action existing. queueBacklog only offers steps a note is
// MISSING, and a note classified months ago from its URL alone is not missing
// classify — it has a bad one, which no amount of enriching will replace.
//
// Two deliberate differences from retagNote's single-note version:
//
//   - Hand-edited tags are KEPT (tagsEdited is not cleared). Per note, "Re-tag"
//     is an explicit instruction about that note and discarding its edits is
//     what was asked for. Across 1,700 notes it is not: one click would
//     silently destroy every correction the user has ever made, with no undo.
//     enrichNote's classify step honours the marker, so those notes still get
//     a better title, summary, category and embedding — just not new tags.
//   - Writes are batched. One updateNote per note would be one disk write per
//     note; this is a single transaction, matching the settings re-embed.
//
// Vision markers are left alone: re-describing every thumbnail is a far longer
// job with its own backlog entry, and this action is about classification.
export async function retagAll() {
  if (!inference.available()) return 0
  const notes = store.allNotes()
  if (!notes.length) return 0 // nothing to mark, nothing to flush
  for (const n of notes) {
    const ai = { ...n.ai, classify: false, embed: false }
    await store.updateNote(n.id, { pending: true, ai }, { persist: false })
  }
  await store.flush()
  // Queued only after the flush: a crash midway through would otherwise leave
  // notes marked pending with nothing queued to clear it.
  for (const n of notes) queueEnrich(n.id, enrichArgsFor(n))
  return notes.length
}

// Force a full re-run of classify/embed/vision for ONE note, discarding its
// current tags (including any hand edits) — the explicit "Re-tag" action from
// the item's detail view. Unlike queueBacklog (which only touches notes
// missing a step) this clears the note's markers first, so an
// already-classified note is eligible again. tagsEdited is cleared too: the
// whole point of this action is to replace the tags, hand-edited or not.
// Returns the (now-pending) note, or null if the id doesn't exist.
export async function retagNote(id) {
  const existing = store.allNotes().find((n) => n.id === id)
  if (!existing) return null
  const ai = { ...existing.ai, classify: false, embed: false, tagsEdited: false }
  if (existing.image) ai.vision = false
  const note = await store.updateNote(id, { pending: true, ai })
  if (!note) return null
  queueEnrich(id, enrichArgsFor(note))
  return note
}
