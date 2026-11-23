// POST /api/import — ties together the ZIP reader, the importer registry, and
// the phase-one save + background-enrich pattern used by handleSave. This is
// the ONLY consumer of server/import/* today.
import type { IncomingMessage, ServerResponse } from 'node:http'
import * as store from '../data/notes.ts'
import * as enrich from '../ai/enrich.ts'
import { fileIntoSpaces } from '../import/spaces.ts'
import { findImporter, getImporter, importerNames } from '../import/index.ts'
import type { Importer, ParsedExport } from '../import/index.ts'
import { readZip, MAX_TOTAL_BYTES } from '../lib/zip.ts'
import { json, readBody } from '../lib/http.ts'
import { runExclusiveImport } from '../data/import-lock.ts'
import { canonicalUrl } from '../links/canonical.ts'
// The same narrowing the importers use on a parsed export — an HTTP body from
// this route is the same untrusted JSON, one layer earlier.
import { isRecord } from '../import/untrusted.ts'

// Uploads arrive as JSON { name, data } with data base64 (raw or data-URL),
// matching the app's existing pasted-image transport. This bounds the RAW
// HTTP body (the JSON text, which is mostly the base64 string) — base64
// inflates the underlying file by ~4/3, so this comfortably covers a Meta
// export in the tens of megabytes without the request itself ballooning
// past what readBody buffers in memory before handing it to JSON.parse.
const BODY_LIMIT = 64 * 1024 * 1024

// A real export is a handful of files (or one ZIP) — except Omnivore's, which
// writes one file per 20 items, so a few-thousand-item library is a couple of
// hundred loose files. This only exists to stop a request from carrying
// thousands of tiny uploads, each of which costs a base64 decode and a ZIP
// scan before the body limit above would notice.
const MAX_UPLOADS = 1000

export async function handleImport(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // The flag this takes lives in data/import-lock.ts — it is state about the
  // store, and three other bulk routes have to read it.
  const ran = await runExclusiveImport(() => runImport(req, res))
  if (!ran) {
    return json(res, 409, {
      error: 'Another import is already in progress. Try again once it finishes.',
      code: 'import_in_progress',
    })
  }
}

