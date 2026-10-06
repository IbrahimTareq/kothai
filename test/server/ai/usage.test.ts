// How a model call is labelled and recorded: server/ai/usage.ts.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

let failInsert = false
const realStore = await import('../../../server/data/usage.ts')
mock.module('../../../server/data/usage.ts', {
  namedExports: {
    ...realStore,
    insertUsage: async (r: Parameters<typeof realStore.insertUsage>[0]) => {
      if (failInsert) throw new Error('database is locked')
      return realStore.insertUsage(r)
    },
  },
})

const { _resetDb, getDb } = await import('../../../server/data/db.ts')
const usage = await import('../../../server/ai/usage.ts')

const CALL = {
  provider: 'remote' as const,
  model: 'm',
  ok: true,
  status: 200,
  inputTokens: 1,
  outputTokens: 1,
  cachedTokens: null,
  reasoningTokens: null,
  costUsd: null,
  ms: 5,
}

async function rows() {
  const db = await getDb()
  // node:sqlite hands rows back with a null prototype; spread them so they
  // compare equal to plain object literals.
  return db
    .prepare('SELECT step, triggered_by AS trigger FROM ai_usage ORDER BY id')
    .all()
    .map(r => ({ ...r }))
}

test('nothing is recorded before the server starts the log', async () => {
  _resetDb()
  await usage.recordUsage(CALL)
  assert.deepEqual(await rows(), [])
})

test('a call is recorded under the step and trigger it ran inside', async () => {
  _resetDb()
  await usage.startUsageLog()
  await usage.withTrigger('import', () => usage.withStep('classify', () => usage.recordUsage(CALL)))
  assert.deepEqual(await rows(), [{ step: 'classify', trigger: 'import' }])
})

test('an unlabelled call is recorded as other, so a missing label shows', async () => {
  _resetDb()
  await usage.startUsageLog()
  await usage.recordUsage(CALL)
  assert.deepEqual(await rows(), [{ step: 'other', trigger: 'other' }])
})

test('the outer step wins: tag embeds stay tag-embed through the facade', async () => {
  _resetDb()
  await usage.startUsageLog()
  await usage.withStep('tag-embed', () => usage.withStep('embed', () => usage.recordUsage(CALL)))
  assert.deepEqual(await rows(), [{ step: 'tag-embed', trigger: 'other' }])
})

// Node carries an AsyncLocalStorage store into a .then() callback registered
// under it, however much later the chain reaches it. queue.ts relies on that
// to keep each job's trigger without capturing it by hand. Checked on 22.23.
test('a job queued under a trigger keeps it when the chain runs it later', async () => {
  _resetDb()
  await usage.startUsageLog()
  let chain: Promise<unknown> = Promise.resolve()
  const queue = (fn: () => unknown) => (chain = chain.then(fn))
  usage.withTrigger('import', () => queue(() => new Promise(r => setTimeout(r, 20))))
  usage.withTrigger('ask', () => queue(() => usage.recordUsage(CALL)))
  await chain
  assert.deepEqual(await rows(), [{ step: 'other', trigger: 'ask' }])
})

test('a failed write never fails the call, and is logged once', async () => {
  _resetDb()
  await usage.startUsageLog()
  const errors = mock.method(console, 'error', () => {})
  failInsert = true
  await assert.doesNotReject(usage.recordUsage(CALL))
  await assert.doesNotReject(usage.recordUsage(CALL))
  failInsert = false
  assert.equal(errors.mock.callCount(), 1)
  errors.mock.restore()
})

test('starting the log prunes rows older than 90 days', async () => {
  _resetDb()
  const DAY = 86_400_000
  const now = 200 * DAY
  await realStore.insertUsage({ at: now - 91 * DAY, step: 's', trigger: 't', ...CALL })
  await realStore.insertUsage({ at: now - 89 * DAY, step: 's', trigger: 't', ...CALL })
  await usage.startUsageLog(now)
  assert.equal((await rows()).length, 1)
})
