// The catalogue is what turns "type a model id" into "click OpenAI". It is
// pure data, so the tests are about internal consistency — a malformed entry
// would surface as a broken wizard tile, which no server test would catch.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ENDPOINTS, findEndpoint } from '../../../server/ai/endpoints.js'

test('every entry has a unique id', () => {
  const ids = ENDPOINTS.map((e) => e.id)
  assert.equal(new Set(ids).size, ids.length)
})

// 'other' carries no URL by design — the user supplies it — and new URL('')
// throws, so the parse check applies only to entries that claim one.
test('every base URL that exists parses and carries no credential', () => {
  for (const e of ENDPOINTS.filter((x) => x.baseUrl)) {
    const u = new URL(e.baseUrl)
    assert.ok(['http:', 'https:'].includes(u.protocol), `${e.id}: ${u.protocol}`)
    assert.equal(u.username, '', `${e.id} must not embed a username`)
    assert.equal(u.password, '', `${e.id} must not embed a password`)
  }
})

test('a provider that serves embeddings offers a default for all three roles', () => {
  for (const e of ENDPOINTS.filter((x) => x.servesEmbeddings && x.id !== 'other')) {
    for (const role of ['llm', 'embed', 'vision']) {
      assert.ok(e.defaults[role], `${e.id} is missing a ${role} default`)
    }
  }
})

test('a chat-only provider leaves the embedding default empty rather than guessing', () => {
  for (const e of ENDPOINTS.filter((x) => !x.servesEmbeddings)) {
    assert.equal(e.defaults.embed, '', `${e.id} must not claim an embedding model`)
  }
})

test('"other" exists as the manual escape hatch and presumes nothing', () => {
  const other = findEndpoint('other')
  assert.ok(other)
  assert.equal(other.baseUrl, '')
  assert.deepEqual(other.defaults, { llm: '', embed: '', vision: '' })
})

test('findEndpoint returns null for an unknown id rather than throwing', () => {
  assert.equal(findEndpoint('not-a-provider'), null)
  assert.equal(findEndpoint(undefined), null)
})

test('openai is the one provider that needs no on-device fallback', () => {
  const openai = findEndpoint('openai')
  assert.equal(openai.servesEmbeddings, true)
  assert.equal(openai.needsKey, true)
})

test('a provider reachable without a key is marked so', () => {
  const ollama = findEndpoint('ollama-local')
  assert.equal(ollama.needsKey, false)
  assert.equal(ollama.servesEmbeddings, true)
})
