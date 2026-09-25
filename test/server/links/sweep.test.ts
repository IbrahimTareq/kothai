// Tests for server/links/sweep.ts — what a daily run checks, and what it may
// write. Ported from the scan route's tests when the scan became automatic;
// the guards are the same and so is the reason for them: a wrong mark puts a
// live save in front of a "remove all" button.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { note } from '../../helpers/notes.ts'
import type { Availability } from '../../../server/links/availability.ts'
import type { ServerNote } from '../../../server/types.ts'

let notes: ServerNote[] = []
let verdicts: Record<string, Availability> = {}
let checked: string[] = []
let importing = false

const realStore = await import('../../../server/data/notes.ts')
const realAvail = await import('../../../server/links/availability.ts')
mock.module('../../../server/data/notes.ts', {
  namedExports: {
    ...realStore,
    allNotes: () => notes.map(n => ({ ...n })),
    // sweep.ts now batches with { persist: false } + flush(); the mock applies
    // the patch to in-memory `notes` immediately either way, since nothing
    // here models a real disk write for flush() to defer.
    updateNote: async (id: string, patch: Partial<ServerNote>, _opts?: { persist?: boolean }) => {
      const n = notes.find(x => x.id === id)
      if (n) Object.assign(n, patch)
      return n
    },
    flush: async () => {},
  },
})
mock.module('../../../server/links/availability.ts', {
  namedExports: {
    ...realAvail,
    isCheckable: (url: string | null) => typeof url === 'string' && /tiktok\.com|instagram\.com\/p\//.test(url),
    checkAvailability: async (url: string) => {
      checked.push(url)
      return verdicts[url] ?? 'unknown'
    },
  },
})

const realLock = await import('../../../server/data/import-lock.ts')
mock.module('../../../server/data/import-lock.ts', {
  namedExports: { ...realLock, isImportInProgress: () => importing },
})

const { maybeSweep } = await import('../../../server/links/sweep.ts')

const DAY = 24 * 60 * 60 * 1000
// maybeSweep keeps its last attempt in module state, so each run here happens
// on its own later day instead of resetting that state between tests.
let clock = Date.parse('2026-01-01T00:00:00.000Z')
const nextDay = () => {
  clock += 2 * DAY
  return clock
}

const tt = (i: number) => `https://www.tiktok.com/video/${i}`
const ig = (i: number) => `https://www.instagram.com/p/post${i}/`

function reset() {
  notes = []
  verdicts = {}
  checked = []
}

function tiktoks(n: number, verdict: (i: number) => Availability) {
  for (let i = 0; i < n; i++) {
    notes.push(note({ id: `t${i}`, url: tt(i) }))
    verdicts[tt(i)] = verdict(i)
  }
}

function find(id: string): ServerNote {
  const found = notes.find(n => n.id === id)
  assert.ok(found, `no note ${id} — the fixture and the assertion have drifted apart`)
  return found
}

async function run(now = nextDay()) {
  const r = await maybeSweep(now)
  assert.ok(r, 'the sweep was expected to run')
  return r
}

test('a run marks gone links and leaves everything else alone', async () => {
  reset()
  tiktoks(10, i => (i === 3 || i === 7 ? 'dead' : 'alive'))
  const now = nextDay()
  const r = await run(now)
  assert.equal(r.marked, 2)
  assert.deepEqual(
    notes
      .filter(n => n.unavailable)
      .map(n => n.id)
      .sort(),
    ['t3', 't7'],
  )
  assert.equal(find('t3').unavailableAt, new Date(now).toISOString())
})

test('an unreachable link keeps its mark, but is stamped as checked', async () => {
  reset()
  notes.push(note({ id: 't0', url: tt(0), unavailable: true }))
  const now = nextDay()
  await run(now)
  assert.equal(find('t0').unavailable, true, 'an inconclusive check must not clear a mark')
  // Unstamped, a post that is always "unknown" would head the oldest-first
  // order and take a slot in every day's slice.
  assert.equal(find('t0').availabilityCheckedAt, new Date(now).toISOString())
})

test('a link that comes back has its mark cleared', async () => {
  reset()
  tiktoks(5, () => 'alive')
  for (const n of notes) n.unavailable = true
  const r = await run()
  assert.equal(r.cleared, 5)
  assert.equal(notes.filter(n => n.unavailable).length, 0)
})

