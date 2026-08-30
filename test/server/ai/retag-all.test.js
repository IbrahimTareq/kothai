// Tests for enrich.retagAll — the Settings "re-tag everything" action.
//
// Distinct from queueBacklog, which only offers steps a note is MISSING: a
// note classified months ago from its URL alone is not missing classify, it
// has a bad one, and no amount of enriching will replace it. retagAll re-opens
// the step across the library so every note is re-classified from what it
// carries now — its caption, its transcript, its thumbnail description.
//
// The behaviour that matters most here is the one that differs from the
// single-note retag: hand-edited tags survive. Per note, "Re-tag" is an
// explicit instruction about that note; across 1,700 notes one click must not
// silently destroy every correction the user has ever made.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

let notes = []
let classifyCalls = []
let embedCalls = []
let persisted = []   // ids written with { persist: false }
let flushes = 0
let availableImpl = () => true

const realStore = await import('../../../server/data/notes.js')
const realTags = await import('../../../server/lib/tags.js')
const realTagvocab = await import('../../../server/data/tagvocab.js')
const realNormalise = await import('../../../server/ai/normalise.js')
const realCollections = await import('../../../server/data/collections.js')
const realSettings = await import('../../../server/data/settings.js')
const realMeta = await import('../../../server/ai/meta.js')

mock.module('../../../server/ai/meta.js', {
  namedExports: { ...realMeta, fetchLinkMeta: async () => ({ siteTitle: 'A Title', siteDesc: 'a caption', siteName: 'S', thumb: null, article: null }) },
})
mock.module('../../../server/data/notes.js', {
  namedExports: {
    ...realStore,
    allNotes: () => notes,
    count: () => notes.length,
    updateNote: async (id, patch, opts) => {
      const n = notes.find((x) => x.id === id)
      if (!n) return null
      if (opts && opts.persist === false) persisted.push(id)
      Object.assign(n, patch)
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
    available: () => availableImpl(),
    classify: async (args) => {
      classifyCalls.push(args.text)
      return { type: 'link', category: 'Real', title: 'A Real Title', summary: 'A real summary.', tags: ['fresh', 'tags'] }
    },
    embedText: async (text) => { embedCalls.push(text); return [1, 2, 3] },
  },
})
mock.module('../../../server/data/collections.js', { namedExports: { ...realCollections, autoAdd: async () => {} } })
mock.module('../../../server/data/settings.js', {
  namedExports: { ...realSettings, getResidency: () => ({ llm: 'ondemand', embed: 'always', vision: 'off' }) },
})

const enrich = await import('../../../server/ai/enrich.js')

// Jobs queued by an earlier test keep draining on the shared FIFO, so the
// chain is settled BEFORE the counters are cleared — otherwise the next test
// starts counting the previous one's work.
async function reset(list) {
  await enrich.queueJob(() => {})
  notes = list.map((n) => ({ ...n }))
  classifyCalls = []
  embedCalls = []
  persisted = []
  flushes = 0
  availableImpl = () => true
}

// A note classified long ago from its URL alone, which has since gained a
// caption — exactly what this action exists to fix.
const STALE = {
  id: 'a',
  content: 'https://example.com/x',
  url: 'https://example.com/x',
  type: 'link',
  title: 'https://example.com/x',
  tags: ['link'],
  siteDesc: 'a caption that arrived after the note was classified',
  metaFetched: true,
  ai: { classify: true, embed: true },
}

test('a note the backlog would skip is re-classified and re-embedded', async () => {
  await reset([STALE])
  const { backlogCount } = await import('../../../server/ai/backlog.js')
  assert.equal(backlogCount(notes, { llm: 'ondemand', embed: 'always', vision: 'off' }), 0, 'precondition: the backlog offers nothing')

  const queued = await enrich.retagAll()
  await enrich.queueJob(() => {})

  assert.equal(queued, 1)
  assert.equal(classifyCalls.length, 1, 'classify re-ran despite the marker')
  assert.equal(embedCalls.length, 1)
  assert.equal(notes[0].title, 'A Real Title')
  assert.deepEqual(notes[0].tags, ['fresh', 'tags'])
  assert.equal(notes[0].pending, false, 'the enrich pass clears the pending flag it set')
})

test('hand-edited tags survive — the whole difference from the single-note retag', async () => {
  await reset([{ ...STALE, tags: ['my', 'own', 'tags'], ai: { classify: true, embed: true, tagsEdited: true } }])
  await enrich.retagAll()
  await enrich.queueJob(() => {})

  assert.deepEqual(notes[0].tags, ['my', 'own', 'tags'], 'one bulk click must not erase every correction the user made')
  // Everything else still improves.
  assert.equal(notes[0].title, 'A Real Title')
  assert.equal(notes[0].summary, 'A real summary.')
  assert.equal(embedCalls.length, 1)
  assert.equal(notes[0].ai.tagsEdited, true, 'the marker is preserved, so the next retag protects them too')
})

test('the marker is cleared for classify and embed, but vision work is left alone', async () => {
  await reset([{ ...STALE, image: '/uploads/x.png', ai: { classify: true, embed: true, vision: true, thumbVision: true } }])
  await enrich.retagAll()

  // Re-describing every thumbnail is a far longer job with its own backlog
  // entry; this action is about classification.
  assert.equal(notes[0].ai.vision, true)
  assert.equal(notes[0].ai.thumbVision, true)
})

test('every note is marked pending in ONE batched write, not one write each', async () => {
  await reset([STALE, { ...STALE, id: 'b' }, { ...STALE, id: 'c' }])
  const queued = await enrich.retagAll()

  assert.equal(queued, 3)
  assert.deepEqual(persisted, ['a', 'b', 'c'], 'all three deferred')
  assert.equal(flushes, 1, 'one transaction for the whole library')
  assert.ok(notes.every((n) => n.pending === true))
})

test('an unavailable provider queues nothing rather than burning the library against a dead endpoint', async () => {
  await reset([STALE])
  availableImpl = () => false

  assert.equal(await enrich.retagAll(), 0)
  await enrich.queueJob(() => {})
  assert.equal(classifyCalls.length, 0)
  assert.notEqual(notes[0].pending, true, 'nothing was marked pending either')
})

test('an empty library is a no-op', async () => {
  await reset([])
  assert.equal(await enrich.retagAll(), 0)
  assert.equal(flushes, 0)
})
