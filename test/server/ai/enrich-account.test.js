// Proves oEmbed's author_name reaches the note as `account`, and becomes an
// account tag in the same run. Before this it only ever landed inside
// siteDesc as "by X", so every note from a platform whose handle isn't known
// at import time — TikTok most of all, where the handle is in neither the
// export nor the URL it redirects to — had account: null forever.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

const URL_ = 'https://www.tiktok.com/video/7325881953608158497'
const AUTHOR = 'The Muslim Journal Company'

let notes = []
let classifyCalls = []
let linkMeta

const realMeta = await import('../../../server/ai/meta.js')
const realStore = await import('../../../server/data/notes.js')
const realTags = await import('../../../server/lib/tags.js')
const realTagvocab = await import('../../../server/data/tagvocab.js')
const realNormalise = await import('../../../server/ai/normalise.js')
const realCollections = await import('../../../server/data/collections.js')
const realSettings = await import('../../../server/data/settings.js')

mock.module('../../../server/ai/meta.js', {
  namedExports: { ...realMeta, fetchLinkMeta: async () => linkMeta },
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
      classifyCalls.push(args)
      return { type: 'video', category: 'General', title: 'T', summary: 'S', tags: [] }
    },
    embedText: async () => [0, 0, 0],
  },
})
mock.module('../../../server/data/collections.js', { namedExports: { ...realCollections, autoAdd: async () => {} } })
mock.module('../../../server/data/settings.js', {
  namedExports: { ...realSettings, getResidency: () => ({ llm: 'ondemand', embed: 'always', vision: 'off' }) },
})

const enrich = await import('../../../server/ai/enrich.js')
const tags = await import('../../../server/lib/tags.js')

function meta(over = {}) {
  return { siteTitle: 'A video', siteDesc: `by ${AUTHOR}`, siteName: 'TikTok', thumb: null, article: null, author: AUTHOR, ...over }
}

test('an oEmbed author becomes the note account when it has none', async () => {
  notes = [{ id: 'n1', content: URL_, url: URL_, type: 'video', account: null, tags: [], ai: {} }]
  classifyCalls = []
  linkMeta = meta()

  await enrich.queueEnrich('n1', { absPath: null, text: URL_, isUrl: true, hasImage: false })

  assert.equal(notes.find((n) => n.id === 'n1').account, AUTHOR)
})

test('the account tag lands in the SAME run, not a later sweep', async () => {
  notes = [{ id: 'n1', content: URL_, url: URL_, type: 'video', account: null, tags: [], ai: {} }]
  linkMeta = meta()

  await enrich.queueEnrich('n1', { absPath: null, text: URL_, isUrl: true, hasImage: false })

  // Whatever shape withAccountTag gives an account tag, the note must carry it
  // — reading `existing.account` alone would leave tags empty here, and a
  // second pass never comes because classify is already marked done.
  const stored = notes.find((n) => n.id === 'n1')
  assert.deepEqual(stored.tags, tags.withAccountTag([], AUTHOR))
  assert.ok(stored.tags.length > 0, 'an account tag was actually produced')
})

test('an account the note already has is never overwritten by a provider display name', async () => {
  // Instagram reads the handle straight from the export, and a user can edit
  // one by hand. Both outrank oEmbed's display name.
  notes = [{ id: 'n1', content: URL_, url: URL_, type: 'video', account: 'natgeo', tags: [], ai: {} }]
  linkMeta = meta()

  await enrich.queueEnrich('n1', { absPath: null, text: URL_, isUrl: true, hasImage: false })

  assert.equal(notes.find((n) => n.id === 'n1').account, 'natgeo')
})

test('no author from the provider leaves account alone rather than writing null over it', async () => {
  notes = [{ id: 'n1', content: URL_, url: URL_, type: 'video', account: null, tags: [], ai: {} }]
  linkMeta = meta({ author: null })

  await enrich.queueEnrich('n1', { absPath: null, text: URL_, isUrl: true, hasImage: false })

  assert.equal(notes.find((n) => n.id === 'n1').account, null)
})
