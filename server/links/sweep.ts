// The daily availability sweep: which saved links get asked about, and what
// a run is allowed to write.
//
// It only ever MARKS. Deleting is a separate request the user makes from the
// Everything page with the count in front of them (server/routes/
// availability.ts): a verdict is a network call, and a network call can be
// wrong for reasons that have nothing to do with the content — a throttle, a
// soft-ban, an API change. A dead tile left in place costs a grid cell; a live
// save deleted costs something the user chose to keep.
import * as store from '../data/notes.ts'
import type { PublicNote } from '../data/notes.ts'
import type { ServerNote } from '../types.ts'
import { checkAvailability, isCheckable } from './availability.ts'
import type { Availability } from './availability.ts'
import { isInstagramPost } from './instagram.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const CONCURRENCY = 4
// Instagram is checked a seventh at a time. Every check is a throttled request
// on the lane new saves use, ~2.7s each: the 1,683 saved posts on 2026-09-26
// were ~75 minutes of Instagram traffic in one go, and a soft-ban would stop
// captions and thumbnails on new saves along with the sweep.
const INSTAGRAM_DAYS = 7

// If this share of the checked links comes back "gone", believe the sweep is
// broken rather than the library. A throttle or a changed API answers every
// request identically, and without this a single bad afternoon would mark a
// whole library for deletion — which the user would then confirm, because the
// count is all they see. Real rot in a saved library is a slow trickle; a
// majority verdict is a bug report, not a finding.
const IMPLAUSIBLE_DEAD_RATIO = 0.6
// Below this many checks the ratio is noise (3 of 4 dead is entirely normal).
const RATIO_MIN_SAMPLE = 20

interface Candidate {
  note: PublicNote
  url: string
}

interface SweepResult {
  checked: number
  dead: number
  alive: number
  unknown: number
  marked: number
  cleared: number
  aborted: boolean
}

// Alongside the notes' own stamps: a run the guard aborts writes no stamps,
// and without this the hourly tick would retry it every hour against a host
// that is already throttling us. Set synchronously before the first await, it
// also keeps a second tick out while a run is still in progress — the
// Instagram slice alone takes ~11 minutes.
let lastAttemptAt = 0

// Called hourly; runs at most once a day. null means it did not run.
export async function maybeSweep(now = Date.now()): Promise<SweepResult | null> {
  if (now - lastAttemptAt < DAY_MS) return null
  const candidates = store.allNotes().flatMap(n => (isCheckable(n.url) ? [{ note: n, url: n.url }] : []))
  // The newest stamp stands in for "when did the last sweep run": it survives
  // a restart, so a redeploy does not buy an extra run.
  const newest = candidates.reduce((m, c) => Math.max(m, Date.parse(c.note.availabilityCheckedAt ?? '') || 0), 0)
  if (now - newest < DAY_MS) return null
  lastAttemptAt = now
  return sweep(candidates, now)
}

async function sweep(candidates: Candidate[], now: number): Promise<SweepResult> {
  const instagram = candidates.filter(c => isInstagramPost(c.url))
  const rest = candidates.filter(c => !isInstagramPost(c.url))
  // ISO stamps sort as strings, and a never-checked note ('') sorts first.
  // localeCompare would apply locale collation to what is really a plain code
  // sequence, so this compares the stamp strings code-unit by code-unit.
  const slice = instagram
    .sort((a, b) => {
      const x = a.note.availabilityCheckedAt ?? ''
      const y = b.note.availabilityCheckedAt ?? ''
      return x < y ? -1 : x > y ? 1 : 0
    })
    .slice(0, Math.ceil(instagram.length / INSTAGRAM_DAYS))

  // Every verdict is in before anything is written, so the guard below can see
  // the shape of the whole run and refuse to write at all. Marking as we went
  // would leave a half-marked library behind when the guard trips.
  const verdicts: { note: PublicNote; verdict: Availability }[] = []
  const check = async (c: Candidate) => {
    verdicts.push({ note: c.note, verdict: await checkAvailability(c.url) })
  }
  let cursor = 0
  await Promise.all([
    // No pool for Instagram: its queue already runs one request at a time.
    ...slice.map(check),
    ...Array.from({ length: Math.min(CONCURRENCY, rest.length) }, async () => {
      while (cursor < rest.length) await check(rest[cursor++])
    }),
  ])

  const dead = verdicts.filter(v => v.verdict === 'dead').length
  const alive = verdicts.filter(v => v.verdict === 'alive').length
  const result: SweepResult = {
    checked: verdicts.length,
    dead,
    alive,
    unknown: verdicts.length - dead - alive,
    marked: 0,
    cleared: 0,
    aborted: false,
  }
  const conclusive = dead + alive
  if (conclusive >= RATIO_MIN_SAMPLE && dead / conclusive > IMPLAUSIBLE_DEAD_RATIO) {
    console.warn(`[sweep] ${dead} of ${conclusive} links reported gone — too many to believe; nothing written`)
    return { ...result, aborted: true }
  }

  const stamp = new Date(now).toISOString()
  for (const { note, verdict } of verdicts) {
    // Stamped whatever the verdict: an "unknown" left unstamped would head the
    // oldest-first order and take a slot in every day's slice.
    const patch: Partial<ServerNote> = { availabilityCheckedAt: stamp }
    if (verdict === 'dead' && !note.unavailable) {
      patch.unavailable = true
      patch.unavailableAt = stamp
      result.marked++
    }
    // A link that answers again clears its mark — content comes back (an
    // unarchived post, a profile off private), and a stale flag would quietly
    // put a live save in the delete pile.
    if (verdict === 'alive' && note.unavailable) {
      patch.unavailable = false
      patch.unavailableAt = null
      result.cleared++
    }
    // Queued rather than written here: the guard above already refuses to
    // write anything when the whole run looks wrong, and a disk error partway
    // through this loop shouldn't leave a half-marked run either — flush()
    // commits every patch in one transaction, so they all land or none do.
    await store.updateNote(note.id, patch, { persist: false })
  }
  await store.flush()
  console.log(
    `[sweep] checked ${result.checked}: ${alive} fine, ${dead} gone, ${result.unknown} unreachable; ` +
      `${result.marked} marked, ${result.cleared} cleared`,
  )
  return result
}
