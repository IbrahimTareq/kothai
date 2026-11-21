// The Ollama tile names two places an Ollama can be: the compose profile's
// `ollama` service, and the host. Hard-wired to the host alone, the tile never
// reached the profile's Ollama, which publishes no port, and there is no URL
// field to fix it from. The connection check tries the tile's URLs in order
// and reports the one that answered, which is what then gets saved.
//
// The catalogue is mocked so both URLs point at loopback: one dead, one live.
import { test, mock, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import type { Server } from 'node:http'
import { Socket } from 'node:net'
import type { Endpoint } from '../../../server/ai/endpoints.ts'

const DEAD = 'http://127.0.0.1:1/v1'
let live = ''
const tile = (): Endpoint => ({
  id: 'ollama-local',
  label: 'Ollama',
  baseUrl: DEAD,
  fallbackUrl: live,
  needsKey: false,
  servesEmbeddings: true,
  note: '',
  defaults: { llm: 'a', embed: 'b', vision: 'c' },
})
const real = await import('../../../server/ai/endpoints.ts')
mock.module('../../../server/ai/endpoints.ts', {
  namedExports: { ...real, findEndpoint: (id: string | null) => (id === 'ollama-local' ? tile() : null) },
})
const { handleSetupTest } = await import('../../../server/routes/setup-test.ts')

function fakeRes() {
  const raw = new ServerResponse(new IncomingMessage(new Socket()))
  const sent: { body: Record<string, unknown> } = { body: {} }
  raw.writeHead = () => raw
  raw.end = (body?: unknown) => {
    if (typeof body === 'string') sent.body = JSON.parse(body)
    return raw
  }
  return { raw, sent }
}
function fakeReq(body: unknown): IncomingMessage {
  const req = new IncomingMessage(new Socket())
  req.push(Buffer.from(JSON.stringify(body)))
  req.push(null)
  return req
}

let ollama: Server
before(async () => {
  ollama = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'llama3.2:3b' }] }))
  })
  await new Promise<void>(r => ollama.listen(0, '127.0.0.1', () => r()))
  const addr = ollama.address()
  assert.ok(addr !== null && typeof addr === 'object')
  live = `http://127.0.0.1:${addr.port}/v1`
})
after(() => ollama.close())

test('the Ollama tile falls back to its second URL and reports the one that answered', async () => {
  const res = fakeRes()
  await handleSetupTest(fakeReq({ providerId: 'ollama-local', baseUrl: DEAD, apiKey: '' }), res.raw)
  assert.equal(res.sent.body.ok, true)
  assert.equal(res.sent.body.baseUrl, live, 'the URL saved must be the one that answered')
  assert.deepEqual(res.sent.body.models, ['llama3.2:3b'])
})

test('a URL that is not the tile’s own is probed as given, with no fallback', async () => {
  const res = fakeRes()
  await handleSetupTest(fakeReq({ providerId: 'ollama-local', baseUrl: 'http://127.0.0.1:2/v1', apiKey: '' }), res.raw)
  assert.equal(res.sent.body.ok, false)
})
