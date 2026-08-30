// Unit tests for the remote provider's request shaping and role gating,
// against a real throwaway http server.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRemoteProvider } from '../../../../server/ai/providers/remote.js'

let server, base, routes

before(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const fn = routes[req.url]
      if (!fn) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{}') }
      fn(req, res, raw ? JSON.parse(raw) : null)
    })
  })
  await new Promise((r) => server.listen(0, r))
  base = `http://127.0.0.1:${server.address().port}`
})

after(() => server.close())

const okJson = (res, body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
const chatReply = (content) => ({ choices: [{ message: { content } }] })

beforeEach(() => {
  routes = { '/models': (req, res) => okJson(res, { data: [{ id: 'llama3.2:3b' }, { id: 'nomic-embed-text' }] }) }
})

const make = (models = { llm: 'llama3.2:3b', embed: 'nomic-embed-text', vision: 'llava' }) =>
  createRemoteProvider({ baseUrl: base, apiKey: null, models })

test('capabilities reports a remote provider that neither manages residency nor downloads weights', () => {
  assert.deepEqual(make().capabilities(), { kind: 'remote', managesResidency: false, downloadsWeights: false })
})

test('embedText posts to /embeddings and returns the vector', async () => {
  let seen = null
  routes['/embeddings'] = (req, res, body) => { seen = body; okJson(res, { data: [{ embedding: [0.1, 0.2] }] }) }
  const p = make()
  await p.init()
  assert.deepEqual(await p.embedText('hello'), [0.1, 0.2])
  assert.equal(seen.model, 'nomic-embed-text')
  assert.equal(seen.input, 'hello')
})

test('embedText prefixes query and document differently when the endpoint is serving EmbeddingGemma', async () => {
  // The prefix decision is keyed on the configured model NAME, because a
  // remote endpoint may be serving anything — see prompts.js's embedInput.
  let seen
  routes['/embeddings'] = (req, res, body) => { seen = body; okJson(res, { data: [{ embedding: [1] }] }) }
  const p = make({ llm: 'llama3.2:3b', embed: 'embeddinggemma:300m', vision: 'llava' })

  await p.embedText('brown butter pasta', { mode: 'query' })
  assert.equal(seen.input, 'task: search result | query: brown butter pasta')

  await p.embedText('brown butter pasta', { mode: 'document' })
  assert.equal(seen.input, 'title: none | text: brown butter pasta')

  await p.embedText('brown butter pasta')
  assert.equal(seen.input, 'title: none | text: brown butter pasta', 'document is the default')
})

test('embedText leaves input untouched for an endpoint serving a model that is not prompt-instructed', async () => {
  let seen
  routes['/embeddings'] = (req, res, body) => { seen = body; okJson(res, { data: [{ embedding: [1] }] }) }
  await make().embedText('brown butter pasta', { mode: 'query' }) // default model: nomic-embed-text
  assert.equal(seen.input, 'brown butter pasta')
})

test('embedText truncates very long input to a TOKEN budget, the same way the local provider does', async () => {
  // A character cap cannot keep the request inside the model's fixed batch
  // size, because characters are not tokens — see prompts.js's clipToTokens.
  let seen = null
  routes['/embeddings'] = (req, res, body) => { seen = body; okJson(res, { data: [{ embedding: [1] }] }) }
  const p = make()
  await p.init()

  await p.embedText('x'.repeat(9000))
  const ascii = seen.input.length
  assert.ok(ascii > 2000 && ascii < 3400, `ASCII budget landed at ${ascii} chars`)

  // The same character count of non-Latin text costs far more per character,
  // so far fewer characters fit — which is the entire point.
  await p.embedText('م'.repeat(9000))
  assert.ok(seen.input.length < ascii / 3, `non-Latin budget landed at ${seen.input.length} chars`)
})

test('classify requests json_schema and normalises the result', async () => {
  let seen = null
  routes['/chat/completions'] = (req, res, body) => {
    seen = body
    okJson(res, chatReply(JSON.stringify({ type: 'link', category: 'Tech', title: 'T', summary: 'S', tags: ['a', 'instagram'] })))
  }
  const p = make()
  await p.init()
  const out = await p.classify({ text: 'https://x.com', isUrl: true, now: 'now' })
  assert.equal(seen.response_format.type, 'json_schema')
  assert.equal(seen.model, 'llama3.2:3b')
  assert.equal(out.type, 'link')
  assert.deepEqual(out.tags, ['a'], 'junk tag must be filtered by the shared normaliser')
})

test('classify retries without json_schema when the endpoint rejects it', async () => {
  const bodies = []
  routes['/chat/completions'] = (req, res, body) => {
    bodies.push(body)
    if (bodies.length === 1) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'response_format unsupported' })) }
    okJson(res, chatReply(JSON.stringify({ type: 'text', category: 'C', title: 'T', summary: 'S', tags: ['x'] })))
  }
  const p = make()
  await p.init()
  const out = await p.classify({ text: 'hi', now: 'now' })
  assert.equal(bodies.length, 2)
  assert.ok(!bodies[1].response_format, 'retry must drop response_format')
  assert.equal(out.type, 'text')
})

