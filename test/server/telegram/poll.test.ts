// The offset is Telegram's delivery acknowledgement: advancing past an update
// tells Telegram to forget it. So it advances only after the note is safely
// persisted — a duplicate capture is recoverable by hand, a lost one is not.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pollOnce, nextBackoff } from '../../../server/telegram/poll.ts'
import type { TelegramUpdate } from '../../../server/telegram/api.ts'

const update = (id: number): TelegramUpdate => ({
  update_id: id,
  message: { message_id: id, chat: { id: 99 }, text: 'x' },
})

test('pollOnce: a clean batch advances the offset past the last update', async () => {
  const handled: number[] = []
  const result = await pollOnce({
    offset: 0,
    getUpdates: async () => ({ ok: true, updates: [update(10), update(11)] }),
    handle: async u => {
      handled.push(u.update_id)
    },
  })
  assert.deepEqual(handled, [10, 11])
  assert.deepEqual(result, { offset: 12, conflict: false, failed: false })
})

test('pollOnce: a failure mid-batch stops at the last update that persisted', async () => {
  const result = await pollOnce({
    offset: 0,
    getUpdates: async () => ({ ok: true, updates: [update(10), update(11), update(12)] }),
    handle: async u => {
      if (u.update_id === 11) throw new Error('db down')
    },
  })
  assert.deepEqual(result, { offset: 11, conflict: false, failed: true }, 'update 11 must be redelivered')
})

test('pollOnce: the first update failing leaves the offset exactly where it was', async () => {
  const result = await pollOnce({
    offset: 5,
    getUpdates: async () => ({ ok: true, updates: [update(10)] }),
    handle: async () => {
      throw new Error('db down')
    },
  })
  assert.deepEqual(result, { offset: 5, conflict: false, failed: true })
})

test('pollOnce: a conflict is reported so the caller can stop rather than back off', async () => {
  const result = await pollOnce({
    offset: 3,
    getUpdates: async () => ({ ok: false, conflict: true }),
    handle: async () => {},
  })
  assert.deepEqual(result, { offset: 3, conflict: true, failed: true })
})

test('pollOnce: an empty batch is not a failure — a long poll usually times out empty', async () => {
  const result = await pollOnce({
    offset: 3,
    getUpdates: async () => ({ ok: true, updates: [] }),
    handle: async () => {},
  })
  assert.deepEqual(result, { offset: 3, conflict: false, failed: false })
})

// The house rule is "log before you swallow" — a handle() failure must never
// vanish silently, or a dropped capture looks identical to a quiet night.
test('pollOnce: a handle failure is logged, not silently swallowed', async t => {
  const errors: unknown[][] = []
  t.mock.method(console, 'error', (...args: unknown[]) => {
    errors.push(args)
  })
  const result = await pollOnce({
    offset: 0,
    getUpdates: async () => ({ ok: true, updates: [update(10)] }),
    handle: async () => {
      throw new Error('db down')
    },
  })
  assert.deepEqual(result, { offset: 0, conflict: false, failed: true })
  assert.equal(errors.length, 1)
  assert.match(String(errors[0][0]), /\[telegram\]/)
})

// giveUp is startPolling's give-up rule (see nextBackoff below): once the
// update sitting at `offset` has already been retried through every backoff
// tier, the next pass skips it instead of stopping on it forever. Without
// this, a permanently failing write — not a transient blip — would retry the
// same update every pass, and data/notes.ts's addNote unshifts into the
// in-memory notes list before the database insert, so every retry leaves
// another phantom record nothing ever cleans up.
test('pollOnce: giveUp skips the update stuck at offset, logs it, and processes the rest of the batch', async t => {
  const errors: unknown[][] = []
  t.mock.method(console, 'error', (...args: unknown[]) => {
    errors.push(args)
  })
  const handled: number[] = []
  const result = await pollOnce({
    offset: 10,
    giveUp: true,
    getUpdates: async () => ({ ok: true, updates: [update(10), update(11)] }),
    handle: async u => {
      handled.push(u.update_id)
      if (u.update_id === 10) throw new Error('permanently broken')
    },
  })
  assert.deepEqual(handled, [10, 11], 'the update after the skipped one still gets a chance')
  assert.deepEqual(result, { offset: 12, conflict: false, failed: false })
  assert.ok(
    errors.some(e => /skip/i.test(String(e[0]))),
    'skipping an update must be logged loudly, not silent',
  )
})

test('pollOnce: giveUp does not skip a fresh failure — only the update already stuck at offset has earned it', async () => {
  const result = await pollOnce({
    offset: 10,
    giveUp: true,
    getUpdates: async () => ({ ok: true, updates: [update(10), update(11)] }),
    handle: async u => {
      if (u.update_id === 11) throw new Error('this one has not been retried at all yet')
    },
  })
  assert.deepEqual(
    result,
    { offset: 11, conflict: false, failed: true },
    'update 11 gets the normal stop-and-retry treatment, not an immediate skip',
  )
})

// nextBackoff is startPolling's timer loop pulled out into a pure function so
// the give-up threshold can be tested without fake timers.
test('nextBackoff: the same stuck offset climbs the ladder and then caps out', () => {
  let state: { failures: number; stuckAt: number | null } = { failures: 0, stuckAt: null }
  const delays: number[] = []
  for (let i = 0; i < 5; i++) {
    const next = nextBackoff(state, { offset: 7, conflict: false, failed: true })
    delays.push(next.delay)
    state = next.state
  }
  assert.deepEqual(delays, [1_000, 5_000, 15_000, 60_000, 60_000])
  assert.equal(state.failures, 5, "past BACKOFF_MS.length is exactly startPolling's give-up threshold")
})

test('nextBackoff: a new stuck offset restarts the ladder rather than inheriting the old threshold', () => {
  const next = nextBackoff({ failures: 3, stuckAt: 7 }, { offset: 8, conflict: false, failed: true })
  assert.equal(next.delay, 1_000)
  assert.deepEqual(next.state, { failures: 1, stuckAt: 8 })
})

test('nextBackoff: a successful pass resets the ladder entirely', () => {
  const next = nextBackoff({ failures: 4, stuckAt: 7 }, { offset: 8, conflict: false, failed: false })
  assert.deepEqual(next, { state: { failures: 0, stuckAt: null }, delay: 0 })
})
