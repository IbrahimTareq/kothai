// POST /api/availability/remove — delete the notes the daily sweep marked,
// behind an explicit count.
//
// Marking and deleting are deliberately SEPARATE. The sweep
// (server/links/sweep.ts) writes only a reversible flag; the destructive step
// is a decision the user makes on the Everything page with the count in front
// of them. The check is a network verdict, and a network verdict can be wrong
// for reasons that have nothing to do with the content — a throttle, a
// soft-ban, an API change. Leaving a dead tile costs a grid cell; deleting a
// live save costs something the user chose to keep, silently and for good.
// That asymmetry is why nothing deletes on its own.
import { unlink } from 'node:fs/promises'
import path from 'node:path'
import * as store from '../data/notes.ts'
import { UPLOAD_DIR } from '../config.ts'
import * as collections from '../data/collections.ts'
import { json, readBody } from '../lib/http.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'

// readBody hands back `unknown`, and the count below is the only thing
// standing between a stale tab and a bulk delete. Local rather than lifted
// into server/lib/: that is the security floor, and a guard there needs a test
// that fails without it.
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function countUnavailable(): number {
  return store.allNotes().filter(n => n.unavailable).length
}

export async function handleAvailabilityRemove(req: IncomingMessage, res: ServerResponse) {
  let body: unknown
  try {
    body = await readBody(req)
  } catch {
    return json(res, 400, { error: 'Could not read the request.' })
  }
  const targets = store.allNotes().filter(n => n.unavailable)
  // The client sends the count it showed the user. If the library changed
  // since (the daily sweep marked or cleared a link, another tab deleted
  // something), the number in front of them was not the number about to be
  // deleted — so refuse rather than delete a different set than the one they
  // agreed to.
  if (!isRecord(body) || body.expected !== targets.length) {
    return json(res, 409, {
      error: `That list has changed — ${targets.length} item(s) are marked unavailable now. Look them over again before removing.`,
      code: 'count_mismatch',
      unavailable: targets.length,
    })
  }
  if (!targets.length) return json(res, 200, { removed: 0, unavailable: 0 })

  let removed = 0
  for (const note of targets) {
    const ok = await store.deleteNote(note.id)
    if (!ok) continue
    removed++
    await collections.deleteItemEverywhere(note.id)
    // Same cleanup handleDeleteNote does — an orphaned thumbnail on disk
    // outlives the note otherwise.
    for (const f of [note.thumb, ...(note.slides || [])]) {
      if (f && typeof f === 'string' && f.startsWith('/uploads/')) {
        unlink(path.join(UPLOAD_DIR, path.basename(f))).catch(() => {})
      }
    }
  }
  json(res, 200, { removed, unavailable: countUnavailable() })
}