test('classify json_schema 400 does not open the circuit when plain retry succeeds', async () => {
  const bodies = []
  routes['/chat/completions'] = (req, res, body) => {
    bodies.push(body)
    if (bodies.length === 1) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'response_format unsupported' })) }
    okJson(res, chatReply(JSON.stringify({ type: 'text', category: 'C', title: 'T', summary: 'S', tags: [] })))
  }
  const p = make()
  await p.init()
  await p.classify({ text: 'hi', now: 'now' })
  assert.equal(p.available(), true, 'circuit must stay closed after schema probe 400 + successful retry')
  assert.equal(p.statusSnapshot().aggregate.state, 'ready')
})

test('classify opens the circuit on a genuine failure, not just on the plain-prompt retry', async () => {
  // Regression: the json_schema probe attempt runs outside call() so its
  // "unsupported" 400 doesn't trip the breaker (see the test above) — but a
  // real outage (endpoint unreachable, auth failure, 5xx) must still count.
  // classify() is the backlog's dominant call, so if failures here never
  // reach the circuit, a dead endpoint never halts the enrich queue.
  const dead = createRemoteProvider({ baseUrl: 'http://127.0.0.1:1', apiKey: null, models: { llm: 'm', embed: 'e', vision: 'v' } })
  await dead.init()
  for (let i = 0; i < 5; i++) {
    await dead.classify({ text: 'hi', now: 'now' }).catch(() => {})
  }
  assert.equal(dead.available(), false, 'circuit must open after repeated genuine classify failures')
})

test('classify falls back to heuristics when output is unparseable after the retry', async () => {
  routes['/chat/completions'] = (req, res) => okJson(res, chatReply('sorry, I cannot'))
  const p = make()
  await p.init()
  const out = await p.classify({ text: 'https://youtube.com/watch?v=1', isUrl: true, now: 'now' })
  assert.equal(out.type, 'video', 'heuristicType must supply the type')
  assert.equal(out.category, 'General')
})

test('describeImage inlines the file as a base64 data URL content part', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kothai-img-'))
  const file = path.join(dir, 'a.png')
  writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  let seen = null
  routes['/chat/completions'] = (req, res, body) => { seen = body; okJson(res, chatReply('a png')) }
  const p = make()
  await p.init()
  assert.equal(await p.describeImage({ absPath: file }), 'a png')
  const parts = seen.messages[0].content
  assert.equal(parts[0].type, 'text')
  assert.equal(parts[1].type, 'image_url')
  assert.match(parts[1].image_url.url, /^data:image\/png;base64,iVBORw==$/)
})

test('answer posts the shared system prompt and returns trimmed text', async () => {
  let seen = null
  routes['/chat/completions'] = (req, res, body) => { seen = body; okJson(res, chatReply('  the answer  ')) }
  const p = make()
  await p.init()
  const out = await p.answer({ question: 'q', contextNotes: [] })
  assert.equal(out, 'the answer')
  assert.match(seen.messages[0].content, /personal notes app/)
  assert.match(seen.messages[1].content, /QUESTION: q/)
})

test('a role with no model name configured is disabled, not attempted', async () => {
  const p = createRemoteProvider({ baseUrl: base, apiKey: null, models: { llm: 'm', embed: '', vision: '' } })
  await p.init()
  assert.equal(p.roleEnabled('embed'), false)
  assert.equal(p.roleEnabled('llm'), true)
  const e = await p.embedText('x').catch((x) => x)
  assert.equal(e.code, 'embed_off')
})

test('no base URL at all means every role is disabled and init does not throw', async () => {
  const p = createRemoteProvider({ baseUrl: null, apiKey: null, models: { llm: 'm', embed: 'e', vision: 'v' } })
  await p.init()
  assert.equal(p.roleEnabled('llm'), false)
  assert.equal(p.statusSnapshot().aggregate.state, 'ready', 'no endpoint is AI-free mode, not an error')
})

test('an unreachable endpoint reports error in the aggregate but still serves the app', async () => {
  const p = createRemoteProvider({ baseUrl: 'http://127.0.0.1:1', apiKey: null, models: { llm: 'm', embed: 'e', vision: 'v' } })
  await p.init()
  assert.equal(p.statusSnapshot().aggregate.state, 'error')
})

test('a non-transient failure opens the circuit and later calls fail fast without hitting the network', async () => {
  let hits = 0
  routes['/chat/completions'] = (req, res) => { hits++; res.writeHead(401, { 'content-type': 'application/json' }); res.end('{}') }
  const p = make()
  await p.init()
  await p.answer({ question: 'q', contextNotes: [] }).catch(() => {})
  assert.equal(hits, 1)
  const e = await p.answer({ question: 'q', contextNotes: [] }).catch((x) => x)
  assert.equal(hits, 1, 'circuit must be open — no second request')
  assert.equal(e.code, 'circuit_open')
  assert.equal(p.available(), false)
})

test('validateModel accepts any non-empty string and warns on one the endpoint does not list', async () => {
  const p = make()
  await p.init()
  assert.deepEqual(p.validateModel('llm', 'llama3.2:3b'), { ok: true })
  const r = p.validateModel('llm', 'not-on-this-server')
  assert.equal(r.ok, true, 'must not reject — the endpoint list can be stale or unavailable')
  assert.match(r.warning, /not listed/)
  assert.equal(p.validateModel('llm', '').ok, false)
})

test('listModels returns the endpoint catalogue for every role', async () => {
  const p = make()
  await p.init()
  const m = await p.listModels()
  assert.deepEqual(m.llm.map((x) => x.key), ['llama3.2:3b', 'nomic-embed-text'])
})
