// POST /api/setup/test — probe an endpoint before committing to it, so the
// wizard can show a real result rather than a hopeful tick.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { handleSetupTest } from '../../../server/routes/setup-test.js'

function fakeRes() {
  return {
    statusCode: 0,
    body: null,
    writeHead(code) {
      this.statusCode = code
    },
    end(body) {
      this.body = JSON.parse(body)
    },
  }
}

// readBody() is event-based, so a plain object with an async iterator is not
// enough — the rest of the suite uses Readable.from for exactly this reason.
const fakeReq = body => Readable.from([Buffer.from(JSON.stringify(body))])

// A stand-in endpoint: /models answers only with the right bearer token.
let endpoint, base
before(async () => {
  endpoint = createServer((req, res) => {
    if (req.url === '/v1/models' && req.headers.authorization === 'Bearer good-key') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }))
    }
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'bad key' } }))
  })
  await new Promise(r => endpoint.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${endpoint.address().port}/v1`
})
after(() => endpoint.close())

test('a good key returns the endpoint model list', async () => {
  const res = fakeRes()
  await handleSetupTest(fakeReq({ baseUrl: base, apiKey: 'good-key' }), res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.ok, true)
  assert.deepEqual(res.body.models, ['model-a', 'model-b'])
})

test('a bad key fails with a readable message, not a stack trace', async () => {
  const res = fakeRes()
  await handleSetupTest(fakeReq({ baseUrl: base, apiKey: 'wrong' }), res)
  assert.equal(res.statusCode, 200, 'a refused key is a result, not a server error')
  assert.equal(res.body.ok, false)
  assert.ok(res.body.error.length > 0)
})

test('an unreachable endpoint reports that rather than hanging', async () => {
  const res = fakeRes()
  await handleSetupTest(fakeReq({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: '' }), res)
  assert.equal(res.body.ok, false)
  assert.ok(res.body.error.length > 0)
})

test('a missing base URL is rejected before any network call', async () => {
  const res = fakeRes()
  await handleSetupTest(fakeReq({ apiKey: 'k' }), res)
  assert.equal(res.statusCode, 400)
})

test('a non-http scheme is refused — file:// and friends are not endpoints', async () => {
  const res = fakeRes()
  await handleSetupTest(fakeReq({ baseUrl: 'file:///etc/passwd' }), res)
  assert.equal(res.statusCode, 400)
})

test('the probe never echoes the key back', async () => {
  const res = fakeRes()
  await handleSetupTest(fakeReq({ baseUrl: base, apiKey: 'good-key' }), res)
  assert.ok(!JSON.stringify(res.body).includes('good-key'))
})
