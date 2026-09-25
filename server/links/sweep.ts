// The daily availability sweep: which saved links get asked about, and what
// a run is allowed to write.
//
// It only ever MARKS. Deleting is a separate request the user makes from the
// Everything page with the count in front of them (server/routes/
// availability.ts): a verdict is a network call, and a network call can be
// wrong for reasons that have nothing to do with the content — a throttle, a
// soft-ban, an API change. A dead tile left in place costs a grid cell; a live
// save deleted costs something the user chose to keep.
import { isImportInProgress } from '../data/import-lock.ts'
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
//
// Judged per lane — the Instagram slice, and the oEmbed checks for everything
// else — AND over the run as a whole; any one tripping writes nothing. Per
// lane because each lane fails on its own (a soft-ban, a changed oEmbed API),
// and a failing lane hides inside a healthy one's average: on the 2026-09-26
// library, Instagram serving its broken page to every request would have been
// 262 gone of 439 over the whole run (0.597, 198 TikToks + 241 Instagram) —
// under the line, and 241 live saves marked that day. Over the whole run as
// well because two lanes each under RATIO_MIN_SAMPLE are unjudged alone, yet
// together can still be a sample big enough to be implausible.
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
  // The sweep's single flush() commits — or on failure discards — the
  // store-wide pendingWrites queue, which an import batch is filling with its
  // own unflushed notes: running now would half-commit that import, or throw
  // it away. Skipped before lastAttemptAt is set, so the next hourly tick
  // tries again rather than the day being lost (same guard as backupIfDue).
  if (isImportInProgress()) return null
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
  const verdicts: { note: PublicNote; verdict: Availability; lane: 'Instagram' | 'oEmbed' }[] = []
  const check = async (c: Candidate, lane: 'Instagram' | 'oEmbed') => {
    verdicts.push({ note: c.note, verdict: await checkAvailability(c.url), lane })
  }
  let cursor = 0
  await Promise.all([
    // No pool for Instagram: its queue already runs one request at a time.
    ...slice.map(c => check(c, 'Instagram')),
    ...Array.from({ length: Math.min(CONCURRENCY, rest.length) }, async () => {
      while (cursor < rest.length) await check(rest[cursor++], 'oEmbed')
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
  const judged = [
    ['whole run', verdicts],
    ['Instagram', verdicts.filter(v => v.lane === 'Instagram')],
    ['oEmbed', verdicts.filter(v => v.lane === 'oEmbed')],
  ] as const
  for (const [what, own] of judged) {
    const ownDead = own.filter(v => v.verdict === 'dead').length
    const conclusive = own.filter(v => v.verdict !== 'unknown').length
    if (conclusive >= RATIO_MIN_SAMPLE && ownDead / conclusive > IMPLAUSIBLE_DEAD_RATIO) {
      console.warn(
        `[sweep] ${what}: ${ownDead} of ${conclusive} links reported gone — too many to believe; nothing written`,
      )
      return { ...result, aborted: true }
    }
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
    // write anything when the run or a lane looks wrong, and a disk error
    // partway through this loop shouldn't leave a half-marked run either —
    // flush() commits every patch in one transaction, so on DISK they all
    // land or none do. Memory is another matter: updateNote has already applied each
    // patch in memory, so if flush() throws, this process shows the marks
    // until a restart reloads the store from disk.
    await store.updateNote(note.id, patch, { persist: false })
  }
  await store.flush()
  console.log(
    `[sweep] checked ${result.checked}: ${alive} fine, ${dead} gone, ${result.unknown} unreachable; ` +
      `${result.marked} marked, ${result.cleared} cleared`,
  )
  return result
}
