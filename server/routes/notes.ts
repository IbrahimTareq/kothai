import path from 'node:path'
import { unlink } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { normalizeTags } from '../lib/tags.ts'
import * as store from '../data/notes.ts'
import type { NoteRecord } from '../data/notes.ts'
import { UPLOAD_DIR } from '../config.ts'
import * as ai from '../ai/index.ts'
import * as enrich from '../ai/enrich.ts'
import { isInstagramPost } from '../links/instagram.ts'
import * as collections from '../data/collections.ts'
import * as query from '../data/query.ts'
import { json, readBody } from '../lib/http.ts'
import { saveCapture } from '../capture.ts'

// readBody hands back `unknown` on purpose — the body is whatever a client
// posted, and an annotation here would be a claim nothing checks at runtime.
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

// ---- API handlers ------------------------------------------------------
// Every save returns instantly with heuristic metadata (regex type, derived
// title) — the AI pipeline (vision caption for images, then LLM classify +
// embed) runs in the background and patches the note when done (`pending`
// flags the card). A failure anywhere just leaves the heuristic version; the
// note itself is never lost.
export async function handleSave(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req)
  const fields = isRecord(body) ? body : {}
  const text = (fields.text || '').toString().trim()
  const imageData = fields.image // optional data URL
  if (!text && !imageData) return json(res, 400, { error: 'Provide text and/or an image.' })

  const note = await saveCapture({ text, image: typeof imageData === 'string' ? imageData : null })
  json(res, 200, { note, aiClassified: false })
}

// One note by id. The client's deep-linked expanded view (/item/<id>) opens
// before any page of the board has loaded, so it asks for just that item.
export function handleGetNote(res: ServerResponse, id: string) {
  const note = store.getNote(id)
  if (!note) return json(res, 404, { error: 'not found' })
  json(res, 200, { note })
}

export function handleNotes(res: ServerResponse, url: URL): void {
  const p = url.searchParams
  const all = store.allNotes()
  const collectionId = p.get('collection')
  const collection = collectionId ? new Set(collections.get(collectionId)?.itemIds || []) : undefined
  // Facets ignore type/source: chips only render on the Everything nav and
  // count within the search-filtered set regardless of the active chip.
  // 'all' so the counts below can see the unavailable notes they need to count;
  // the board itself hides them (see applyFilters).
  const facetBase = query.applyFilters(all, { q: p.get('q') || undefined, collection, unavailable: 'all' })
  const matching = query.applyFilters(facetBase, {
    type: p.get('type') || undefined,
    source: p.get('source') || undefined,
    unavailable: p.get('unavailable') === '1' ? 'only' : 'hide',
  })
  const offset = Math.max(0, parseInt(p.get('offset') || '0', 10) || 0)
  const sorted = query.sortNotes(matching, p.get('sort') || undefined)
  json(res, 200, {
    notes: query.pageOf(sorted, offset, parseInt(p.get('limit') || '120', 10)),
    total: matching.length,
    offset,
    facets: query.facetsOf(facetBase),
    pendingTotal: all.reduce((n, x) => n + (x.pending ? 1 : 0), 0),
    ...store.revState(),
  })
}

// "What changed since rev X" for the paged client — replaces full-list
// polling. A mismatched bootId (server restarted) or a since older than the
// tombstone window (deletions may be missing) forces a resync instead of a
// delta, since the client can't safely trust a partial answer.
export function handleNotesDelta(res: ServerResponse, url: URL) {
  const p = url.searchParams
  const since = parseInt(p.get('since') || '0', 10) || 0
  const { rev, bootId } = store.revState()
  const pendingTotal = store.allNotes().reduce((n, x) => n + (x.pending ? 1 : 0), 0)
  if (p.get('boot') !== bootId || !store.deltaOk(since)) {
    return json(res, 200, { resync: true, rev, bootId, pendingTotal })
  }
  json(res, 200, { rev, bootId, pendingTotal, notes: store.changedSince(since), deleted: store.deletedSince(since) })
}

// Fetch (once) the carousel slides of an Instagram post. Called by the client
// when the expanded view opens such an item — see queueIgSlides for why this is
// lazy rather than a bulk backfill. Always answers with the current note, so a
// single-image post or a failed scrape just comes back deck-less rather than
// erroring; the view keeps showing its single thumbnail either way.
export async function handleNoteSlides(res: ServerResponse, id: string): Promise<void> {
  const note = store.getNote(id)
  if (!note) return json(res, 404, { error: 'not found' })
  if (note.slidesFetched || !note.url || !isInstagramPost(note.url)) {
    return json(res, 200, { note })
  }
  await enrich.queueIgSlides(id, note.url)
  json(res, 200, { note: store.getNote(id) || note })
}

// Patch user-editable fields of a note (tags + free-form "mind note"). Used by
// the expanded item view. Only these two fields are writable from the client.
export async function handleUpdateNote(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const body = await readBody(req)
  const fields = isRecord(body) ? body : {}
  const patch: Partial<NoteRecord> = {}
  if (Array.isArray(fields.tags)) {
    patch.tags = normalizeTags(fields.tags, { max: 40 })
    // Marks these tags hand-edited so a later Instagram re-classify pass
    // (server/ai/enrich.ts's reclassifyWithCaption, which bypasses the
    // normal stepsFor "don't touch an already-classified note's tags"
    // protection) never silently overwrites them with AI-suggested ones.
    // Merge onto the note's existing `ai` markers, not replace — this patch
    // must not wipe out classify/embed/vision markers already set.
    const existing = store.getNote(id)
    patch.ai = { ...existing?.ai, tagsEdited: true }
  }
  if (typeof fields.mindNote === 'string') patch.mindNote = fields.mindNote.slice(0, 4000)
  if (!Object.keys(patch).length) return json(res, 400, { error: 'nothing to update' })

  const note = await store.updateNote(id, patch)
  if (!note) return json(res, 404, { error: 'note not found' })
  json(res, 200, { note })

  // Tags feed the embedding — re-embed in the background when they change so
  // semantic search stays fresh (best-effort; skipped if models aren't ready).
  if (patch.tags && ai.roleEnabled('embed')) {
    enrich.queueJob(async () => {
      try {
        const toEmbed = [note.title, note.summary, note.content, (note.tags || []).join(' '), note.mindNote]
          .filter(Boolean)
          .join('\n')
        if (toEmbed) await store.updateNote(id, { embedding: await ai.embedText(toEmbed) })
      } catch (e) {
        console.error('[update] re-embed failed for', id, '-', e instanceof Error ? e.message : e)
      }
    })
  }
}

// Force a full re-tag/re-classify of one note, discarding its current tags —
// triggered by the "Re-tag" button in the item's detail view.
export async function handleRetagNote(res: ServerResponse, id: string): Promise<void> {
  const note = await enrich.retagNote(id)
  if (!note) return json(res, 404, { error: 'note not found' })
  json(res, 200, { note })
}

export async function handleDeleteNote(res: ServerResponse, id: string): Promise<void> {
  const note = store.getNote(id)
  const ok = await store.deleteNote(id)
  if (ok) await collections.deleteItemEverywhere(id)
  if (ok && note) {
    for (const f of [note.image, note.thumb, ...(note.slides || [])]) {
      if (f?.startsWith('/uploads/')) {
        unlink(path.join(UPLOAD_DIR, path.basename(f))).catch(() => {})
      }
    }
  }
  return json(res, ok ? 200 : 404, { ok })
}
