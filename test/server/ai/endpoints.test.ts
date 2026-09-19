// The catalogue is what turns "type a model id" into "click OpenAI". It is
// pure data, so the tests are about internal consistency — a malformed entry
// would surface as a broken wizard tile, which no server test would catch.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ENDPOINTS, findEndpoint } from '../../../server/ai/endpoints.ts'

test('every entry has a unique id', () => {
  const ids = ENDPOINTS.map(e => e.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('every entry is one click — a tile with no URL is a form, not a choice', () => {
  for (const e of ENDPOINTS) assert.ok(e.baseUrl, `${e.id} has no base URL`)
})

test('every base URL parses and carries no credential', () => {
  for (const e of ENDPOINTS) {
    const u = new URL(e.baseUrl)
    assert.ok(['http:', 'https:'].includes(u.protocol), `${e.id}: ${u.protocol}`)
    assert.equal(u.username, '', `${e.id} must not embed a username`)
    assert.equal(u.password, '', `${e.id} must not embed a password`)
  }
})

// Vision used to be required here too. It no longer is: ollama-railway is
// served by an Ollama the template stocks itself, on CPU-only hardware where
// captioning is impractical, so it pulls no vision model — and a default
// naming one anyway would seed the field with a 404 at the first image
// instead of a role that is simply off. Language and embedding stay required,
// because an empty default there is a first run that does nothing.
test('a provider that serves embeddings offers a language and an embedding default', () => {
  for (const e of ENDPOINTS.filter(x => x.servesEmbeddings)) {
    assert.ok(e.defaults.llm, `${e.id} is missing a language default`)
    assert.ok(e.defaults.embed, `${e.id} is missing an embedding default`)
  }
})

// The current invariant, asserted directly rather than left to a filter that
// happens to match nothing: a tile is a recommendation, and an endpoint that
// cannot do semantic search is not one. Chat-only services still work through
// --endpoint or KOTHAI_AI_BASE_URL; they are just not offered here.
test('every offered provider can do the whole job', () => {
  for (const e of ENDPOINTS) {
    assert.equal(e.servesEmbeddings, true, `${e.id} would leave search half-working`)
  }
})

// Kept as a guard on whatever gets added next: the moment a chat-only provider
// is offered again, it must not claim an embedding model it cannot serve.
test('a chat-only provider would leave the embedding default empty', () => {
  for (const e of ENDPOINTS.filter(x => !x.servesEmbeddings)) {
    assert.equal(e.defaults.embed, '', `${e.id} must not claim an embedding model`)
  }
})

test('findEndpoint returns null for an unknown id rather than throwing', () => {
  assert.equal(findEndpoint('not-a-provider'), null)
  assert.equal(findEndpoint(undefined), null)
})

test('openai is the one provider that needs no on-device fallback', () => {
  const openai = findEndpoint('openai')
  assert.ok(openai, 'openai must be in the catalogue')
  assert.equal(openai.servesEmbeddings, true)
  assert.equal(openai.needsKey, true)
})

test('the Railway entry addresses the private network and claims no vision model', () => {
  const railway = findEndpoint('ollama-railway')
  assert.ok(railway, 'ollama-railway must be in the catalogue')
  assert.equal(railway.needsKey, false)
  assert.equal(
    new URL(railway.baseUrl).hostname,
    'ollama.railway.internal',
    'the template reaches Ollama over Railway private networking, never a public host',
  )
  assert.equal(railway.defaults.vision, '', 'the template pulls no vision model')
})

test('a provider reachable without a key is marked so', () => {
  const ollama = findEndpoint('ollama-local')
  assert.ok(ollama, 'ollama-local must be in the catalogue')
  assert.equal(ollama.needsKey, false)
  assert.equal(ollama.servesEmbeddings, true)
})
