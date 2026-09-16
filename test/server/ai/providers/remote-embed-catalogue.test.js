// A provider whose embedding models are not in its chat catalogue.
//
// OpenRouter is the case: GET /v1/models returns hundreds of chat models and
// not one embedding, while /v1/embeddings/models holds thirty-odd. Populating
// the embedding role's dropdown from the chat list there offers the user
// hundreds of models, every one of which is wrong for the role — and then
// warns that the correct id "is not listed by the endpoint".
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRemoteProvider } from '../../../../server/ai/providers/remote.js'

let server, base, routes
before(async () => {
  server = createServer((req, res) => {
    const fn = routes[req.url]
    if (!fn) {
      res.writeHead(404, { 'content-type': 'application/json' })
      return res.end('{}')
    }
    fn(req, res)
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}/v1`
})
after(() => server.close())

const json = body => (req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
const ids = list => ({ data: list.map(id => ({ id })) })

beforeEach(() => {
  routes = {
    '/v1/models': json(ids(['chat-a', 'chat-b'])),
    '/v1/embeddings/models': json(ids(['vec-small', 'vec-large'])),
  }
})

test('without an embeddings path, every role shares the one catalogue', async () => {
  const p = createRemoteProvider({ baseUrl: base, apiKey: null, models: {} })
  await p.init()
  const out = await p.listModels()
  assert.deepEqual(
    out.embed.map(o => o.key),
    ['chat-a', 'chat-b'],
  )
  assert.deepEqual(
    out.llm.map(o => o.key),
    ['chat-a', 'chat-b'],
  )
})

test('with one, the embedding role gets its own list and the others do not', async () => {
  const p = createRemoteProvider({ baseUrl: base, apiKey: null, models: {}, embeddingsPath: '/embeddings/models' })
  await p.init()
  const out = await p.listModels()
  assert.deepEqual(
    out.embed.map(o => o.key),
    ['vec-small', 'vec-large'],
  )
  assert.deepEqual(
    out.llm.map(o => o.key),
    ['chat-a', 'chat-b'],
  )
  assert.deepEqual(
    out.vision.map(o => o.key),
    ['chat-a', 'chat-b'],
  )
})

test('a valid embedding id is not warned about just for missing the chat list', async () => {
  const p = createRemoteProvider({ baseUrl: base, apiKey: null, models: {}, embeddingsPath: '/embeddings/models' })
  await p.init()
  assert.deepEqual(p.validateModel('embed', 'vec-small'), { ok: true })
})

test('an embedding id in neither list still only warns, never rejects', async () => {
  const p = createRemoteProvider({ baseUrl: base, apiKey: null, models: {}, embeddingsPath: '/embeddings/models' })
  await p.init()
  const r = p.validateModel('embed', 'something-else')
  assert.equal(r.ok, true)
  assert.match(r.warning, /not listed/)
})

test('a chat id is still checked against the chat list', async () => {
  const p = createRemoteProvider({ baseUrl: base, apiKey: null, models: {}, embeddingsPath: '/embeddings/models' })
  await p.init()
  assert.deepEqual(p.validateModel('llm', 'chat-a'), { ok: true })
  assert.match(p.validateModel('llm', 'vec-small').warning, /not listed/)
})

// The second probe is a nicety. If it fails the provider must still come up —
// the chat roles are unaffected, and the embedding field falls back to the
// behaviour it had before this existed.
test('a failing embeddings probe does not take the provider down with it', async () => {
  routes['/v1/embeddings/models'] = (req, res) => {
    res.writeHead(500)
    res.end('nope')
  }
  const p = createRemoteProvider({ baseUrl: base, apiKey: null, models: {}, embeddingsPath: '/embeddings/models' })
  await p.init()
  const out = await p.listModels()
  assert.deepEqual(
    out.llm.map(o => o.key),
    ['chat-a', 'chat-b'],
    'chat still works',
  )
  assert.deepEqual(
    out.embed.map(o => o.key),
    ['chat-a', 'chat-b'],
    'and embed falls back',
  )
})

test('the endpoint being down entirely is still one failure, not two', async () => {
  const p = createRemoteProvider({
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: null,
    models: { llm: 'x' },
    embeddingsPath: '/embeddings/models',
  })
  await p.init()
  assert.equal(p.statusSnapshot().roles.llm.state, 'error')
})