test('an implausible number of dead links writes nothing — no marks, no stamps', async () => {
  // A throttle or a changed API answers every request the same way.
  reset()
  tiktoks(100, () => 'dead')
  const r = await run()
  assert.equal(r.aborted, true)
  assert.equal(notes.filter(n => n.unavailable).length, 0)
  assert.equal(notes.filter(n => n.availabilityCheckedAt).length, 0, 'the same links must come up again next run')
})

test('one lane answering "gone" to everything aborts the run, even when the whole run looks fine', async () => {
  // The real library's shape: ~200 TikToks checked daily beside a 1/7 slice
  // of Instagram. If Instagram served its broken page to every request, the
  // whole-run ratio would stay under the line and a day's slice of live saves
  // would be marked. Here: 175 Instagram posts → slice of 25, all 'dead'; 190
  // TikToks, all 'alive'. Whole run: 25 / 215 ≈ 0.12. Instagram lane: 25 / 25.
  reset()
  tiktoks(190, () => 'alive')
  for (let i = 0; i < 175; i++) {
    notes.push(note({ id: `i${i}`, url: ig(i) }))
    verdicts[ig(i)] = 'dead'
  }
  const r = await run()
  assert.equal(r.checked, 215, 'the fixture no longer produces the run this test reasons about')
  assert.equal(r.aborted, true)
  assert.equal(notes.filter(n => n.unavailable).length, 0)
  assert.equal(notes.filter(n => n.availabilityCheckedAt).length, 0, 'the same links must come up again next run')
})

test('two lanes each too small to judge still abort together when the whole run is implausible', async () => {
  // 105 Instagram posts → slice of 15, all 'dead'; 12 TikToks, 10 'dead'.
  // Neither lane reaches 20 conclusive, but the run is 25 gone of 27.
  reset()
  tiktoks(12, i => (i < 10 ? 'dead' : 'alive'))
  for (let i = 0; i < 105; i++) {
    notes.push(note({ id: `i${i}`, url: ig(i) }))
    verdicts[ig(i)] = 'dead'
  }
  const r = await run()
  assert.equal(r.checked, 27, 'the fixture no longer produces the run this test reasons about')
  assert.equal(r.aborted, true)
  assert.equal(notes.filter(n => n.unavailable).length, 0)
  assert.equal(notes.filter(n => n.availabilityCheckedAt).length, 0, 'the same links must come up again next run')
})

test('a small sample is not judged by ratio — 3 of 4 gone is ordinary', async () => {
  reset()
  tiktoks(4, i => (i === 0 ? 'alive' : 'dead'))
  const r = await run()
  assert.equal(r.aborted, false)
  assert.equal(r.marked, 3)
})

test('Instagram is checked a seventh at a time, least recently checked first; TikTok every run', async () => {
  reset()
  // ig(0) was checked most recently, ig(13) longest ago.
  for (let i = 0; i < 14; i++) {
    notes.push(note({ id: `i${i}`, url: ig(i), availabilityCheckedAt: new Date(clock - (i + 1) * DAY).toISOString() }))
  }
  notes.push(note({ id: 'never', url: ig(99) }))
  notes.push(note({ id: 't0', url: tt(0) }))
  await run()
  // 15 Instagram posts → ceil(15 / 7) = 3: the never-checked one, then the two oldest.
  assert.deepEqual(checked.sort(), [ig(13), ig(12), ig(99), tt(0)].sort())
})

test('no run within a day of the newest check — a restart does not buy an extra sweep', async () => {
  reset()
  const now = nextDay()
  notes.push(note({ id: 't0', url: tt(0), availabilityCheckedAt: new Date(now - DAY / 2).toISOString() }))
  assert.equal(await maybeSweep(now), null)
  assert.deepEqual(checked, [])
})

test('an aborted run is not retried within the day, though it wrote no stamps', async () => {
  reset()
  tiktoks(100, () => 'dead')
  const now = nextDay()
  assert.equal((await run(now)).aborted, true)
  assert.equal(await maybeSweep(now + DAY / 2), null, 'an hourly tick must not hammer a host that is throttling')
  assert.ok(await maybeSweep(now + DAY + 1), 'a day later it tries again')
  clock = now + DAY + 1
})

test('no run while an import is in flight, and the skip does not cost the day', async () => {
  // The sweep's flush() commits the store-wide write queue an import batch
  // is still filling — see sweep.ts.
  reset()
  tiktoks(3, () => 'alive')
  const now = nextDay()
  importing = true
  try {
    assert.equal(await maybeSweep(now), null)
  } finally {
    importing = false
  }
  assert.deepEqual(checked, [])
  assert.ok(await maybeSweep(now + 60 * 60 * 1000), 'the next hourly tick, import done, runs')
})
