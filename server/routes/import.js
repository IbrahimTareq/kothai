// POST /api/import — ties together the ZIP reader, the importer registry, and
// the phase-one save + background-enrich pattern used by handleSave. This is
// the ONLY consumer of server/import/* today.
import * as store from '../data/notes.js'
import * as collections from '../data/collections.js'
import * as enrich from '../ai/enrich.js'
import { findImporter, getImporter, importerNames } from '../import/index.js'
import { readZip, MAX_TOTAL_BYTES } from '../lib/zip.js'
import { json, readBody } from '../lib/http.js'

// Uploads arrive as JSON { name, data } with data base64 (raw or data-URL),
// matching the app's existing pasted-image transport. This bounds the RAW
// HTTP body (the JSON text, which is mostly the base64 string) — base64
// inflates the underlying file by ~4/3, so this comfortably covers a Meta
// export in the tens of megabytes without the request itself ballooning
// past what readBody buffers in memory before handing it to JSON.parse.
const BODY_LIMIT = 64 * 1024 * 1024

// A real export is a handful of files (or one ZIP). This only exists to stop
// a request from carrying thousands of tiny uploads, each of which costs a
// base64 decode and a ZIP scan before the body limit above would notice.
const MAX_UPLOADS = 20

// Kothai is single-user/local-first, so a full mutex around the note store
// would be overkill — but two overlapping imports both read store.allNotes()
// for their own url-dedup snapshot before either has written anything, so
// neither would see the other's in-flight additions and the same post could
// be imported twice. Serializing imports against EACH OTHER (not against
// every other route) closes that specific window cheaply, without touching
// the shared store's concurrency story elsewhere.
let importInProgress = false

// Read by the wipe route, which must refuse while an import is mid-flight —
// an import holds unflushed notes in memory, so a wipe landing between its
// addNote() loop and its flush() would be undone by that flush.
export function isImportInProgress() {
  return importInProgress
}

export async function handleImport(req, res) {
  if (importInProgress) {
    return json(res, 409, { error: 'Another import is already in progress. Try again once it finishes.', code: 'import_in_progress' })
  }
  importInProgress = true
  try {
    await runImport(req, res)
  } finally {
    importInProgress = false
  }
}

// A note is deduped/matched by a CANONICAL form of its URL, not the raw
// string: a manually-saved link and the same post re-arriving via export
// almost never share byte-identical URLs. Real variance seen in the wild —
// Instagram's own "Copy link" appends a `?igsh=...` tracking param, `www.`
// is optional, a trailing slash is cosmetic, and the SAME post can be typed
// as either `/p/<code>/` or `/reel/<code>/` depending on where the "Saved
// on" href came from.
//
// This normalization is Instagram-specific ONLY for the shortcode collapse
// (host === instagram.com). For every other host, the query string and port
// are load-bearing and MUST be kept: `youtube.com/watch?v=AAA` and
// `?v=BBB` are different videos, `news.ycombinator.com/item?id=1` and
// `?id=2` are different threads, and `example.com:8443/a` and `:9999/a` can
// be entirely different services. Dropping them (an earlier version of this
// function did, via `.pathname` alone) silently MERGES distinct links —
// worse than the duplication problem this function exists to fix, since a
// merge drops one of the two notes entirely rather than just double-saving
// it. A small tracking-param allowlist is still stripped so the intended
// benefit (surviving a shared/copied link's tracking noise) applies outside
// Instagram too, without touching anything that could be a real identifier.
// TikTok reaches the same video by three different URLs: the export's
// `tiktokv.com/share/video/<id>/`, the canonical `tiktok.com/@user/video/<id>`
// a person would paste from the app, and the handle-less
// `tiktok.com/video/<id>` the importer rewrites to. The numeric id is the
// identity, so all three collapse to one key — without this, saving a TikTok
// by hand and then importing your favourites would store it twice.
const TT_HOST = /(^|\.)(tiktok\.com|tiktokv\.com)$/
const TT_VIDEO_ID = /\/(?:share\/)?video\/(\d+)/
const IG_HOST = /(^|\.)instagram\.com$/
const IG_SHORTCODE = /\/(?:p|reel|reels|tv)\/([^/]+)/i // path keyword case-insensitive; shortcode itself stays case-sensitive (Instagram shortcodes are)
// utm_*/igsh/fbclid are unambiguous tracking noise on ANY host. `si` is NOT —
// it's a YouTube/Spotify share-tracking param, but on an arbitrary site it
// could just as easily be a real query param (e.g. a search-index id), so
// stripping it globally would false-merge distinct links there. Scope it.
const GLOBAL_TRACKING_PARAM = /^utm_|^igsh$|^fbclid$/i
const SI_TRACKING_HOSTS = /(^|\.)(youtube\.com|youtu\.be|spotify\.com)$/

