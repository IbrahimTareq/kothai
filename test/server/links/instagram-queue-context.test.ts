// The Instagram lane is one long-lived pump, started by whichever caller
// queued first. A note's settle handler queues its model work, so each job
// must settle in the context it was queued in, not the pump's: otherwise a
// whole import queued while one Telegram save drained the lane was recorded
// as that save in the usage panel.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

const realStore = await import('../../../server/data/notes.ts')
mock.module('../../../server/data/notes.ts', {
  namedExports: { ...realStore, getNote: () => null, updateNote: async () => null },
})
const realMeta = await import('../../../server/links/meta.ts')
mock.module('../../../server/links/meta.ts', {
  namedExports: { ...realMeta, fetchLinkMeta: async () => ({}) },
})

const { _resetDb, getDb } = await import('../../../server/data/db.ts')
const { startUsageLog, recordUsage, withTrigger } = await import('../../../server/ai/usage.ts')
const { queueIgMeta, setFetchSettledHandler } = await import('../../../server/links/instagram-queue.ts')

test('each job settles under the trigger it was queued with', async () => {
  _resetDb()
  await startUsageLog()
  const settled: Promise<void>[] = []
  const both = new Promise<void>(done =>
    setFetchSettledHandler(() => {
      settled.push(
        recordUsage({
          provider: 'remote',
          model: 'm',
          ok: true,
          status: 200,
          inputTokens: null,
          outputTokens: null,
          cachedTokens: null,
          reasoningTokens: null,
          costUsd: null,
          ms: 1,
        }),
      )
      if (settled.length === 2) done()
    }),
  )
  withTrigger('save', () => queueIgMeta('a', 'https://www.instagram.com/p/a/'))
  withTrigger('import', () => queueIgMeta('b', 'https://www.instagram.com/p/b/'))
  await both
  await Promise.all(settled)
  const db = await getDb()
  assert.deepEqual(
    db
      .prepare('SELECT triggered_by FROM ai_usage ORDER BY id')
      .all()
      .map(r => r.triggered_by),
    ['save', 'import'],
  )
})
