// The embed role changing provider invalidates every stored vector. This is
// the guard that rebuilds them, and the guard that stays quiet when nothing
// changed — a spurious re-embed of a large library is expensive.
//
// The pure predicate is tested on its own; the queueing function gets the
// same harness reembed-recipe.test.js uses, because the decisions worth
// protecting are the ones about the marker, not the return value. Recording
// the marker too eagerly strands a library that still owes a sweep; recording
// it too late (or never) means a later provider flip is measured against the
// wrong baseline and never noticed at all.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

let notes = []
let embedCalls = []
let residencyImpl = () => ({ llm: 'ondemand', embed: 'always', vision: 'ondemand' })
let storedProvider = null
let savedPatches = []

const realStore = await import('../../../server/data/notes.js')
const realTags = await import('../../../server/lib/tags.js')
const realTagvocab = await import('../../../server/data/tagvocab.js')
const realNormalise = await import('../../../server/ai/normalise.js')
const realCollections = await import('../../../server/data/collections.js')
const realSettings = await import('../../../server/data/settings.js')

mock.module('../../../server/data/notes.js', {
  namedExports: {
    ...realStore,
    allNotes: () => notes,
    count: () => notes.length,
    updateNote: async (id, patch) => {
      const n = notes.find((x) => x.id === id)
      if (n) Object.assign(n, patch)
      return n
    },
    flush: async () => {},
  },
})
mock.module('../../../server/lib/tags.js', { namedExports: { ...realTags, buildVocabulary: () => [] } })
mock.module('../../../server/data/tagvocab.js', { namedExports: { ...realTagvocab, canonicalize: async (t) => t } })
mock.module('../../../server/ai/index.js', {
  namedExports: {
    ...realNormalise,
    classify: async () => ({ type: 'link', category: 'General', title: 'T', summary: 'S', tags: [] }),
    // Each call records the marker as it stands mid-sweep, so the test can see
    // whether the new value was written before the vectors it describes exist.
    embedText: async (text) => { embedCalls.push({ text, markerNow: storedProvider }); return [text.length] },
  },
})
mock.module('../../../server/data/collections.js', { namedExports: { ...realCollections, autoAdd: async () => {} } })
mock.module('../../../server/data/settings.js', {
  namedExports: {
    ...realSettings,
    getResidency: () => residencyImpl(),
    getEmbedRecipe: () => 'recipe-current',
    getEmbedProvider: () => storedProvider,
    save: async (patch) => {
      savedPatches.push(patch)
      if (patch.embedProvider !== undefined) storedProvider = patch.embedProvider
      return {}
    },
  },
})

const enrich = await import('../../../server/ai/enrich.js')

const NOTE = { id: 'n1', title: 'Brown butter pasta', summary: 'A ten minute recipe.', content: 'text', tags: ['pasta'] }

function reset(list = [], marker = null) {
  notes = list.map((n) => ({ ...n }))
  embedCalls = []
  savedPatches = []
  storedProvider = marker
  residencyImpl = () => ({ llm: 'ondemand', embed: 'always', vision: 'ondemand' })
}

const drain = () => enrich.queueJob(() => {})

test('no stored value on a remote install means it was embedding remotely', () => {
  assert.equal(enrich.embedProviderChanged({ stored: null, resolved: 'local', wasRemote: true }), true)
  assert.equal(enrich.embedProviderChanged({ stored: null, resolved: 'remote', wasRemote: true }), false)
})

test('no stored value on a local install means it was embedding locally', () => {
  assert.equal(enrich.embedProviderChanged({ stored: null, resolved: 'local', wasRemote: false }), false)
  assert.equal(enrich.embedProviderChanged({ stored: null, resolved: 'remote', wasRemote: false }), true)
})

test('a stored value is believed over any inference', () => {
  assert.equal(enrich.embedProviderChanged({ stored: 'local', resolved: 'local', wasRemote: true }), false)
  assert.equal(enrich.embedProviderChanged({ stored: 'remote', resolved: 'local', wasRemote: false }), true)
})

test('with the embed role off, nothing is queued AND no marker is written', async () => {
  reset([NOTE], null)
  residencyImpl = () => ({ llm: 'off', embed: 'off', vision: 'off' })

  assert.equal(enrich.queueEmbedProviderReembed({ resolved: 'local', wasRemote: true }), false)
  await drain()
  assert.equal(embedCalls.length, 0)
  assert.equal(storedProvider, null, 'recording a provider the role never embedded with would strand the library')
  assert.deepEqual(savedPatches, [], 'the role being off is not evidence of anything worth recording')

  // Role switched back on: the absent marker means the change is still owed.
  residencyImpl = () => ({ llm: 'ondemand', embed: 'always', vision: 'ondemand' })
  assert.equal(enrich.queueEmbedProviderReembed({ resolved: 'local', wasRemote: true }), true)
})

test('unchanged with no stored marker records the inference so a later flip is measurable', async () => {
  reset([NOTE], null)

  assert.equal(enrich.queueEmbedProviderReembed({ resolved: 'remote', wasRemote: true }), false)
  await drain()
  assert.equal(embedCalls.length, 0, 'nothing changed, so nothing to re-embed')
  assert.equal(storedProvider, 'remote', 'the inference must be written down the first time it is made')
})

test('unchanged with a stored marker queues nothing and leaves the marker alone', async () => {
  reset([NOTE], 'local')

  assert.equal(enrich.queueEmbedProviderReembed({ resolved: 'local', wasRemote: true }), false)
  await drain()
  assert.equal(embedCalls.length, 0)
  assert.equal(storedProvider, 'local')
  assert.deepEqual(savedPatches, [], 'the marker already says the right thing')
})

test('a changed provider with an empty library records the new value without sweeping', async () => {
  reset([], 'remote')

  assert.equal(enrich.queueEmbedProviderReembed({ resolved: 'local', wasRemote: true }), false)
  await drain()
  assert.equal(embedCalls.length, 0)
  assert.equal(storedProvider, 'local', 'a fresh install must not be told it owes a re-embed on every boot')
})

test('a changed provider with notes sweeps the library and records the marker only afterwards', async () => {
  reset([NOTE, { ...NOTE, id: 'n2' }], 'remote')

  assert.equal(enrich.queueEmbedProviderReembed({ resolved: 'local', wasRemote: true }), true)
  assert.equal(storedProvider, 'remote', 'the marker must not move before the job has even run')
  await drain()

  assert.equal(embedCalls.length, 2)
  assert.ok(
    embedCalls.every((c) => c.markerNow === 'remote'),
    'a marker written mid-sweep would claim vectors that do not exist yet if the process died',
  )
  assert.equal(storedProvider, 'local')
})

test('an install that was embedding remotely still notices a later wholesale flip to local', async () => {
  reset([NOTE], null)

  // Boot one: nothing changed, but the inference gets written down.
  assert.equal(enrich.queueEmbedProviderReembed({ resolved: 'remote', wasRemote: true }), false)
  await drain()
  assert.equal(embedCalls.length, 0)
  assert.equal(storedProvider, 'remote')

  // Boot two, after STASH_AI_PROVIDER was flipped wholesale. Inferring from
  // the environment again would compare 'local' against 'local' and miss it.
  assert.equal(enrich.queueEmbedProviderReembed({ resolved: 'local', wasRemote: false }), true)
  await drain()
  assert.equal(embedCalls.length, 1, 'the library was still holding vectors from the endpoint')
  assert.equal(storedProvider, 'local')
})
