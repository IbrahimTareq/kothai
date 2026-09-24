// Unit tests for the remote provider's request shaping and role gating,
// against a real throwaway http server.
import { test, after, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { listenOnLoopback, record, records, text } from '../../../helpers/http.ts'
import type { RequestOptions } from '../../../../server/ai/providers/remote-http.ts'
import { FeatureDisabledError } from '../../../../server/ai/roles.ts'

// createRemoteProvider has no sleep hook of its own, so the retry-driven
// tests below (the dead-endpoint circuit test especially) paid the real
// exponential backoff on every attempt — 62s of the suite's 68s. Mocking the
// HTTP layer's own injectable `sleep` (remote-http.ts, already proven out by
// remote-retry.test.ts) removes the wait without touching retry semantics.
const realRemoteHttp = await import('../../../../server/ai/providers/remote-http.ts')
const noSleep = async () => {}
mock.module('../../../../server/ai/providers/remote-http.ts', {
  namedExports: {
    ...realRemoteHttp,
    postJson: (baseUrl: string, p: string, body: unknown, opts: RequestOptions = {}) =>
      realRemoteHttp.postJson(baseUrl, p, body, { ...opts, sleep: noSleep }),
    getJson: (baseUrl: string, p: string, opts: RequestOptions = {}) =>
      realRemoteHttp.getJson(baseUrl, p, { ...opts, sleep: noSleep }),
  },
})

const { createRemoteProvider } = await import('../../../../server/ai/providers/remote.ts')

type Route = (req: IncomingMessage, res: ServerResponse, body: unknown) => void
let routes: Record<string, Route> = {}

// Listening at module scope rather than in before(): a server built inside a
// hook is `Server | undefined` for the rest of the file, and every route table
// below would have to re-prove it.
const server = createServer((req, res) => {
  let raw = ''
  req.on('data', c => (raw += c))
  req.on('end', () => {
    const fn = req.url ? routes[req.url] : undefined
    if (!fn) {
      res.writeHead(404, { 'content-type': 'application/json' })
      return res.end('{}')
    }
    fn(req, res, raw ? JSON.parse(raw) : null)
  })
})
const base = `http://127.0.0.1:${await listenOnLoopback(server)}`

after(() => server.close())

const okJson = (res: ServerResponse, body: unknown) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
const chatReply = (content: unknown) => ({ choices: [{ message: { content } }] })

beforeEach(() => {
  routes = { '/models': (_req, res) => okJson(res, { data: [{ id: 'llama3.2:3b' }, { id: 'nomic-embed-text' }] }) }
})

const make = (models = { llm: 'llama3.2:3b', embed: 'nomic-embed-text', vision: 'llava' }) =>
  createRemoteProvider({ baseUrl: base, apiKey: null, models })

test('capabilities reports a remote provider that neither manages residency nor downloads weights', () => {
  assert.deepEqual(make().capabilities(), { kind: 'remote', managesResidency: false, downloadsWeights: false })
})

test('embedText posts to /embeddings and returns the vector', async () => {
  let seen: Record<string, unknown> = {}
  routes['/embeddings'] = (_req, res, body) => {
    seen = record(body)
    okJson(res, { data: [{ embedding: [0.1, 0.2] }] })
  }
  const p = make()
  await p.init()
  assert.deepEqual(await p.embedText('hello'), [0.1, 0.2])
  assert.equal(seen.model, 'nomic-embed-text')
  assert.equal(seen.input, 'hello')
})

test('embedText prefixes query and document differently when the endpoint is serving EmbeddingGemma', async () => {
  // The prefix decision is keyed on the configured model NAME, because a
  // remote endpoint may be serving anything — see prompts.ts's embedInput.
  let seen: Record<string, unknown> = {}
  routes['/embeddings'] = (_req, res, body) => {
    seen = record(body)
    okJson(res, { data: [{ embedding: [1] }] })
  }
  const p = make({ llm: 'llama3.2:3b', embed: 'embeddinggemma:300m', vision: 'llava' })

  await p.embedText('brown butter pasta', { mode: 'query' })
  assert.equal(seen.input, 'task: search result | query: brown butter pasta')

  await p.embedText('brown butter pasta', { mode: 'document' })
  assert.equal(seen.input, 'title: none | text: brown butter pasta')

  await p.embedText('brown butter pasta')
  assert.equal(seen.input, 'title: none | text: brown butter pasta', 'document is the default')
})

test('embedText leaves input untouched for an endpoint serving a model that is not prompt-instructed', async () => {
  let seen: Record<string, unknown> = {}
  routes['/embeddings'] = (_req, res, body) => {
    seen = record(body)
    okJson(res, { data: [{ embedding: [1] }] })
  }
  await make().embedText('brown butter pasta', { mode: 'query' }) // default model: nomic-embed-text
  assert.equal(seen.input, 'brown butter pasta')
})

test('embedText truncates very long input to a TOKEN budget, the same way the local provider does', async () => {
  // A character cap cannot keep the request inside the model's fixed batch
  // size, because characters are not tokens — see prompts.ts's clipToTokens.
  let seen: Record<string, unknown> = {}
  routes['/embeddings'] = (_req, res, body) => {
    seen = record(body)
    okJson(res, { data: [{ embedding: [1] }] })
  }
  const p = make()
  await p.init()

  await p.embedText('x'.repeat(9000))
  const ascii = text(seen.input).length
  assert.ok(ascii > 2000 && ascii < 3400, `ASCII budget landed at ${ascii} chars`)

  // The same character count of non-Latin text costs far more per character,
  // so far fewer characters fit — which is the entire point.
  await p.embedText('م'.repeat(9000))
  const nonLatin = text(seen.input).length
  assert.ok(nonLatin < ascii / 3, `non-Latin budget landed at ${nonLatin} chars`)
})

test('an embedding that is not an array reads as absent', async () => {
  // A non-array embedding used to be handed straight back untouched, so a
  // string or an object from the endpoint travelled on as if it were a vector
  // and failed far from here, in whatever tried to store or compare it.
  routes['/embeddings'] = (_req, res) => okJson(res, { data: [{ embedding: 'not-a-vector' }] })
  const p = make()
  await p.init()
  assert.deepEqual(await p.embedText('hello'), [])
})

test('classify requests json_schema and normalises the result', async () => {
  let seen: Record<string, unknown> = {}
  routes['/chat/completions'] = (_req, res, body) => {
    seen = record(body)
    okJson(
      res,
      chatReply(JSON.stringify({ type: 'link', category: 'Tech', title: 'T', summary: 'S', tags: ['a', 'instagram'] })),
    )
  }
  const p = make()
  await p.init()
  const out = await p.classify({ text: 'https://x.com', now: 'now' })
  assert.equal(record(seen.response_format).type, 'json_schema')
  assert.equal(seen.model, 'llama3.2:3b')
  assert.equal(out.type, 'link')
  assert.deepEqual(out.tags, ['a'], 'junk tag must be filtered by the shared normaliser')
})

test('classify retries without json_schema when the endpoint rejects it', async () => {
  const bodies: Record<string, unknown>[] = []
  routes['/chat/completions'] = (_req, res, body) => {
    bodies.push(record(body))
    if (bodies.length === 1) {
      res.writeHead(400, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: 'response_format unsupported' }))
    }
    okJson(res, chatReply(JSON.stringify({ type: 'link', category: 'C', title: 'T', summary: 'S', tags: ['x'] })))
  }
  const p = make()
  await p.init()
  const out = await p.classify({ text: 'hi', now: 'now' })
  assert.equal(bodies.length, 2)
  assert.ok(!bodies[1].response_format, 'retry must drop response_format')
  assert.equal(out.type, 'link')
})

