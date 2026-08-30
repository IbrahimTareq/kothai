// Unit tests for the remote provider's HTTP layer, run against a real
// throwaway http server on localhost — no network, no fetch mocking, so the
// assertions cover genuine request/response handling.
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

function reply(status, body, headers = {}) {
  handler = (req, res) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  }
}

test('posts JSON and returns the parsed body', async () => {
  let seen = null
  handler = (req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      seen = { url: req.url, method: req.method, headers: req.headers, body: JSON.parse(raw) }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: 1 }))
    })
  }
  const out = await postJson(base, '/chat/completions', { model: 'm' }, { apiKey: 'sk-test' })
  assert.deepEqual(out, { ok: 1 })
  assert.equal(seen.url, '/chat/completions')
  assert.equal(seen.method, 'POST')
  assert.equal(seen.headers.authorization, 'Bearer sk-test')
  assert.deepEqual(seen.body, { model: 'm' })
})

test('omits the authorization header when no key is configured (Ollama needs none)', async () => {
  let auth = 'unset'
  handler = (req, res) => {
    auth = req.headers.authorization
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  }
  await postJson(base, '/x', {}, {})
  assert.equal(auth, undefined)
})

test('401 maps to a non-transient auth_failed error', async () => {
  reply(401, { error: 'bad key' })
  const e = await postJson(base, '/x', {}, {}).catch((x) => x)
  assert.ok(e instanceof RemoteError)
  assert.equal(e.code, 'auth_failed')
  assert.equal(e.transient, false)
})

test('403 also maps to auth_failed', async () => {
  reply(403, {})
  const e = await postJson(base, '/x', {}, {}).catch((x) => x)
  assert.equal(e.code, 'auth_failed')
  assert.equal(e.transient, false)
})

test('404 maps to a non-transient model_not_found error', async () => {
  reply(404, { error: 'no such model' })
  const e = await postJson(base, '/x', {}, {}).catch((x) => x)
  assert.equal(e.code, 'model_not_found')
  assert.equal(e.transient, false)
})

test('429 maps to a transient rate_limited error carrying Retry-After', async () => {
  reply(429, {}, { 'retry-after': '7' })
  const e = await postJson(base, '/x', {}, {}).catch((x) => x)
  assert.equal(e.code, 'rate_limited')
  assert.equal(e.transient, true)
  assert.equal(e.retryAfterMs, 7000)
})

test('500 maps to a transient endpoint_error', async () => {
  reply(500, {})
  const e = await postJson(base, '/x', {}, {}).catch((x) => x)
  assert.equal(e.code, 'endpoint_error')
  assert.equal(e.transient, true)
})

test('a timeout maps to a transient endpoint_unreachable error', async () => {
  handler = () => {} // never responds
  const e = await postJson(base, '/x', {}, { timeoutMs: 50 }).catch((x) => x)
  assert.equal(e.code, 'endpoint_unreachable')
  assert.equal(e.transient, true)
})

test('a refused connection maps to endpoint_unreachable', async () => {
  const e = await postJson('http://127.0.0.1:1', '/x', {}, { timeoutMs: 500 }).catch((x) => x)
  assert.equal(e.code, 'endpoint_unreachable')
  assert.equal(e.transient, true)
})

test('a non-JSON success body maps to a transient bad_response error', async () => {
  handler = (req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('not json') }
  const e = await postJson(base, '/x', {}, {}).catch((x) => x)
  assert.equal(e.code, 'bad_response')
})
