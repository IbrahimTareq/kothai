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

// Vision used to be required here too, and was relaxed for the (since
// retired) Ollama-on-Railway entry: CPU-only hardware where captioning is
// impractical, so it pulled no vision model — and a default naming one anyway
// would seed the field with a 404 at the first image instead of a role that is
// simply off. That still holds for any endpoint serving no vision model. Language and embedding stay required,
// because an empty default there is a first run that does nothing.
test('a provider that serves embeddings offers a language and an embedding default', () => {
  for (const e of ENDPOINTS.filter(x => x.servesEmbeddings)) {
    assert.ok(e.defaults.llm, `${e.id} is missing a language default`)
    assert.ok(e.defaults.embed, `${e.id} is missing an embedding default`)
  }
})

// A tile is a recommendation, and an endpoint that cannot do semantic search
// is half of one. Claude is the one deliberate exception: first run follows
// its tile with a second step that picks a provider for embeddings
// (views/SetupWizard.tsx), so the half it cannot do is still asked for.
test('every offered provider can do the whole job, except Claude', () => {
  for (const e of ENDPOINTS.filter(x => x.id !== 'claude')) {
    assert.equal(e.servesEmbeddings, true, `${e.id} would leave search half-working`)
  }
  const claude = findEndpoint('claude')
  assert.ok(claude, 'claude must be in the catalogue')
  assert.equal(claude.servesEmbeddings, false)
  assert.match(claude.note, /embeddings/, 'its tile says search by meaning needs a second provider')
})

// First in the list because it is the one that needs no account and no bill.
test('the provider on this machine is offered first', () => {
  assert.equal(ENDPOINTS[0].id, 'ollama-local')
})

// A chat-only provider must not claim an embedding model it cannot serve: the
// seed would send the embedding role to a route that is not there.
test('a chat-only provider would leave the embedding default empty', () => {
  for (const e of ENDPOINTS.filter(x => !x.servesEmbeddings)) {
    assert.equal(e.defaults.embed, '', `${e.id} must not claim an embedding model`)
  }
})

// Someone at the key field without a key is the commonest way to stall on
// this screen, and "go find it" is not an answer.
test('every provider that needs a key links to where one is made', () => {
  for (const e of ENDPOINTS.filter(x => x.needsKey)) {
    assert.equal(new URL(e.keyUrl || 'missing:').protocol, 'https:', `${e.id} has no https key link`)
  }
})

// gpt-4o-mini bills an image at 2,833 tokens plus 5,667 per 512px tile, so a
// 540×960 reel cover cost ~25.5k tokens: a 1,800-post Instagram import spent
// ~$4 of a $5 cap on cover frames alone and stopped part-way.
test('no preset describes images with gpt-4o-mini', () => {
  for (const e of ENDPOINTS) assert.doesNotMatch(e.defaults.vision, /gpt-4o-mini/, e.id)
})

test('findEndpoint returns null for an unknown id rather than throwing', () => {
  assert.equal(findEndpoint('not-a-provider'), null)
  assert.equal(findEndpoint(undefined), null)
})

test('openai serves embeddings and needs a key', () => {
  const openai = findEndpoint('openai')
  assert.ok(openai, 'openai must be in the catalogue')
  assert.equal(openai.servesEmbeddings, true)
  assert.equal(openai.needsKey, true)
})

test('a provider reachable without a key is marked so', () => {
  const ollama = findEndpoint('ollama-local')
  assert.ok(ollama, 'ollama-local must be in the catalogue')
  assert.equal(ollama.needsKey, false)
  assert.equal(ollama.servesEmbeddings, true)
})