test('classify json_schema 400 does not open the circuit when plain retry succeeds', async () => {
  const bodies: Record<string, unknown>[] = []
  routes['/chat/completions'] = (_req, res, body) => {
    bodies.push(record(body))
    if (bodies.length === 1) {
      res.writeHead(400, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: 'response_format unsupported' }))
    }
    okJson(res, chatReply(JSON.stringify({ type: 'link', category: 'C', title: 'T', summary: 'S', tags: [] })))
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
  const dead = createRemoteProvider({
    baseUrl: 'http://127.0.0.1:1',
    apiKey: null,
    models: { llm: 'm', embed: 'e', vision: 'v' },
  })
  await dead.init()
  for (let i = 0; i < 5; i++) {
    await dead.classify({ text: 'hi', now: 'now' }).catch(() => {})
  }
  assert.equal(dead.available(), false, 'circuit must open after repeated genuine classify failures')
})

test('classify falls back to heuristics when output is unparseable after the retry', async () => {
  routes['/chat/completions'] = (_req, res) => okJson(res, chatReply('sorry, I cannot'))
  const p = make()
  await p.init()
  const out = await p.classify({ text: 'https://youtube.com/watch?v=1', now: 'now' })
  assert.equal(out.type, 'video', 'heuristicType must supply the type')
  assert.equal(out.category, 'General')
})

