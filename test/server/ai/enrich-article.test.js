// Proves the extracted article reaches BOTH consumers: the classify/embed
// input string, and the persisted note. Both are one-line list edits in
// enrich.js that fail silently if dropped, so they get a behavioural test
// rather than relying on the meta.js unit tests alone.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

const URL_ = 'https://example.com/bread'
const ARTICLE = 'Autolyse is the resting period after flour and water are first combined.'

let notes = []
let classifyCalls = []
let embedCalls = []

const realMeta = await import('../../../server/ai/meta.js')
const realStore = await import('../../../server/data/notes.js')
const realTags = await import('../../../server/lib/tags.js')
const realTagvocab = await import('../../../server/data/tagvocab.js')
const realNormalise = await import('../../../server/ai/normalise.js')
const realCollections = await import('../../../server/data/collections.js')
const realSettings = await import('../../../server/data/settings.js')

mock.module('../../../server/ai/meta.js', {
  namedExports: {
    ...realMeta,
    fetchLinkMeta: async () => ({
      siteTitle: 'A Baking Post', siteDesc: 'Some thoughts on baking',
      siteName: 'Example', thumb: null, article: ARTICLE,
    }),
  },
})
mock.module('../../../server/data/notes.js', {
  namedExports: {
    ...realStore,
    allNotes: () => notes,
    updateNote: async (id, patch) => {
      const n = notes.find((x) => x.id === id)
      if (n) Object.assign(n, patch) // mirrors real updateNote's shallow merge
      return n
    },
  },
})
mock.module('../../../server/lib/tags.js', { namedExports: { ...realTags, buildVocabulary: () => [] } })
mock.module('../../../server/data/tagvocab.js', { namedExports: { ...realTagvocab, canonicalize: async (t) => t } })
mock.module('../../../server/ai/index.js', {
  namedExports: {
    ...realNormalise,
    classify: async (args) => {
      classifyCalls.push(args.text)
      return { type: 'link', category: 'General', title: 'T', summary: 'S', tags: [] }
    },
    embedText: async (text) => { embedCalls.push(text); return [0, 0, 0] },
  },
})
mock.module('../../../server/data/collections.js', { namedExports: { ...realCollections, autoAdd: async () => {} } })
mock.module('../../../server/data/settings.js', {
  namedExports: { ...realSettings, getResidency: () => ({ llm: 'ondemand', embed: 'always', vision: 'ondemand' }) },
})

const enrich = await import('../../../server/ai/enrich.js')

test('extracted article reaches classify, embed and the stored note', async () => {
  notes = [{ id: 'n1', content: URL_, url: URL_, type: 'link', ai: {} }]
  classifyCalls = []
  embedCalls = []

  await enrich.queueEnrich('n1', { absPath: null, text: URL_, isUrl: true, hasImage: false })

  assert.match(classifyCalls[0], /Autolyse is the resting period/, 'article missing from classify input')
  assert.match(embedCalls[0], /Autolyse is the resting period/, 'article missing from embed input')
  assert.equal(notes.find((n) => n.id === 'n1').article, ARTICLE, 'article was not persisted onto the note')
})
