// POST /api/setup/test — probe an endpoint before committing to it, so the
// wizard can show a real result rather than a hopeful tick.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import type { Server } from 'node:http'
import { Socket } from 'node:net'
import { handleSetupTest } from '../../../server/routes/setup-test.ts'

// The probe's JSON answer, as the route writes it.
interface ProbeResult {
  ok?: boolean
  models?: unknown
  error?: string
}

// A real ServerResponse with writeHead/end swapped for recorders, the same
// shape test/server/lib/static-cache.test.ts uses: the route answers through
// lib/http.ts's json(), which is typed against node:http, so a plain object
// with the two methods on it is not a ServerResponse.
interface Sent {
  statusCode: number
  body: ProbeResult
}

function fakeRes(): { raw: ServerResponse; sent: Sent } {
  const raw = new ServerResponse(new IncomingMessage(new Socket()))
  const sent: Sent = { statusCode: 0, body: {} }
  raw.writeHead = (code: number) => {
    sent.statusCode = code
    return raw
  }
  raw.end = (body?: unknown) => {
    if (typeof body === 'string') sent.body = JSON.parse(body)
    return raw
  }
  return { raw, sent }
}

// readBody() is event-based, so a plain object with an async iterator is not
// enough — it has to be a real stream. An IncomingMessage rather than the
// Readable.from the untyped tests use: handleSetupTest is typed against
// node:http, and a bare Readable is not an IncomingMessage.
function fakeReq(body: unknown): IncomingMessage {
  const req = new IncomingMessage(new Socket())
  req.push(Buffer.from(JSON.stringify(body)))
  req.push(null)
  return req
}

// A stand-in endpoint: /models answers only with the right bearer token.
let endpoint: Server
let base: string
before(async () => {
  endpoint = createServer((req, res) => {
    if (req.url === '/v1/models' && req.headers.authorization === 'Bearer good-key') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }))
    }
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'bad key' } }))
  })
  await new Promise<void>(r => endpoint.listen(0, '127.0.0.1', () => r()))
  const addr = endpoint.address()
  assert.ok(addr !== null && typeof addr === 'object', 'listening on a TCP port, so address() is an AddressInfo')
  base = `http://127.0.0.1:${addr.port}/v1`
})
after(() => endpoint.close())

test('a good key returns the endpoint model list', async () => {
  const res = fakeRes()
  await handleSetupTest(fakeReq({ baseUrl: base, apiKey: 'good-key' }), res.raw)
  assert.equal(res.sent.statusCode, 200)
  assert.equal(res.sent.body.ok, true)
  assert.deepEqual(res.sent.body.models, ['model-a', 'model-b'])
})

test('a bad key fails with a readable message, not a stack trace', async () => {
  const res = fakeRes()
  await handleSetupTest(fakeReq({ baseUrl: base, apiKey: 'wrong' }), res.raw)
  assert.equal(res.sent.statusCode, 200, 'a refused key is a result, not a server error')
  assert.equal(res.sent.body.ok, false)
  assert.ok(res.sent.body.error && res.sent.body.error.length > 0)
})

// The person reading this is at a key field in the browser, not at the
// container's environment — pointing them at KOTHAI_AI_API_KEY was advice
// for a different audience.
test('a refused key is reported as the key, with no env var to go and set', async () => {
  const res = fakeRes()
  await handleSetupTest(fakeReq({ baseUrl: base, apiKey: 'wrong' }), res.raw)
  assert.match(res.sent.body.error || '', /key was refused/)
  assert.doesNotMatch(res.sent.body.error || '', /KOTHAI_/)
})

test('an unreachable endpoint reports that rather than hanging', async () => {
  const res = fakeRes()
  await handleSetupTest(fakeReq({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: '' }), res.raw)
  assert.equal(res.sent.body.ok, false)
  assert.ok(res.sent.body.error && res.sent.body.error.length > 0)
})

test('a missing base URL is rejected before any network call', async () => {
  const res = fakeRes()
  await handleSetupTest(fakeReq({ apiKey: 'k' }), res.raw)
  assert.equal(res.sent.statusCode, 400)
})

test('a non-http scheme is refused — file:// and friends are not endpoints', async () => {
  const res = fakeRes()
  await handleSetupTest(fakeReq({ baseUrl: 'file:///etc/passwd' }), res.raw)
  assert.equal(res.sent.statusCode, 400)
})

test('the probe never echoes the key back', async () => {
  const res = fakeRes()
  await handleSetupTest(fakeReq({ baseUrl: base, apiKey: 'good-key' }), res.raw)
  assert.ok(!JSON.stringify(res.sent.body).includes('good-key'))
})
