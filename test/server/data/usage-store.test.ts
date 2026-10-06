// The ai_usage table: what each model call cost, summed for Settings.
//
// Sums must keep "not reported" apart from zero. llama.cpp and some Ollama
// builds send no usage block, and only OpenRouter reports a dollar cost, so
// a panel that turned every missing value into 0 would show a partial bill
// as the whole one.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { _resetDb, getDb } from '../../../server/data/db.ts'
import { insertUsage, summariseUsage, pruneUsage } from '../../../server/data/usage.ts'
import type { UsageRow } from '../../../server/data/usage.ts'

const row = (over: Partial<UsageRow> = {}): UsageRow => ({
  at: 1_000,
  step: 'classify',
  trigger: 'save',
  provider: 'remote',
  model: 'gpt-4o-mini',
  ok: true,
  status: 200,
  inputTokens: 600,
  outputTokens: 120,
  cachedTokens: 0,
  reasoningTokens: 0,
  costUsd: null,
  ms: 900,
  ...over,
})

beforeEach(() => {
  _resetDb()
})

test('rows are grouped by step and by trigger, slowest first', async () => {
  await insertUsage(row({ step: 'classify', trigger: 'save', ms: 900 }))
  await insertUsage(row({ step: 'classify', trigger: 'import', ms: 1_100 }))
  await insertUsage(row({ step: 'vision', trigger: 'import', ms: 5_000 }))
  const s = await summariseUsage(0)
  assert.equal(s.totals.calls, 3)
  assert.deepEqual(
    s.byStep.map(g => [g.key, g.calls, g.ms]),
    [
      ['vision', 1, 5_000],
      ['classify', 2, 2_000],
    ],
  )
  assert.deepEqual(
    s.byTrigger.map(g => [g.key, g.calls]),
    [
      ['import', 2],
      ['save', 1],
    ],
  )
})

test('a sum with nothing reported is null, not 0', async () => {
  await insertUsage(row({ provider: 'local', inputTokens: null, outputTokens: null, costUsd: null, status: null }))
  const s = await summariseUsage(0)
  assert.equal(s.totals.inputTokens, null)
  assert.equal(s.totals.costUsd, null)
  assert.equal(s.totals.costUnknownCalls, 0, 'a local call has no price to be missing')
})

test('reported costs are summed, and successful remote calls without one are counted', async () => {
  await insertUsage(row({ costUsd: 0.0004 }))
  await insertUsage(row({ costUsd: null }))
  await insertUsage(row({ ok: false, status: 429, costUsd: null, inputTokens: null, outputTokens: null }))
  const s = await summariseUsage(0)
  assert.equal(s.totals.costUsd, 0.0004)
  assert.equal(s.totals.costUnknownCalls, 1, 'the failed attempt is not an unpriced call')
  assert.equal(s.totals.failed, 1)
})

test('only rows since the cut-off are summed', async () => {
  await insertUsage(row({ at: 100 }))
  await insertUsage(row({ at: 5_000 }))
  assert.equal((await summariseUsage(1_000)).totals.calls, 1)
})

test('an empty table sums to zero calls and no groups', async () => {
  const s = await summariseUsage(0)
  assert.equal(s.totals.calls, 0)
  assert.equal(s.totals.ms, 0)
  assert.deepEqual(s.byStep, [])
})

test('prune deletes rows older than the cut-off and keeps the rest', async () => {
  await insertUsage(row({ at: 100 }))
  await insertUsage(row({ at: 5_000 }))
  await pruneUsage(1_000)
  const db = await getDb()
  assert.deepEqual(
    db
      .prepare('SELECT at FROM ai_usage')
      .all()
      .map(r => r.at),
    [5_000],
  )
})
