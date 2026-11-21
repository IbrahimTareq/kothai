// The provider contract suite. It was written to run the SAME assertions
// against an on-device provider and the remote one, because shape drift
// between them was the primary risk; the on-device provider is gone, and the
// suite still pins the shapes everything downstream reads. The remote provider
// runs against a throwaway http server and never touches the network.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { ROLES } from '../../../../server/ai/roles.ts'
import type { Provider } from '../../../../server/ai/providers/types.ts'
import { listenOnLoopback, record, records } from '../../../helpers/http.ts'

const CLASSIFICATION = {
  type: 'link',
  category: 'Tech',
  title: 'A Title',
  summary: 'A summary.',
  tags: ['alpha', 'beta', 'instagram'],
}
const VECTOR = [0.1, 0.2, 0.3]

let server: Server
let base: string

before(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', c => (raw += c))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      if (req.url === '/models') return res.end(JSON.stringify({ data: [{ id: 'test-model' }] }))
      if (req.url === '/embeddings') return res.end(JSON.stringify({ data: [{ embedding: VECTOR }] }))
      // Checked rather than read off `any`: JSON.parse answers `any`, and a
      // request whose body is not the chat shape would otherwise be routed to
      // the answer branch silently instead of failing here.
      const body = record(JSON.parse(raw))
      const firstMessage = records(body.messages)[0].content
      const isClassify =
        Boolean(body.response_format) || (typeof firstMessage === 'string' && /return JSON only/.test(firstMessage))
      res.end(
        JSON.stringify({
          choices: [{ message: { content: isClassify ? JSON.stringify(CLASSIFICATION) : 'An answer citing [1].' } }],
        }),
      )
    })
  })
  base = `http://127.0.0.1:${await listenOnLoopback(server)}`
})

after(async () => {
  await new Promise<void>(r => {
    server.close(() => r())
  })
})

async function remoteProvider(): Promise<Provider> {
  const { createRemoteProvider } = await import('../../../../server/ai/providers/remote.ts')
  const p = createRemoteProvider({
    endpoints: {
      llm: { baseUrl: base, apiKey: null },
      embed: { baseUrl: base, apiKey: null },
      vision: { baseUrl: base, apiKey: null },
    },
    models: { llm: 'test-model', embed: 'test-model', vision: 'test-model' },
  })
  await p.init()
  return p
}

// Annotated rather than inferred, and that annotation is part of what the
// suite asserts: the builder has to hand back something the checker accepts as
// a whole Provider, so a missing member is a typecheck error here as well as a
// failing assertion below.
const PROVIDERS: [string, () => Promise<Provider>][] = [['remote', remoteProvider]]

for (const [name, build] of PROVIDERS) {
  test(`${name}: capabilities names the kind and nothing else`, async () => {
    assert.deepEqual((await build()).capabilities(), { kind: name })
  })

  test(`${name}: classify returns the full normalised shape with junk filtered`, async () => {
    const out = await (await build()).classify({
      text: 'https://example.com',
      now: '2026-01-01',
    })
    assert.deepEqual(Object.keys(out).sort(), ['category', 'summary', 'tags', 'title', 'type'])
    assert.equal(out.type, 'link')
    assert.equal(out.category, 'Tech')
    assert.equal(out.title, 'A Title')
    assert.deepEqual(out.tags, ['alpha', 'beta'], 'the provider must run the shared junk-tag filter')
  })

  test(`${name}: embedText returns a plain number array`, async () => {
    const v = await (await build()).embedText('hello')
    assert.ok(Array.isArray(v))
    assert.deepEqual(v, VECTOR)
  })

  test(`${name}: answer returns trimmed plain text`, async () => {
    const a = await (await build()).answer({ question: 'q', contextNotes: [] })
    assert.equal(typeof a, 'string')
    assert.equal(a, a.trim())
    assert.match(a, /\[1\]/)
  })

  // Streaming is the path the Ask view actually uses; a provider that can't
  // stream must still satisfy it by delivering the answer in one delta, so the
  // route and the client never branch on which provider is configured.
  test(`${name}: answerStream emits deltas and resolves to the same text as answer`, async () => {
    const p = await build()
    const seen: string[] = []
    // The streaming member is optional on the contract, so asserting it is
    // present is part of the claim this test makes: a provider that dropped it
    // used to surface here as "p.answerStream is not a function".
    assert.ok(p.answerStream, 'every provider must offer the streaming path')
    const out = await p.answerStream({ question: 'q', contextNotes: [], onToken: t => seen.push(t) })
    assert.equal(typeof out, 'string')
    assert.equal(out, out.trim())
    assert.ok(seen.length > 0, 'at least one delta must be emitted')
    assert.equal(seen.join(''), out, 'the deltas must reconstruct the answer exactly')
    assert.equal(out, await p.answer({ question: 'q', contextNotes: [] }))
  })

  test(`${name}: statusSnapshot has roles for all three plus an aggregate`, async () => {
    const s = (await build()).statusSnapshot()
    assert.deepEqual(Object.keys(s).sort(), ['aggregate', 'roles'])
    assert.deepEqual(Object.keys(s.roles).sort(), ['embed', 'llm', 'vision'])
    for (const r of Object.values(s.roles)) {
      assert.deepEqual(Object.keys(r).sort(), ['message', 'model', 'progress', 'state'])
    }
    assert.ok(['loading', 'ready', 'error'].includes(s.aggregate.state))
  })

  test(`${name}: roleEnabled answers for every role without throwing`, async () => {
    const p = await build()
    for (const role of ROLES) assert.equal(typeof p.roleEnabled(role), 'boolean')
  })

  test(`${name}: listModels returns an option list per role`, async () => {
    const m = await (await build()).listModels()
    assert.deepEqual(Object.keys(m).sort(), ['embed', 'llm', 'vision'])
    for (const role of ROLES) assert.ok(Array.isArray(m[role]))
  })

  test(`${name}: validateModel returns an ok flag`, async () => {
    const r = (await build()).validateModel('llm', 'test-model')
    assert.equal(typeof r.ok, 'boolean')
  })
}
