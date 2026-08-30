// Tests for the Instagram meta retry policy (server/ai/enrich.js): a failed
// fetch used to permanently set metaFetched — one bad network moment and the
// note never got a thumbnail. These pure functions replace that with a try
// count + backoff delay, plus a one-time "unstick" check for notes that were
// already stranded by the OLD permanent-failure policy.
import test from 'node:test'
import assert from 'node:assert/strict'
import { metaRetryDelay, metaRetryEligible, isStuckInstagramNote, queueMetaBackfill, _igQueueState } from '../../../server/ai/enrich.js'
import * as store from '../../../server/data/notes.js'

test('metaRetryDelay backs off 10min * 4^n capped at 24h', () => {
  assert.equal(metaRetryDelay(0), 600_000)
  assert.equal(metaRetryDelay(1), 2_400_000)
  assert.equal(metaRetryDelay(10), 86_400_000)
})

test('metaRetryEligible gates on flag, tries, and next-try time', () => {
  const now = 1_000_000
  assert.ok(metaRetryEligible({}, now), 'never tried')
  assert.ok(!metaRetryEligible({ metaFetched: true }, now))
  assert.ok(!metaRetryEligible({ metaTries: 5 }, now), 'try budget exhausted')
  assert.ok(!metaRetryEligible({ metaTries: 1, metaNextTry: now + 1 }, now))
  assert.ok(metaRetryEligible({ metaTries: 1, metaNextTry: now }, now))
})

test('isStuckInstagramNote: fetched flag but nothing actually landed', () => {
  const url = 'https://www.instagram.com/reel/X/'
  assert.ok(isStuckInstagramNote({ url, metaFetched: true }))
  assert.ok(!isStuckInstagramNote({ url, metaFetched: true, thumb: '/uploads/x.jpg' }))
  assert.ok(!isStuckInstagramNote({ url, metaFetched: true, siteDesc: 'caption' }))
  assert.ok(!isStuckInstagramNote({ url: 'https://example.com', metaFetched: true }))
  assert.ok(!isStuckInstagramNote({ url, metaFetched: false }))
})

// store.allNotes() iterates newest-first (addNote unshifts); queueMetaBackfill
// must queue Instagram jobs in that same order so the boot backfill matches
// the default view — the most recently saved reel gets its thumbnail first.
test('queueMetaBackfill queues Instagram notes newest-first, matching allNotes() order', async () => {
  store._reset()
  _igQueueState.pause()
  _igQueueState.clear()
  _igQueueState.pause() // clear() flips igPaused back to false — re-pause so nothing actually fetches
  try {
    const older = await store.addNote({ type: 'link', url: 'https://www.instagram.com/reel/older/' })
    const newer = await store.addNote({ type: 'link', url: 'https://www.instagram.com/reel/newer/' })
    queueMetaBackfill()
    assert.deepEqual(_igQueueState.ids(), [newer.id, older.id], 'newest note queued first')
  } finally {
    _igQueueState.clear()
  }
})
