// Every attempt against a model route is one usage row: server/ai/providers/remote-http.ts.
//
// Per attempt rather than per call, so the attempts nobody otherwise sees
// show up as failed rows: retries on 429/5xx, and the rejected rungs of the
// reasoning step-down.
import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { ServerResponse } from 'node:http'
import { listenOnLoopback } from '../../../helpers/http.ts'
import { _resetDb, getDb } from '../../../../server/data/db.ts'
import { startUsageLog, withStep } from '../../../../server/ai/usage.ts'
import { postJson, getJson } from '../../../../server/ai/providers/remote-http.ts'

type Route = (res: ServerResponse, body: Record<string, unknown>) => void
let routes: Record<string, Route> = {}
const server = createServer((req, res) => {
  let raw = ''
  req.on('data', c => (raw += c))
  req.on('end', () => {
    const fn = req.url ? routes[req.url] : undefined
    if (!fn) {
      res.writeHead(404)
      return res.end('{}')
    }
    fn(res, raw ? JSON.parse(raw) : {})
  })
})
const base = `http://127.0.0.1:${await listenOnLoopback(server)}`
after(() => server.close())

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
const noSleep = async () => {}

async function rows() {
  const db = await getDb()
  // recordUsage is not awaited by the wire code; let its insert land.
  await new Promise(r => setImmediate(r))
  return db
    .prepare(
      'SELECT step, model, ok, status, input_tokens, output_tokens, cached_tokens, reasoning_tokens, cost_usd FROM ai_usage ORDER BY id',
    )
    .all()
    .map(r => ({ ...r }))
}

beforeEach(async () => {
  _resetDb()
  await startUsageLog()
  routes = {}
})

test("a chat call records the endpoint's usage, cost and token details", async () => {
  routes['/chat/completions'] = res =>
    send(res, 200, {
      choices: [{ message: { content: 'x' } }],
      usage: {
        prompt_tokens: 600,
        completion_tokens: 120,
        prompt_tokens_details: { cached_tokens: 64 },
        completion_tokens_details: { reasoning_tokens: 0 },
        cost: 0.00016,
      },
    })
  await withStep('classify', () => postJson(base, '/chat/completions', { model: 'gpt-4o-mini', messages: [] }))
  assert.deepEqual(await rows(), [
    {
      step: 'classify',
      model: 'gpt-4o-mini',
      ok: 1,
      status: 200,
      input_tokens: 600,
      output_tokens: 120,
      cached_tokens: 64,
      reasoning_tokens: 0,
      cost_usd: 0.00016,
    },
  ])
})

test('an endpoint that sends no usage block records nulls, not zeros', async () => {
  routes['/embeddings'] = res => send(res, 200, { data: [{ embedding: [0.1] }] })
  await postJson(base, '/embeddings', { model: 'nomic', input: 'x' })
  const [r] = await rows()
  assert.equal(r.input_tokens, null)
  assert.equal(r.cost_usd, null)
})

test('junk in the usage block becomes null rather than NaN', async () => {
  routes['/chat/completions'] = res =>
    send(res, 200, { choices: [], usage: { prompt_tokens: 'lots', completion_tokens: -3, cost: null } })
  await postJson(base, '/chat/completions', { model: 'm', messages: [] })
  const [r] = await rows()
  assert.equal(r.input_tokens, null)
  assert.equal(r.output_tokens, null)
})

test('a retried rate limit is two rows: the 429, then the success', async () => {
  let n = 0
  routes['/chat/completions'] = res =>
    n++ === 0 ? send(res, 429, { error: 'slow down' }) : send(res, 200, { choices: [] })
  await postJson(base, '/chat/completions', { model: 'm', messages: [] }, { sleep: noSleep })
  assert.deepEqual(
    (await rows()).map(r => [r.ok, r.status]),
    [
      [0, 429],
      [1, 200],
    ],
  )
})

test("the reasoning step-down's rejected rungs are recorded as failed attempts", async () => {
  routes['/chat/completions'] = (res, body) =>
    'reasoning_effort' in body
      ? send(res, 400, { error: { message: "Unsupported value: 'reasoning_effort' does not support it" } })
      : send(res, 200, { choices: [] })
  await postJson(base, '/chat/completions', { model: 'usage-ladder', messages: [], reasoning_effort: 'none' })
  assert.deepEqual(
    (await rows()).map(r => [r.ok, r.status]),
    [
      [0, 400],
      [0, 400],
      [0, 400],
      [1, 200],
    ],
  )
})

test('a model-list probe is not a model call and records nothing', async () => {
  routes['/models'] = res => send(res, 200, { data: [] })
  await getJson(base, '/models')
  assert.deepEqual(await rows(), [])
})
