// Tests for the library re-embed: the shared sweep both the model-swap path
// and the boot-time recipe check now run, and the gating that decides whether
// the boot check fires at all.
//
// Two things invalidate every vector in the library: swapping the embedding
// model, and changing the recipe — the task prefixes, or which note fields
// feed the input. Before this, only the first had a trigger, and the sweep it
// ran embedded fewer fields than enrichment did, so a model swap quietly
// downgraded the library's own vectors. Both halves are covered here.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

let notes = []
let embedCalls = []
let embedImpl = async (text) => [text.length]
let residencyImpl = () => ({ llm: 'ondemand', embed: 'always', vision: 'ondemand' })
let storedRecipe = null
let savedPatches = []
let flushes = 0

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
    flush: async () => { flushes++ },
  },
})
mock.module('../../../server/lib/tags.js', { namedExports: { ...realTags, buildVocabulary: () => [] } })
mock.module('../../../server/data/tagvocab.js', { namedExports: { ...realTagvocab, canonicalize: async (t) => t } })
mock.module('../../../server/ai/index.js', {
  namedExports: {
    ...realNormalise,
    classify: async () => ({ type: 'link', category: 'General', title: 'T', summary: 'S', tags: [] }),
    embedText: async (text, opts) => { embedCalls.push({ text, opts }); return embedImpl(text) },
  },
})
mock.module('../../../server/data/collections.js', { namedExports: { ...realCollections, autoAdd: async () => {} } })
mock.module('../../../server/data/settings.js', {
  namedExports: {
    ...realSettings,
    getResidency: () => residencyImpl(),
    getEmbedRecipe: () => storedRecipe,
    save: async (patch) => { savedPatches.push(patch); if (patch.embedRecipe !== undefined) storedRecipe = patch.embedRecipe; return {} },
  },
})

const enrich = await import('../../../server/ai/enrich.js')
const { EMBED_RECIPE } = await import('../../../server/ai/prompts.js')

function reset(list = []) {
  notes = list.map((n) => ({ ...n }))
  embedCalls = []
  savedPatches = []
  flushes = 0
  storedRecipe = null
  embedImpl = async (text) => [text.length]
  residencyImpl = () => ({ llm: 'ondemand', embed: 'always', vision: 'ondemand' })
}

// A saved reel: everything worth embedding lives in fields the old inlined
// sweep did not read.
const REEL = {
  id: 'r1',
  title: 'Brown butter pasta',
  summary: 'A ten minute recipe.',
  content: 'https://www.instagram.com/reel/ABC/',
  url: 'https://www.instagram.com/reel/ABC/',
  siteTitle: 'chefsteps',
  siteDesc: 'Three ingredients and ten minutes. #pasta',
  article: 'A longer transcript of the video.',
  thumbDescription: 'Overlay text reads 3 INGREDIENT PASTA.',
  tags: ['pasta', 'brownbutter'],
}

test('embedBodyFor reads every field enrichment embeds, not the short legacy list', () => {
  const body = enrich.embedBodyFor(REEL)
  for (const field of ['Brown butter pasta', 'ten minute recipe', 'chefsteps', 'Three ingredients', 'longer transcript', '3 INGREDIENT PASTA', 'pasta brownbutter']) {
    assert.ok(body.includes(field), `missing "${field}" — a re-embed must not produce a weaker vector than the original enrichment did`)
  }
})

test('reembedAll embeds every note once, writes once, and records the new recipe', async () => {
  reset([REEL, { ...REEL, id: 'r2' }, { ...REEL, id: 'r3' }])
  const n = await enrich.reembedAll('test')

  assert.equal(n, 3)
  assert.equal(embedCalls.length, 3)
  assert.match(embedCalls[0].text, /3 INGREDIENT PASTA/)
  assert.equal(flushes, 1, 'one batched transaction for the whole library, not one write per note')
  assert.equal(storedRecipe, EMBED_RECIPE)
  assert.ok(notes.every((x) => Array.isArray(x.embedding)))
})

test('reembedAll survives one unembeddable note rather than abandoning the rest of the library', async () => {
  reset([REEL, { ...REEL, id: 'r2' }, { ...REEL, id: 'r3' }])
  embedImpl = async (text) => { if (embedCalls.length === 2) throw new Error('model blew up'); return [text.length] }

  await enrich.reembedAll('test')
  assert.equal(embedCalls.length, 3, 'the sweep kept going')
  assert.equal(notes.filter((x) => Array.isArray(x.embedding)).length, 2)
  assert.equal(storedRecipe, EMBED_RECIPE)
})

test('reembedAll skips a note with no embeddable text at all', async () => {
  reset([{ id: 'empty', tags: [] }])
  await enrich.reembedAll('test')
  assert.equal(embedCalls.length, 0)
})

test('queueRecipeReembed fires exactly once when the stored recipe is stale, then stays quiet', async () => {
  reset([REEL, { ...REEL, id: 'r2' }])
  storedRecipe = 'v1-something-older'

  assert.equal(enrich.queueRecipeReembed(), true)
  await enrich.queueJob(() => {}) // drain
  assert.equal(embedCalls.length, 2)
  assert.equal(storedRecipe, EMBED_RECIPE)

  // Next boot: the marker now matches, so nothing is queued.
  assert.equal(enrich.queueRecipeReembed(), false)
  await enrich.queueJob(() => {})
  assert.equal(embedCalls.length, 2)
})

test('a library that predates the marker entirely (null) is treated as stale and re-embedded', async () => {
  reset([REEL])
  storedRecipe = null
  assert.equal(enrich.queueRecipeReembed(), true)
  await enrich.queueJob(() => {})
  assert.equal(embedCalls.length, 1)
})

test('with the embed role off, nothing is queued AND the marker is left stale so the sweep still runs later', async () => {
  reset([REEL])
  storedRecipe = 'v1-older'
  residencyImpl = () => ({ llm: 'off', embed: 'off', vision: 'off' })

  assert.equal(enrich.queueRecipeReembed(), false)
  await enrich.queueJob(() => {})
  assert.equal(embedCalls.length, 0)
  assert.equal(storedRecipe, 'v1-older', 'recording the new recipe here would strand the library forever')

  // Role switched back on: the stale marker means the sweep is still owed.
  residencyImpl = () => ({ llm: 'ondemand', embed: 'always', vision: 'ondemand' })
  assert.equal(enrich.queueRecipeReembed(), true)
})

test('an empty library records the recipe without queueing a sweep over nothing', async () => {
  reset([])
  storedRecipe = 'v1-older'
  assert.equal(enrich.queueRecipeReembed(), false)
  await enrich.queueJob(() => {})
  assert.equal(embedCalls.length, 0)
  assert.equal(storedRecipe, EMBED_RECIPE, 'a fresh install must not be told it owes a re-embed on every boot')
})

test('notes enriched normally record the recipe they were embedded under', async () => {
  reset([{ id: 'n1', content: 'plain text note', type: 'text', ai: {} }])
  await enrich.queueEnrich('n1', { absPath: null, text: 'plain text note', isUrl: false, hasImage: false })
  assert.equal(notes[0].ai.embed, true)
  assert.equal(notes[0].ai.embedRecipe, EMBED_RECIPE)
})
