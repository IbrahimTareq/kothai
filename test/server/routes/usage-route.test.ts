// GET /api/usage: where model time and money went, for Settings.
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { listenOnLoopback, mockRes, record, records } from '../../helpers/http.ts'
import { createServer } from '../../../server/router.ts'
import { _resetDb } from '../../../server/data/db.ts'
import { insertUsage } from '../../../server/data/usage.ts'
import { handleUsage } from '../../../server/routes/usage.ts'

const DAY = 86_400_000
const row = (at: number, step: string) => ({
  at,
  step,
  trigger: 'save',
  provider: 'remote' as const,
  model: 'm',
  ok: true,
  status: 200,
  inputTokens: 10,
  outputTokens: 2,
  cachedTokens: null,
  reasoningTokens: null,
  costUsd: null,
  ms: 100,
})

async function get(url: string) {
  const { res, sent } = mockRes()
  await handleUsage(res, new URL(url, 'http://x'))
  assert.equal(sent.code, 200)
  return sent.json()
}

beforeEach(() => {
  _resetDb()
})

test('totals and groups cover only the asked-for window', async () => {
  await insertUsage(row(Date.now() - 2 * DAY, 'classify'))
  await insertUsage(row(Date.now() - 10 * DAY, 'vision'))
  const body = await get('/api/usage?days=7')
  assert.equal(body.days, 7)
  assert.equal(record(body.totals).calls, 1)
  assert.deepEqual(
    records(body.byStep).map(g => g.key),
    ['classify'],
  )
})

for (const [query, days] of [
  ['', 30],
  ['?days=abc', 30],
  ['?days=-5', 30],
  ['?days=0', 30],
  ['?days=1e9', 90],
  ['?days=12.7', 12],
] as const) {
  test(`days${query || ' (absent)'} reads as ${days}`, async () => {
    assert.equal((await get(`/api/usage${query}`)).days, days)
  })
}

test('the route is registered', async () => {
  const server = createServer()
  after(() => server.close())
  const res = await fetch(`http://127.0.0.1:${await listenOnLoopback(server)}/api/usage`)
  assert.equal(res.status, 200)
  assert.equal(record(await res.json()).days, 30)
})