function stripTrackingParams(search, host) {
  if (!search) return ''
  const params = new URLSearchParams(search)
  const stripSi = SI_TRACKING_HOSTS.test(host)
  for (const key of [...params.keys()]) {
    if (GLOBAL_TRACKING_PARAM.test(key) || (stripSi && key.toLowerCase() === 'si')) params.delete(key)
  }
  const s = params.toString()
  return s ? `?${s}` : ''
}

function canonicalUrl(raw) {
  if (typeof raw !== 'string' || !raw) return ''
  let u
  try {
    u = new URL(raw)
  } catch {
    // Not a parseable URL at all — fall back to a best-effort normalized
    // string rather than treating it as "no url" (which would make it
    // un-dedupeable in either direction).
    return raw.trim().toLowerCase()
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  const path = u.pathname.replace(/\/+$/, '') || '/'
  if (TT_HOST.test(host)) {
    const m = path.match(TT_VIDEO_ID)
    if (m) return `tiktok:${m[1]}`
  }
  if (IG_HOST.test(host)) {
    const m = path.match(IG_SHORTCODE)
    if (m) return `instagram:${m[1]}` // /p/, /reel/, /reels/, /tv/ for the same code are the same post
  }
  const port = u.port ? `:${u.port}` : ''
  return `${host}${port}${path}${stripTrackingParams(u.search, host)}`
}

async function runImport(req, res) {
  let body
  try {
    body = await readBody(req, BODY_LIMIT)
  } catch (e) {
    // readBody rejects (never throws a raw RangeError-shaped surprise) on
    // both "too big" and "not valid JSON" — map both to a clean 4xx instead
    // of falling through to the router's generic 500 catch-all, since an
    // oversized/malformed upload is entirely expected user-facing input here.
    const tooLarge = /payload too large/i.test(e.message)
    return json(res, tooLarge ? 413 : 400, {
      error: tooLarge ? 'That file is too large to import.' : 'Could not read the upload as JSON.',
    })
  }
  // readBody resolves `null` as-is for a literal `null` body (valid JSON,
  // not an object) — guard before touching body.data instead of letting
  // that TypeError fall into the router's generic 500.
  if (!body || typeof body !== 'object') {
    return json(res, 400, { error: 'Invalid request body.' })
  }

  // One import can carry several uploads: an Instagram export hands you
  // saved_posts.json and saved_collections.json as separate files, and
  // making the user import them one at a time is exactly the flow that used
  // to lose their collections. `{ name, data }` stays valid as the one-file
  // shorthand the client used before this.
  const uploads = Array.isArray(body.files) ? body.files : [{ name: body.name, data: body.data }]
  if (!uploads.length) return json(res, 400, { error: 'Provide at least one file.' })
  if (uploads.length > MAX_UPLOADS) {
    return json(res, 400, { error: `Too many files at once — import up to ${MAX_UPLOADS} at a time.` })
  }

  const files = new Map()
  // Decompression budget shared across every archive in this request. Left
  // per-call (readZip's own default), N archives would each get the full
  // MAX_TOTAL_BYTES, so splitting one zip bomb into ten uploads would buy
  // ten times the budget — see server/lib/zip.js.
  let zipBudget = MAX_TOTAL_BYTES
  for (const [i, upload] of uploads.entries()) {
    if (!upload || typeof upload !== 'object') return json(res, 400, { error: 'Invalid file in upload.' })
    const b64 = (upload.data || '').toString().replace(/^data:[^;]*;base64,/, '')
    if (!b64) return json(res, 400, { error: 'Provide each file as base64 `data`.' })
    const buf = Buffer.from(b64, 'base64')

    // ZIP magic "PK" → unpack; anything else is treated as a single JSON file
    // (lets someone import a bare saved_posts.json without zipping it first).
    if (buf[0] === 0x50 && buf[1] === 0x4b) {
      let entries
      try {
        entries = readZip(buf, { maxTotalBytes: zipBudget })
      } catch (e) {
        return json(res, 400, { error: 'Could not read that ZIP: ' + e.message })
      }
      for (const [entryName, entryBuf] of entries) {
        zipBudget -= entryBuf.length
        // Prefixed with the upload's index so two uploads carrying the same
        // path (two partial exports, both with saved_posts.json) can't
        // overwrite each other in this Map. Importers match filenames with
        // `(^|\/)name$`, so a path prefix reads exactly like the directory
        // prefix real export ZIPs already carry.
        files.set(`${i}/${entryName}`, entryBuf)
      }
    } else {
      files.set(`${i}/${(upload.name || 'upload.json').toString()}`, buf)
    }
  }

  // The Import section the user dropped onto names its own platform, so the
  // route can check the upload against THAT importer and say what was
  // expected. Sniffing across all importers stays as the fallback for the
  // untagged single-file API.
  let importer
  if (body.source != null) {
    importer = getImporter(String(body.source))
    if (!importer) {
      return json(res, 400, { error: `Unknown import source. Expected one of: ${importerNames().join(', ')}.` })
    }
    let matches = false
    try {
      matches = importer.sniff(files)
    } catch { matches = false }
    if (!matches) {
      return json(res, 400, {
        error: `That doesn't look like ${importer.label || importer.name} data — expected ${importer.expects || 'the export files'}.`,
        code: 'import_source_mismatch',
      })
    }
  } else {
    importer = findImporter(files)
    if (!importer) {
      return json(res, 400, { error: 'Not a recognized export. Expected an Instagram data export (ZIP or saved_posts.json).' })
    }
  }

  let parsed
  try {
    parsed = importer.parse(files)
  } catch (e) {
    // parse() is documented to degrade rather than throw, but the route is
    // the trust boundary for this upload — an unexpected throw here must
    // still land as a clean 400, not the router's generic 500.
    return json(res, 400, { error: 'Could not parse that export: ' + e.message })
  }
  // A future importer that omits/mis-shapes any of these must not turn into
  // an unhandled throw further down (the .push()/.length/for-of calls below).
  const items = Array.isArray(parsed.items) ? parsed.items : []
  // [{ name, urls }] — a collection's own member URLs, resolved to note ids
  // further down rather than joined onto `items` by the parser. See the
  // filing block below for why that ordering matters.
  const parsedCollections = Array.isArray(parsed.collections) ? parsed.collections : []
  const warnings = Array.isArray(parsed.warnings) ? parsed.warnings.slice() : []

  // urlIndex maps canonicalUrl -> noteId for EVERY note that will exist by
  // the end of this import — pre-existing ones (seeded here) plus newly
  // imported ones (added as the loop below goes). It serves two purposes at
  // once: url-dedup (a canonical match, from either source, means "skip")
  // and, after the loop, resolving which note id a collection member
  // actually refers to — including items that were skipped as duplicates
  // (see the collections-filing comment below for why that matters).
  const urlIndex = new Map()
  for (const n of store.allNotes()) {
    if (!n.url) continue
    const c = canonicalUrl(n.url)
    if (c && !urlIndex.has(c)) urlIndex.set(c, n.id)
  }

  const imported = [] // [{ id, url }] added THIS run, in order — url is kept alongside id so enrich can be queued after the fact without re-deriving it
  let skipped = 0
  let failed = 0
  for (const item of items) {
    const c = canonicalUrl(item.url)
    if (!c || urlIndex.has(c)) { skipped++; continue }
    let note
    try {
      // persist:false — see the batched flush() below. Nothing here does
      // disk I/O, so a mid-loop failure can only be a logic bug, not a
      // partial disk write; caught per-item so one bad row can't sink the
      // whole import.
      note = await store.addNote(importer.deriveNote(item), { persist: false })
    } catch (e) {
      console.error('[import] failed to add note for', item.url, '-', e.message)
      failed++
      continue
    }
    urlIndex.set(c, note.id)
    imported.push({ id: note.id, url: item.url })
  }

  // One write for the whole batch instead of one per item (see addNote's
  // persist:false doc comment). A failure here (e.g. disk full) must NOT be
  // reported as a partial success: the notes only exist in memory, so a
  // reported "imported: N" would make an immediate retry see them as
  // already-there (via urlIndex) and skip them — silently losing them for
  // good if the process restarts before anything else happens to persist.
  // Roll the just-added records back out of memory (no persist attempt of
  // its own — see removeMany's doc comment) and fail loudly instead, so a
  // retry genuinely re-imports everything.
  if (imported.length) {
    try {
      await store.flush()
    } catch (e) {
      console.error('[import] failed to persist imported notes, rolling back:', e.message)
      await store.removeMany(imported.map((n) => n.id))
      return json(res, 500, { error: `Could not save imported notes (${e.message}). Nothing was imported — try again.`, code: 'import_rolled_back' })
    }
  }

  // Background enrichment is queued only NOW, after a successful flush —
  // not inside the loop above. Queueing earlier would leave orphaned jobs
  // for ids that get rolled back on a flush failure: enrichNote would then
  // classify/embed a note that was never actually persisted, burn a
  // throttled Instagram fetch (~2.5s) per rolled-back post, and — since
  // autoAdd has no way to know the id was rolled back — permanently leave a
  // ghost id in a smart collection's itemIds (nothing ever calls
  // deleteItemEverywhere for a note that was never really "deleted", just
  // never truly there). enrich.js's enrichNote now also guards on
  // updateNote returning null as defense in depth, but relying on that
  // alone would still pay the throttled-fetch cost for nothing.
  //
  // queueEnrich can't throw synchronously today (queueJob wraps its work in
  // .then().catch()) — but if that ever changed, an uncaught throw HERE
  // would escape into the router's generic 500 AFTER the flush already
  // succeeded, telling the user "nothing was imported" when everything was.
  // Cheap insurance: the notes are already durably persisted either way: at
  // worst, some/all miss their background enrich pass until the next
  // backlog sweep (queueMetaBackfill / queueBacklog) picks them up.
  try {
    for (const { id, url } of imported) {
      enrich.queueEnrich(id, { absPath: null, text: url, isUrl: true, hasImage: false })
    }
  } catch (e) {
    console.error('[import] failed to queue enrich for imported notes:', e.message)
  }

  // Mirror IG collections → Spaces: match by name (case-insensitive), create
  // what's missing, file members in. Resolved from `items` (via urlIndex),
  // NOT from `imported` — a re-import where the post already exists
  // (skipped above) but now carries a collection it didn't before (the user
  // added it to an IG collection since the last export) must still file the
  // EXISTING note into that Space; filtering to only newly-added notes would
  // mean collections can never sync after the very first import.
  let touchedCollections = 0
  let unresolvedMembers = 0
  if (parsedCollections.length) {
    // Hoisted out of the loop: collections.all() is O(collections), and
    // calling it (plus an O(collections) .find()) once per IG collection
    // name is the same O(names × spaces) shape server/import/instagram.js's
    // own parse() was rewritten to avoid for hrefs — do the same here with a
    // lowercase-name index, kept up to date as new Spaces get created below.
    //
    // On a name COLLISION, prefer a PLAIN Space over a smart one. all() is
    // newest-first (collections.create() unshifts), so a naive "last one
    // wins" build of this index hands back whichever of the two is OLDER —
    // and since the smart branch below refuses to touch a smart Space and
    // creates a fresh "<name> (Instagram)" mirror instead, an index that
    // keeps re-resolving back to the smart Space would mint a BRAND NEW
    // mirror on every single re-import, forever. Explicitly preferring the
    // plain one breaks that: once a mirror exists, it's plain, so it wins
    // the tie on every subsequent run.
    const spaceByLowerName = new Map()
    for (const c of collections.all()) {
      const key = c.name.toLowerCase()
      const prev = spaceByLowerName.get(key)
      if (!prev || (prev.tags?.length && !c.tags?.length)) spaceByLowerName.set(key, c)
    }
    // Members are resolved from each collection's OWN urls, through the same
    // canonical-url index used for dedup above — which is seeded from every
    // note already in the database, then extended with the ones added by
    // this run. That is what makes the three orders equivalent: both files
    // dropped together, posts first and collections next week, or a
    // collections file whose posts were already saved by hand. Resolving
    // from `items` instead (what this did before) quietly worked only in
    // the first case, creating empty Spaces — or none — in the others.
    const membersByName = new Map() // collection name -> Set<noteId>
    const unresolved = new Set() // canonical urls naming a post we don't have — reported, not silently dropped
    for (const entry of parsedCollections) {
      // A future importer mis-shaping an entry must not throw into the
      // generic 500, same guard as items/parsedCollections above.
      const name = entry && typeof entry.name === 'string' ? entry.name : null
      if (!name) continue
      const urls = Array.isArray(entry?.urls) ? entry.urls : []
      let set = membersByName.get(name)
      if (!set) { set = new Set(); membersByName.set(name, set) }
      for (const url of urls) {
        const c = canonicalUrl(url)
        if (!c) continue
        const noteId = urlIndex.get(c)
        if (noteId) set.add(noteId)
        else unresolved.add(c) // not imported and not already saved — counted once per post, however many collections it sits in
      }
    }
    unresolvedMembers = unresolved.size
    const touchedSpaceIds = new Set() // dedups by Space, not by collection name — two IG names CAN resolve to the same Space
    for (const [name, members] of membersByName) {
      if (!members.size) continue
      let space = spaceByLowerName.get(name.toLowerCase())
      // A matched Space with a tag rule is a SMART collection: reusing it
      // here would (a) file unrelated posts into a Space the user built
      // around a rule, not an IG grouping, and (b) collections.addItem's
      // attach() clears removedIds — silently resurrecting items the user
      // deliberately hand-removed from it. Route IG-only collections into a
      // distinct, clearly-labeled Space instead of ever touching a smart one.
      if (space && space.tags && space.tags.length) {
        const altName = `${name} (Instagram)`
        let altSpace = spaceByLowerName.get(altName.toLowerCase())
        // The fallback name itself could ALSO collide with a user's own
        // smart Space (e.g. one literally named "Recipes (Instagram)") —
        // re-check rather than trusting a name match alone, same reasoning
        // as above. In that (rare) case, create a fresh Space anyway rather
        // than touching either smart one.
        if (altSpace && altSpace.tags && altSpace.tags.length) altSpace = null
        space = altSpace
        if (!space) {
          space = await collections.create({ name: altName })
          spaceByLowerName.set(space.name.toLowerCase(), space)
        }
      } else if (!space) {
        space = await collections.create({ name })
        spaceByLowerName.set(space.name.toLowerCase(), space)
      }
      // Skip ids already filed (a no-op re-import would otherwise cost one
      // addItem — one collections-table row write — per membership, EVERY
      // time) and ids the user deliberately hand-removed from a PLAIN
      // Space (addItem's attach() clears removedIds unconditionally, which
      // would silently resurrect them on every re-import — the manual-
      // removal analog of the smart-Space guard above). `space.itemIds`/
      // `removedIds` are the SAME array instances the real store mutates in
      // place (collections.all()'s withCount() only shallow-copies the
      // record, not its arrays), so if two IG collection names happen to
      // resolve to the very same existing Space within one run, the second
      // one still sees whatever the first one just added — no double-write.
      const known = new Set(space.itemIds || [])
      const removedHere = new Set(space.removedIds || [])
      let changed = false
      for (const id of members) {
        if (known.has(id) || removedHere.has(id)) continue
        await collections.addItem(space.id, id)
        known.add(id)
        changed = true
      }
      if (changed) touchedSpaceIds.add(space.id)
    }
    touchedCollections = touchedSpaceIds.size
  }

  if (failed > 0) warnings.push(`${failed} post(s) could not be saved due to an internal error.`)
  // The specific dead end this import used to hit silently: drop only
  // saved_collections.json and you'd get Spaces containing nothing, with no
  // hint that the posts file was the missing half.
  if (unresolvedMembers > 0) {
    warnings.push(`${unresolvedMembers} post(s) in these collections aren't saved yet — import saved_posts.json too.`)
  }

  // `warnings` (parser + the one pushed above) always rides along — a
  // partial/degraded parse must never look like a clean, complete import.
  json(res, 200, {
    importer: importer.name,
    imported: imported.length,
    skipped,
    failed,
    collections: touchedCollections,
    warnings,
  })
}
