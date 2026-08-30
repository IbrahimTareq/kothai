// The cross-provider contract suite: the SAME assertions run against both
// providers. Shape drift between local and remote is the primary risk in the
// provider design — a note classified on-device and one classified against a
// remote endpoint must be indistinguishable downstream — and this is the only
// test that catches it.
//
// Local is stubbed at the @qvac/sdk boundary (module mocks, already enabled
// for this suite via the test script's --experimental-test-module-mocks).
// Remote runs against a throwaway http server. Neither touches the network.
import { test, mock, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

const CLASSIFICATION = { type: 'link', category: 'Tech', title: 'A Title', summary: 'A summary.', tags: ['alpha', 'beta', 'instagram'] }
const VECTOR = [0.1, 0.2, 0.3]

let server, base

before(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      if (req.url === '/models') return res.end(JSON.stringify({ data: [{ id: 'test-model' }] }))
      if (req.url === '/embeddings') return res.end(JSON.stringify({ data: [{ embedding: VECTOR }] }))
      const body = JSON.parse(raw)
      const isClassify = Boolean(body.response_format) || /return JSON only/.test(body.messages[0].content)
      res.end(JSON.stringify({ choices: [{ message: { content: isClassify ? JSON.stringify(CLASSIFICATION) : 'An answer citing [1].' } }] }))
    })
  })
  await new Promise((r) => server.listen(0, r))
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  if (localMod) await localMod.shutdown()
  await new Promise((r) => server.close(r))
})

let localMod = null

async function localProvider() {
  if (!localMod) {
    mock.module('@qvac/sdk', {
      namedExports: {
        loadModel: async () => 'model-1',
        unloadModel: async () => {},
        close: async () => {},
        embed: async () => ({ embedding: VECTOR }),
        cancel: async () => {},
        completion: ({ history }) => {
          const text = /return JSON only/.test(history[0].content) ? JSON.stringify(CLASSIFICATION) : 'An answer citing [1].'
          return {
            requestId: 'req-1',
            // Chunked so the streaming path is exercised across a boundary
            // rather than handed the whole answer in one delta.
            events: (async function* () {
              for (const chunk of text.match(/[\s\S]{1,7}/g) || []) yield { type: 'contentDelta', seq: 0, text: chunk }
              yield { type: 'completionDone', seq: 1, stopReason: 'eos' }
            })(),
            final: Promise.resolve({ contentText: text }),
          }
        },
        QWEN3_1_7B_INST_Q4: { name: 'llm', expectedSize: 1 },
        EMBEDDINGGEMMA_300M_Q8_0: { name: 'embed', expectedSize: 1 },
        QWEN3_5_2B_MULTIMODAL_Q4_K_M: { name: 'vision', expectedSize: 1 },
        MMPROJ_QWEN3_5_2B_MULTIMODAL_F16: { name: 'proj', expectedSize: 1 },
      },
    })
    localMod = await import('../../../../server/ai/providers/local.js')
    await localMod.init({ local: { llm: 'QWEN3_1_7B_INST_Q4', embed: 'EMBEDDINGGEMMA_300M_Q8_0', vision: 'QWEN3_5_2B_MULTIMODAL_Q4_K_M' } })
    await localMod.applyResidency({ llm: 'ondemand', embed: 'ondemand', vision: 'ondemand' })
  }
  return localMod
}

async function remoteProvider() {
  const { createRemoteProvider } = await import('../../../../server/ai/providers/remote.js')
  const p = createRemoteProvider({ baseUrl: base, apiKey: null, models: { llm: 'test-model', embed: 'test-model', vision: 'test-model' } })
  await p.init()
  return p
}

const PROVIDERS = [
  ['local', localProvider],
  ['remote', remoteProvider],
]

for (const [name, build] of PROVIDERS) {
  test(`${name}: capabilities has exactly the three descriptor keys`, async () => {
    const caps = (await build()).capabilities()
    assert.deepEqual(Object.keys(caps).sort(), ['downloadsWeights', 'kind', 'managesResidency'])
    assert.equal(caps.kind, name)
    assert.equal(typeof caps.managesResidency, 'boolean')
    assert.equal(typeof caps.downloadsWeights, 'boolean')
  })

  test(`${name}: classify returns the full normalised shape with junk filtered`, async () => {
    const out = await (await build()).classify({ text: 'https://example.com', isUrl: true, now: '2026-01-01' })
    assert.deepEqual(Object.keys(out).sort(), ['category', 'summary', 'tags', 'title', 'type'])
    assert.equal(out.type, 'link')
    assert.equal(out.category, 'Tech')
    assert.equal(out.title, 'A Title')
    assert.deepEqual(out.tags, ['alpha', 'beta'], 'both providers must run the shared junk-tag filter')
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
    const seen = []
    const out = await p.answerStream({ question: 'q', contextNotes: [], onToken: (t) => seen.push(t) })
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
    for (const role of ['llm', 'embed', 'vision']) assert.equal(typeof p.roleEnabled(role), 'boolean')
  })

  test(`${name}: listModels returns an option list per role`, async () => {
    const m = await (await build()).listModels()
    assert.deepEqual(Object.keys(m).sort(), ['embed', 'llm', 'vision'])
    for (const role of ['llm', 'embed', 'vision']) assert.ok(Array.isArray(m[role]))
  })

  test(`${name}: validateModel returns an ok flag`, async () => {
    const r = (await build()).validateModel('llm', 'test-model')
    assert.equal(typeof r.ok, 'boolean')
  })
}