test('describeImage inlines the file as a base64 data URL content part', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kothai-img-'))
  const file = path.join(dir, 'a.png')
  writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  let seen: Record<string, unknown> = {}
  routes['/chat/completions'] = (_req, res, body) => {
    seen = record(body)
    okJson(res, chatReply('a png'))
  }
  const p = make()
  await p.init()
  assert.equal(await p.describeImage({ absPath: file }), 'a png')
  const parts = records(records(seen.messages)[0].content)
  assert.equal(parts[0].type, 'text')
  assert.equal(parts[1].type, 'image_url')
  assert.match(text(record(parts[1].image_url).url), /^data:image\/png;base64,iVBORw==$/)
})

test('answer posts the shared system prompt and returns trimmed text', async () => {
  let seen: Record<string, unknown> = {}
  routes['/chat/completions'] = (_req, res, body) => {
    seen = record(body)
    okJson(res, chatReply('  the answer  '))
  }
  const p = make()
  await p.init()
  const out = await p.answer({ question: 'q', contextNotes: [] })
  assert.equal(out, 'the answer')
  const messages = records(seen.messages)
  assert.match(text(messages[0].content), /personal notes app/)
  assert.match(text(messages[1].content), /QUESTION: q/)
})

test('an answer whose content is not a string reads as no text', async () => {
  // A content field that was truthy but not a string used to reach .trim() and
  // throw TypeError out of answer(), so one malformed reply from the endpoint
  // surfaced as a crash in this app rather than an empty answer.
  routes['/chat/completions'] = (_req, res) => okJson(res, { choices: [{ message: { content: { text: 'hi' } } }] })
  const p = make()
  await p.init()
  assert.equal(await p.answer({ question: 'q', contextNotes: [] }), '')
})

test('a role with no model name configured is disabled, not attempted', async () => {
  const p = createRemoteProvider({ baseUrl: base, apiKey: null, models: { llm: 'm', embed: '', vision: '' } })
  await p.init()
  assert.equal(p.roleEnabled('embed'), false)
  assert.equal(p.roleEnabled('llm'), true)
  const e = await p.embedText('x').catch(x => x)
  // FeatureDisabledError, not RemoteError: a role that is off never reaches
  // the HTTP layer, so nothing maps a status code into a RemoteError.
  assert.ok(e instanceof FeatureDisabledError)
  assert.equal(e.code, 'embed_off')
})

test('no base URL at all means every role is disabled and init does not throw', async () => {
  // '' not null: remote.ts documents '' as the one falsy spelling for "no
  // endpoint configured", so every read of it stays a plain truthiness check.
  const p = createRemoteProvider({ baseUrl: '', apiKey: null, models: { llm: 'm', embed: 'e', vision: 'v' } })
  await p.init()
  assert.equal(p.roleEnabled('llm'), false)
  assert.equal(p.statusSnapshot().aggregate.state, 'ready', 'no endpoint is AI-free mode, not an error')
})

test('an unreachable endpoint reports error in the aggregate but still serves the app', async () => {
  const p = createRemoteProvider({
    baseUrl: 'http://127.0.0.1:1',
    apiKey: null,
    models: { llm: 'm', embed: 'e', vision: 'v' },
  })
  await p.init()
  assert.equal(p.statusSnapshot().aggregate.state, 'error')
})

test('a non-transient failure opens the circuit and later calls fail fast without hitting the network', async () => {
  let hits = 0
  routes['/chat/completions'] = (_req, res) => {
    hits++
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end('{}')
  }
  const p = make()
  await p.init()
  await p.answer({ question: 'q', contextNotes: [] }).catch(() => {})
  assert.equal(hits, 1)
  const e = await p.answer({ question: 'q', contextNotes: [] }).catch(x => x)
  assert.equal(hits, 1, 'circuit must be open — no second request')
  // Also a FeatureDisabledError: an open circuit is refused by guard()
  // before any request is made — which is what 'no second request' means.
  assert.ok(e instanceof FeatureDisabledError)
  assert.equal(e.code, 'circuit_open')
  assert.equal(p.available(), false)
})

