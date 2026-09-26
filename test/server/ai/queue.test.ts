// The job chain's run counter, which the Settings Enrichment row reads through
// GET /api/enrich/backlog. The chain is a bare promise, so without the counter
// nothing could say how far a run had got.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { queueJob, queueProgress } from '../../../server/ai/queue.ts'

test('counts a run, a failed job included, and resets once idle', async () => {
  assert.deepEqual(queueProgress(), { done: 0, total: 0 })
  let release = () => {}
  const held = new Promise<void>(r => {
    release = r
  })

  const first = queueJob(() => {})
  queueJob(() => held)
  const last = queueJob(() => {
    throw new Error('endpoint down')
  })
  assert.deepEqual(queueProgress(), { done: 0, total: 3 })

  await first
  assert.deepEqual(queueProgress(), { done: 1, total: 3 }, 'mid-run: one done, two left')

  release()
  await last
  assert.deepEqual(queueProgress(), { done: 0, total: 0 }, 'idle: the next run counts from zero')
})

// recovery.ts re-queues notes from the circuit's onRecover, which fires inside
// a model call in a running job. The run must not reset when that outer job
// settles while the jobs it queued are still waiting.
test('a job queued from inside a running job joins the same run', async () => {
  assert.deepEqual(queueProgress(), { done: 0, total: 0 })
  let inner: Promise<unknown> = Promise.resolve()
  await queueJob(() => {
    inner = queueJob(() => {})
  })
  assert.deepEqual(queueProgress(), { done: 1, total: 2 })
  await inner
  assert.deepEqual(queueProgress(), { done: 0, total: 0 })
})
