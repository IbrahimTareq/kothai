// The offset is Telegram's delivery acknowledgement: advancing past an update
// tells Telegram to forget it. So it advances only after the note is safely
// persisted — a duplicate capture is recoverable by hand, a lost one is not.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pollOnce } from '../../../server/telegram/poll.ts'
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
