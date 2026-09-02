// POST /api/availability/scan   — check saved links, mark the ones that are gone
// POST /api/availability/remove — delete the marked ones, behind an explicit count
//
// Marking and deleting are deliberately SEPARATE requests. A scan writes only a
// reversible flag; the destructive step is a decision the user makes with the
// count in front of them. The check is a network verdict, and a network verdict
// can be wrong for reasons that have nothing to do with the content — a
// throttle, a soft-ban, an API change. Leaving a dead tile costs a grid cell;
// deleting a live save costs something the user chose to keep, silently and for
// good. That asymmetry is why nothing here deletes on its own.
import { unlink } from 'node:fs/promises'
import path from 'node:path'
import * as store from '../data/notes.js'
import * as collections from '../data/collections.js'
import { checkAvailability, isCheckable, DEAD, ALIVE } from '../ai/availability.js'
import { json, readBody } from '../lib/http.js'

const CONCURRENCY = 4

// If this share of the checked links comes back "gone", believe the sweep is
// broken rather than the library. A throttle or a changed API answers every
// request identically, and without this a single bad afternoon would mark a
// whole library for deletion — which the user would then confirm, because the
// count is all they see. Real rot in a saved library is a slow trickle; a
// majority verdict is a bug report, not a finding.
const IMPLAUSIBLE_DEAD_RATIO = 0.6
// Below this many checks the ratio is noise (3 of 4 dead is entirely normal).
const RATIO_MIN_SAMPLE = 20

let scanInProgress = false

export async function handleAvailabilityScan(req, res) {
  if (scanInProgress) {
    return json(res, 409, { error: 'A scan is already running.', code: 'scan_in_progress' })
  }
  scanInProgress = true
  try {
    const candidates = store.allNotes().filter((n) => isCheckable(n.url))
    if (!candidates.length) {
      return json(res, 200, { checked: 0, dead: 0, alive: 0, unknown: 0, marked: 0, unavailable: 0, aborted: false })
    }

    // Verdicts are collected for the WHOLE sweep before anything is written, so
    // the implausibility guard below can see the shape of the run and refuse to
    // write at all. Marking as we went would leave a half-marked library behind
    // when the guard trips.
    const verdicts = []
    let cursor = 0
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, async () => {
      while (cursor < candidates.length) {
        const n = candidates[cursor++]
        verdicts.push({ note: n, verdict: await checkAvailability(n.url) })
      }
    }))

    const dead = verdicts.filter((v) => v.verdict === DEAD)
    const alive = verdicts.filter((v) => v.verdict === ALIVE)
    const unknown = verdicts.length - dead.length - alive.length
    const conclusive = dead.length + alive.length

    if (conclusive >= RATIO_MIN_SAMPLE && dead.length / conclusive > IMPLAUSIBLE_DEAD_RATIO) {
      return json(res, 200, {
        checked: verdicts.length, dead: dead.length, alive: alive.length, unknown,
        marked: 0, unavailable: countUnavailable(), aborted: true,
        error: `${dead.length} of ${conclusive} links reported gone — that is too many to believe. Nothing was marked; the check itself is likely being rate-limited. Try again later.`,
      })
    }

    let marked = 0
    for (const { note } of dead) {
      if (note.unavailable) continue // already marked; re-marking is a no-op write
      await store.updateNote(note.id, { unavailable: true, unavailableAt: new Date().toISOString() })
      marked++
    }
    // A link that answers again clears its mark — content comes back (an
    // unarchived post, a profile off private), and a stale flag would quietly
    // put a live save in the delete pile.
    let cleared = 0
    for (const { note } of alive) {
      if (!note.unavailable) continue
      await store.updateNote(note.id, { unavailable: false, unavailableAt: null })
      cleared++
    }

    json(res, 200, {
      checked: verdicts.length, dead: dead.length, alive: alive.length, unknown,
      marked, cleared, unavailable: countUnavailable(), aborted: false,
    })
  } finally {
    scanInProgress = false
  }
}

function countUnavailable() {
  return store.allNotes().filter((n) => n.unavailable).length
}

export async function handleAvailabilityRemove(req, res) {
  let body
  try {
    body = await readBody(req)
  } catch {
    return json(res, 400, { error: 'Could not read the request.' })
  }
  const targets = store.allNotes().filter((n) => n.unavailable)
  // The client sends the count it showed the user. If the library changed since
  // (a scan cleared a mark, another tab deleted something), the number in front
  // of them was not the number about to be deleted — so refuse rather than
  // delete a different set than the one they agreed to.
  if (!body || typeof body !== 'object' || body.expected !== targets.length) {
    return json(res, 409, {
      error: `That list has changed — ${targets.length} item(s) are marked unavailable now. Scan again and review before removing.`,
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
    for (const f of [note.image, note.thumb, ...(note.slides || [])]) {
      if (f && typeof f === 'string' && f.startsWith('/uploads/')) {
        unlink(path.join(store.UPLOAD_DIR, path.basename(f))).catch(() => {})
      }
    }
  }
  json(res, 200, { removed, unavailable: countUnavailable() })
}