test('a model one role cannot use fails that role alone, not the whole endpoint', async () => {
  // Regression, from a Railway install: vision was pointed at llama3.2:3b, a
  // text-only model. Ollama answered every thumbnail with 400 "model does not
  // support multimodal requests", that opened the ONE endpoint-wide circuit,
  // and the same note's classify and embed then failed with "Inference
  // endpoint is unavailable" — so no note was ever tagged or embedded.
  const dir = mkdtempSync(path.join(tmpdir(), 'kothai-img-'))
  const file = path.join(dir, 'a.png')
  writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  let visionHits = 0
  routes['/chat/completions'] = (_req, res, body) => {
    if (record(body).model === 'llama3.2:3b-as-vision') {
      visionHits++
      res.writeHead(400, { 'content-type': 'application/json' })
      return res.end(
        JSON.stringify({ error: 'Multimodal data provided, but model does not support multimodal requests.' }),
      )
    }
    okJson(res, chatReply(JSON.stringify({ type: 'link', category: 'C', title: 'T', summary: 'S', tags: ['x'] })))
  }
  routes['/embeddings'] = (_req, res) => okJson(res, { data: [{ embedding: [0.1] }] })
  const p = make({ llm: 'llama3.2:3b', embed: 'nomic-embed-text', vision: 'llama3.2:3b-as-vision' })
  await p.init()

  await p.describeImage({ absPath: file }).catch(() => {})
  const out = await p.classify({ text: 'hi', now: 'now' })
  assert.deepEqual(out.tags, ['x'], 'classify must still run after a vision 400')
  assert.deepEqual(await p.embedText('hi'), [0.1], 'embed must still run after a vision 400')

  // The broken role itself fails fast rather than re-sending every image.
  const e = await p.describeImage({ absPath: file }).catch(x => x)
  assert.equal(visionHits, 1)
  assert.ok(e instanceof FeatureDisabledError)
  // And says so where the user will look, without calling the endpoint down.
  const status = p.statusSnapshot()
  assert.equal(status.roles.vision.state, 'error')
  assert.match(status.roles.vision.message, /400/)
  assert.equal(status.roles.llm.state, 'ready')
  assert.equal(p.available(), true)
})

test('validateModel accepts any name, warns on one the endpoint does not list, and reads blank as off', async () => {
  const p = make()
  await p.init()
  assert.deepEqual(p.validateModel('llm', 'llama3.2:3b'), { ok: true })
  const r = p.validateModel('llm', 'not-on-this-server')
  assert.equal(r.ok, true, 'must not reject — the endpoint list can be stale or unavailable')
  assert.ok(r.warning, 'a model the endpoint does not list must carry a warning')
  assert.match(r.warning, /not listed/)
  assert.deepEqual(p.validateModel('llm', ''), { ok: true }, 'blank is how an endpoint role is switched off')
})

test('listModels returns the endpoint catalogue for every role', async () => {
  const p = make()
  await p.init()
  const m = await p.listModels()
  assert.deepEqual(
    m.llm.map(x => x.key),
    ['llama3.2:3b', 'nomic-embed-text'],
  )
})

test('a malformed catalogue row is skipped, not allowed to fail the whole probe', async () => {
  // A null row used to throw on m.id inside init()'s catch-all, which logged it
  // as a probe failure: one bad row emptied the catalogue for every role and
  // reported the endpoint as down while it was answering perfectly well.
  routes['/models'] = (_req, res) => okJson(res, { data: [{ id: 'llama3.2:3b' }, null, { id: 'nomic-embed-text' }] })
  const p = make()
  await p.init()
  const m = await p.listModels()
  assert.deepEqual(
    m.llm.map(x => x.key),
    ['llama3.2:3b', 'nomic-embed-text'],
  )
  assert.equal(p.statusSnapshot().aggregate.state, 'ready', 'a bad row is not the endpoint being down')
})

test('an endpoint that had no models at boot is re-probed rather than cached as empty', async () => {
  // The Railway template boots Kothai in seconds beside an Ollama that spends
  // minutes pulling weights. init() saw an endpoint serving nothing, cached
  // that, and the model picker stayed empty until someone restarted the
  // container — there is no other path that re-probes.
  let pulled = false
  let hits = 0
  routes['/models'] = (_req, res) => {
    hits += 1
    okJson(res, { data: pulled ? [{ id: 'llama3.2:3b' }, { id: 'nomic-embed-text' }] : [] })
  }
  const p = make()
  await p.init()
  assert.deepEqual((await p.listModels()).llm, [], 'still pulling — nothing to offer yet')
  assert.equal(hits, 2, 'an empty catalogue is asked again, not trusted')

  pulled = true
  assert.deepEqual(
    (await p.listModels()).llm.map(x => x.key),
    ['llama3.2:3b', 'nomic-embed-text'],
    'the pull finished, and reading the list again must find it — without a restart',
  )
  await p.listModels()
  assert.equal(hits, 3, 'a filled catalogue is served from cache')
})
