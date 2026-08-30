// Tests for server/ai/enrich.js's account-tag injection (both classify call
// sites) and the new retagNote() forced-reclassify path. Uses the same
// mock.module harness as enrich-instagram-chain.test.js so this runs with
// zero network I/O and zero real model calls.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

const IG_URL = 'https://www.instagram.com/p/AAA111/'

let notes
function seedNotes(list) { notes = list.map((n) => ({ ...n })) }
function fakeAllNotes() { return notes }
async function fakeUpdateNote(id, patch) {
  const n = notes.find((x) => x.id === id)
  if (!n) return null
  Object.assign(n, patch)
  return n
}

let classifyImpl
let embedTextImpl
let fetchLinkMetaImpl
let residencyImpl
let classifyCalls
let autoAddCalls

function reset() {
  seedNotes([])
  classifyCalls = []
  autoAddCalls = []
  classifyImpl = async () => ({ type: 'link', category: 'General', title: 'T', summary: 'S', tags: ['topic'] })
  embedTextImpl = async () => [0, 0, 0]
  fetchLinkMetaImpl = async () => ({ siteTitle: null, siteDesc: null, siteName: null, thumb: null })
  residencyImpl = () => ({ llm: 'ondemand', embed: 'always', vision: 'ondemand' })
}
reset()

const realMeta = await import('../../../server/ai/meta.js')
const realStore = await import('../../../server/data/notes.js')
const realTags = await import('../../../server/lib/tags.js')
const realTagvocab = await import('../../../server/data/tagvocab.js')
const realNormalise = await import('../../../server/ai/normalise.js')
const realCollections = await import('../../../server/data/collections.js')
const realSettings = await import('../../../server/data/settings.js')

mock.module('../../../server/ai/meta.js', {
  namedExports: { ...realMeta, fetchLinkMeta: async (url, id) => fetchLinkMetaImpl(url, id) },
})
mock.module('../../../server/data/notes.js', {
  namedExports: { ...realStore, allNotes: () => fakeAllNotes(), updateNote: (id, patch) => fakeUpdateNote(id, patch) },
})
mock.module('../../../server/lib/tags.js', { namedExports: { ...realTags, buildVocabulary: () => [] } })
mock.module('../../../server/data/tagvocab.js', { namedExports: { ...realTagvocab, canonicalize: async (tags) => tags } })
mock.module('../../../server/ai/index.js', {
  namedExports: {
    ...realNormalise,
    classify: (args) => { classifyCalls.push(args); return classifyImpl(args) },
    embedText: (text) => embedTextImpl(text),
  },
})
mock.module('../../../server/data/collections.js', {
  namedExports: { ...realCollections, autoAdd: async (id, tags) => { autoAddCalls.push({ id, tags }) } },
})
mock.module('../../../server/data/settings.js', { namedExports: { ...realSettings, getResidency: () => residencyImpl() } })

const enrich = await import('../../../server/ai/enrich.js')

// queueIgMeta is fire-and-forget (it pushes onto its own deque rather than
// returning a promise a caller can await), so a test that needs the fetch +
// reclassify to have actually landed must poll instead — same helper as
// test/enrich-instagram-chain.test.js, for the same reason (see that file's
// comment above its own copy of this function).
async function drainIgQueue(timeoutMs = 2000) {
  const start = Date.now()
  while (enrich._igQueueState.ids().length > 0 || enrich._igQueueState.pumping()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`drainIgQueue timed out after ${timeoutMs}ms — queue stuck?`)
    }
    await new Promise((r) => setTimeout(r, 1))
  }
}

test('enrichNote: a note with an account gets "@handle" prepended to its classified tags', async () => {
  reset()
  seedNotes([{ id: 'n1', content: 'hello world', account: 'ChefSteps', ai: {} }])
  await enrich.queueEnrich('n1', { absPath: null, text: 'hello world', isUrl: false, hasImage: false })
  const note = notes.find((n) => n.id === 'n1')
  assert.deepEqual(note.tags, ['@chefsteps', 'topic'])
})

test('enrichNote: a note with no account is classified normally, no stray tag', async () => {
  reset()
  seedNotes([{ id: 'n2', content: 'hello world', account: null, ai: {} }])
  await enrich.queueEnrich('n2', { absPath: null, text: 'hello world', isUrl: false, hasImage: false })
  const note = notes.find((n) => n.id === 'n2')
  assert.deepEqual(note.tags, ['topic'])
})

test('reclassifyWithCaption (the Instagram caption path): also gets the account tag', async () => {
  reset()
  const id = 'n3'
  seedNotes([{ id, content: IG_URL, url: IG_URL, type: 'link', account: 'natgeo', ai: {} }])
  fetchLinkMetaImpl = async () => ({ siteTitle: 'Title', siteDesc: 'Title\ncaption body', siteName: 'Instagram', thumb: null })
  enrich.queueIgMeta(id, IG_URL)
  await drainIgQueue()
  await enrich.queueJob(() => {})
  const note = notes.find((n) => n.id === id)
  assert.deepEqual(note.tags, ['@natgeo', 'topic'])
})

test('retagNote: forces a fresh classify even on an already-classified, hand-edited note — old tags are discarded', async () => {
  reset()
  const id = 'n4'
  seedNotes([{
    id, content: 'hello world', account: 'natgeo',
    tags: ['user-picked-this-tag'],
    ai: { classify: true, embed: true, tagsEdited: true },
  }])
  classifyImpl = async () => ({ type: 'text', category: 'General', title: 'Fresh', summary: 'S', tags: ['fresh-topic'] })
  const returned = await enrich.retagNote(id)
  assert.equal(returned.pending, true, 'the immediate response is optimistic — pending until the queued job lands')
  await enrich.queueJob(() => {}) // drain the job retagNote queued
  const note = notes.find((n) => n.id === id)
  assert.deepEqual(note.tags, ['@natgeo', 'fresh-topic'], 'old hand-edited tag is gone, account tag re-applied')
  assert.equal(note.ai.tagsEdited, false, 'the tagsEdited guard is cleared — this is an explicit user-triggered replace')
  assert.equal(note.pending, false, 'pending is flipped back once the queued job actually completes')
  assert.equal(autoAddCalls.length, 1)
  assert.deepEqual(autoAddCalls[0], { id, tags: ['@natgeo', 'fresh-topic'] })
})

test('retagNote: unknown id returns null and queues nothing', async () => {
  reset()
  const before = classifyCalls.length
  const result = await enrich.retagNote('does-not-exist')
  assert.equal(result, null)
  await enrich.queueJob(() => {})
  assert.equal(classifyCalls.length, before)
})
