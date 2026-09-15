// Retrying a rate-limited endpoint.
//
// The HTTP layer classified 429 as transient and parsed Retry-After into
// retryAfterMs from the start — and then nothing ever read that field. A rate
// limit meant the call failed for good, so an import against a metered account
// lost a note's classification, embedding and caption outright and left it on
// heuristics until someone found the Enrich backlog button.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { postJson, RemoteError } from '../../../../server/ai/providers/remote-http.js'

let server, base, handler
before(async () => {
  server = createServer((req, res) => handler(req, res))
  await new Promise((r) => server.listen(0, r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => server.close())

// Injected so the tests assert the WAITS without serving them.
const spy = () => {
  const waits = []
  return { waits, sleep: async (ms) => { waits.push(ms) } }
}

// Fails with `status` the first `times` calls, then succeeds.
function flaky(status, times, headers = {}) {
  let n = 0
  handler = (req, res) => {
    if (n++ < times) {
      res.writeHead(status, { 'content-type': 'application/json', ...headers })
      return res.end(JSON.stringify({ error: { message: 'slow down' } }))
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, attempts: n }))
  }
}

test('a rate limit that clears is retried rather than lost', async () => {
  flaky(429, 2)
  const { sleep, waits } = spy()
  const out = await postJson(base, '/x', {}, { sleep })
  assert.equal(out.ok, true)
  assert.equal(waits.length, 2, 'it waited between attempts')
})

test("the endpoint's own Retry-After is honoured over our backoff", async () => {
  flaky(429, 1, { 'retry-after': '7' })
  const { sleep, waits } = spy()
  await postJson(base, '/x', {}, { sleep })
  assert.equal(waits[0], 7000, 'wait exactly as long as we were asked to')
})

test('an absurd Retry-After is capped rather than hanging enrichment for an hour', async () => {
  flaky(429, 1, { 'retry-after': '3600' })
  const { sleep, waits } = spy()
  await postJson(base, '/x', {}, { sleep })
  assert.ok(waits[0] <= 30_000, `waited ${waits[0]}ms`)
})

test('backoff grows when the endpoint says nothing about when to return', async () => {
  flaky(429, 2)
  const { sleep, waits } = spy()
  await postJson(base, '/x', {}, { sleep })
  assert.ok(waits[1] > waits[0], `expected growth, got ${waits.join(', ')}`)
})

test('a server error is retried too — it is the same kind of transient', async () => {
  flaky(503, 1)
  const { sleep } = spy()
  const out = await postJson(base, '/x', {}, { sleep })
  assert.equal(out.ok, true)
})

test('a bad key is NOT retried — every attempt costs money and none can succeed', async () => {
  flaky(401, 99)
  const { sleep, waits } = spy()
  await assert.rejects(() => postJson(base, '/x', {}, { sleep }), (e) => e.code === 'auth_failed')
  assert.equal(waits.length, 0, 'no retry, no wait')
})

test('an unknown model is not retried either', async () => {
  flaky(404, 99)
  const { sleep, waits } = spy()
  await assert.rejects(() => postJson(base, '/x', {}, { sleep }))
  assert.equal(waits.length, 0)
})

test('retries are bounded — a permanently limited account fails rather than spinning', async () => {
  flaky(429, 99)
  const { sleep, waits } = spy()
  await assert.rejects(() => postJson(base, '/x', {}, { sleep }), (e) => e instanceof RemoteError && e.code === 'rate_limited')
  assert.ok(waits.length <= 3, `gave up after ${waits.length} waits`)
})

test('retries can be switched off, for a probe the user is waiting on', async () => {
  flaky(429, 99)
  const { sleep, waits } = spy()
  await assert.rejects(() => postJson(base, '/x', {}, { sleep, retries: 0 }))
  assert.equal(waits.length, 0, 'Test connection must answer now, not in 30 seconds')
})

test('the final error still carries retryAfterMs for the circuit breaker', async () => {
  flaky(429, 99, { 'retry-after': '12' })
  const { sleep } = spy()
  await assert.rejects(
    () => postJson(base, '/x', {}, { sleep }),
    (e) => e.retryAfterMs === 12_000,
  )
})