async function runImport(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown
  try {
    body = await readBody(req, BODY_LIMIT)
  } catch (e) {
    // readBody rejects (never throws a raw RangeError-shaped surprise) on
    // both "too big" and "not valid JSON" — map both to a clean 4xx instead
    // of falling through to the router's generic 500 catch-all, since an
    // oversized/malformed upload is entirely expected user-facing input here.
    const tooLarge = /payload too large/i.test(e instanceof Error ? e.message : '')
    return json(res, tooLarge ? 413 : 400, {
      error: tooLarge ? 'That file is too large to import.' : 'Could not read the upload as JSON.',
    })
  }
  // readBody resolves `null` as-is for a literal `null` body (valid JSON,
  // not an object) — guard before touching body.data instead of letting
  // that TypeError fall into the router's generic 500.
  if (!isRecord(body)) {
    return json(res, 400, { error: 'Invalid request body.' })
  }

  // One import can carry several uploads: an Instagram export hands you
  // saved_posts.json and saved_collections.json as separate files, and
  // making the user import them one at a time is exactly the flow that used
  // to lose their collections. `{ name, data }` stays valid as the one-file
  // shorthand the client used before this.
  const uploads: unknown[] = Array.isArray(body.files) ? body.files : [{ name: body.name, data: body.data }]
  if (!uploads.length) return json(res, 400, { error: 'Provide at least one file.' })
  if (uploads.length > MAX_UPLOADS) {
    return json(res, 400, { error: `Too many files at once — import up to ${MAX_UPLOADS} at a time.` })
  }

  const files = new Map<string, Buffer>()
  // Decompression budget shared across every archive in this request. Left
  // per-call (readZip's own default), N archives would each get the full
  // MAX_TOTAL_BYTES, so splitting one zip bomb into ten uploads would buy
  // ten times the budget — see server/lib/zip.ts.
  let zipBudget = MAX_TOTAL_BYTES
  for (const [i, upload] of uploads.entries()) {
    if (!isRecord(upload)) return json(res, 400, { error: 'Invalid file in upload.' })
    const b64 = String(upload.data || '').replace(/^data:[^;]*;base64,/, '')
    if (!b64) return json(res, 400, { error: 'Provide each file as base64 `data`.' })
    const buf = Buffer.from(b64, 'base64')

    // ZIP magic "PK" → unpack; anything else is treated as a single JSON file
    // (lets someone import a bare saved_posts.json without zipping it first).
    if (buf[0] === 0x50 && buf[1] === 0x4b) {
      let entries: Map<string, Buffer>
      try {
        entries = readZip(buf, { maxTotalBytes: zipBudget })
      } catch (e) {
        return json(res, 400, { error: `Could not read that ZIP: ${e instanceof Error ? e.message : e}` })
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
      files.set(`${i}/${String(upload.name || 'upload.json')}`, buf)
    }
  }

  // The Import section the user dropped onto names its own platform, so the
  // route can check the upload against THAT importer and say what was
  // expected. Sniffing across all importers stays as the fallback for the
  // untagged single-file API.
  let importer: Importer | null
  if (body.source != null) {
    importer = getImporter(String(body.source))
    if (!importer) {
      return json(res, 400, { error: `Unknown import source. Expected one of: ${importerNames().join(', ')}.` })
    }
    let matches = false
    try {
      matches = importer.sniff(files)
    } catch {
      matches = false
    }
    if (!matches) {
      return json(res, 400, {
        error: `That doesn't look like ${importer.label || importer.name} data — expected ${importer.expects || 'the export files'}.`,
        code: 'import_source_mismatch',
      })
    }
  } else {
    importer = findImporter(files)
    if (!importer) {
      return json(res, 400, {
        error: `Not a recognized export. Expected one of: ${importerNames().join(', ')}.`,
      })
    }
  }

  let parsed: ParsedExport
  try {
    parsed = importer.parse(files)
  } catch (e) {
    // parse() is documented to degrade rather than throw, but the route is
    // the trust boundary for this upload — an unexpected throw here must
    // still land as a clean 400, not the router's generic 500.
    return json(res, 400, { error: `Could not parse that export: ${e instanceof Error ? e.message : e}` })
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
  const urlIndex = new Map<string, string>()
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
    if (!c || urlIndex.has(c)) {
      skipped++
      continue
    }
    let note: Awaited<ReturnType<typeof store.addNote>>
    try {
      // persist:false — see the batched flush() below. Nothing here does
      // disk I/O, so a mid-loop failure can only be a logic bug, not a
      // partial disk write; caught per-item so one bad row can't sink the
      // whole import.
      // Deliberately no arrival stamp. Notes once carried an `importedAt`,
      // stamped once per run here so "recently added" would not sort by
      // millisecond — i.e. by the order the export file happened to list
      // things, which is how a library's OLDEST imported items ended up at
      // the top of the board. Its only reader is gone: sortNotes orders on
      // `createdAt` and breaks ties on insertion order, curing that same
      // symptom. The write outlived the read, persisting an unread field on
      // every row and shipping it to every client — so it was deleted
      // rather than declared in ServerNote.
      note = await store.addNote(importer.deriveNote(item), { persist: false })
    } catch (e) {
      console.error('[import] failed to add note for', item.url, '-', e instanceof Error ? e.message : e)
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
      const why = e instanceof Error ? e.message : String(e)
      console.error('[import] failed to persist imported notes, rolling back:', why)
      await store.removeMany(imported.map(n => n.id))
      return json(res, 500, {
        error: `Could not save imported notes (${why}). Nothing was imported — try again.`,
        code: 'import_rolled_back',
      })
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
  // never truly there). enrich.ts's enrichNote now also guards on
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
      // Two lanes, deliberately. queueLinkMeta fetches the caption and
      // thumbnail on a cheap lane — a few at a time for most links, Instagram
      // one at a time on its throttled lane with on-screen posts promoted
      // first — so an imported grid stops being a wall of identical
      // placeholder tiles within minutes; queueEnrich does the model work on
      // its own serial chain behind that. Ordered this way so the cheap lane
      // is already running before the first classify pass takes the model.
      enrich.queueLinkMeta(id, url)
      enrich.queueEnrich(id, url)
    }
  } catch (e) {
    console.error('[import] failed to queue enrich for imported notes:', e instanceof Error ? e.message : e)
  }

  // Resolved through urlIndex, not from `imported`: see fileIntoSpaces for why
  // an already-saved post must still be filed.
  const { touched: touchedCollections, unresolved: unresolvedMembers } = parsedCollections.length
    ? await fileIntoSpaces(parsedCollections, urlIndex, importer.label)
    : { touched: 0, unresolved: 0 }

  // "item", not "post": a bookmark import's entries are links, not posts.
  if (failed > 0) warnings.push(`${failed} item(s) could not be saved due to an internal error.`)
  // The specific dead end this import used to hit silently: drop only
  // saved_collections.json and you'd get Spaces containing nothing, with no
  // hint that the posts file was the missing half. The file hint is
  // Instagram's alone — Raindrop reaches this too (an item that failed to
  // save), and has no saved_posts.json to point at.
  if (unresolvedMembers > 0) {
    const hint = importer.name === 'instagram' ? ' — import saved_posts.json too' : ''
    warnings.push(`${unresolvedMembers} item(s) in these collections aren't saved yet${hint}.`)
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
