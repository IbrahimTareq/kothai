// Tests for server/ai/enrich.ts's account-tag injection (both classify call
// sites) and the new retagNote() forced-reclassify path. Uses the same
// mock.module harness as enrich-instagram-chain.test.ts so this runs with
// zero network I/O and zero real model calls.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { note } from '../../helpers/notes.ts'
import type { NoteRecord } from '../../../server/data/notes.ts'
import type { LinkMeta } from '../../../server/links/meta.ts'
import type { Residency } from '../../../server/ai/roles.ts'
import type { Classification, ClassifyArgs } from '../../../server/ai/providers/types.ts'

const IG_URL = 'https://www.instagram.com/p/AAA111/'

let notes: NoteRecord[]
function seedNotes(list: NoteRecord[]) {
  notes = list.map(n => ({ ...n }))
}
function fakeAllNotes() {
  return notes
}
async function fakeUpdateNote(id: string, patch: Partial<NoteRecord>) {
  const n = notes.find(x => x.id === id)
  if (!n) return null
  Object.assign(n, patch)
  return n
}

let classifyImpl: (args: ClassifyArgs) => Promise<Classification>
let embedTextImpl: (text: string) => Promise<number[]>
let fetchLinkMetaImpl: (url: string, id: string) => Promise<LinkMeta>
let residencyImpl: () => Residency
let classifyCalls: ClassifyArgs[]
let autoAddCalls: { id: string; tags: string[] | null | undefined }[]

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

const realMeta = await import('../../../server/links/meta.ts')
const realStore = await import('../../../server/data/notes.ts')
const realTags = await import('../../../server/data/tags.ts')
const realTagvocab = await import('../../../server/data/tagvocab.ts')
const realNormalise = await import('../../../server/ai/normalise.ts')
const realCollections = await import('../../../server/data/collections.ts')
const realSettings = await import('../../../server/data/settings.ts')

mock.module('../../../server/links/meta.ts', {
  namedExports: { ...realMeta, fetchLinkMeta: async (url: string, id: string) => fetchLinkMetaImpl(url, id) },
})
mock.module('../../../server/data/notes.ts', {
  namedExports: {
    ...realStore,
    allNotes: () => fakeAllNotes(),
    getNote: (id: string) => fakeAllNotes().find(n => n.id === id) ?? null,
    updateNote: (id: string, patch: Partial<NoteRecord>) => fakeUpdateNote(id, patch),
  },
})
mock.module('../../../server/data/tags.ts', { namedExports: { ...realTags, buildVocabulary: () => [] } })
mock.module('../../../server/data/tagvocab.ts', {
  namedExports: { ...realTagvocab, canonicalize: async (tags: string[]) => tags },
})
mock.module('../../../server/ai/index.ts', {
  namedExports: {
    ...realNormalise,
    classify: (args: ClassifyArgs) => {
      classifyCalls.push(args)
      return classifyImpl(args)
    },
    embedText: (text: string) => embedTextImpl(text),
  },
})
mock.module('../../../server/data/collections.ts', {
  namedExports: {
    ...realCollections,
    autoAdd: async (id: string, tags: string[] | null | undefined) => {
      autoAddCalls.push({ id, tags })
    },
  },
})
mock.module('../../../server/data/settings.ts', {
  namedExports: { ...realSettings, getResidency: () => residencyImpl() },
})

const enrich = await import('../../../server/ai/enrich.ts')

// queueIgMeta is fire-and-forget (it pushes onto its own deque rather than
// returning a promise a caller can await), so a test that needs the fetch +
// reclassify to have actually landed must poll instead — same helper as
// test/enrich-instagram-chain.test.ts, for the same reason (see that file's
// comment above its own copy of this function).
async function drainIgQueue(timeoutMs = 2000) {
  const start = Date.now()
  while (enrich._igQueueState.ids().length > 0 || enrich._igQueueState.pumping()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`drainIgQueue timed out after ${timeoutMs}ms — queue stuck?`)
    }
    await new Promise(r => setTimeout(r, 1))
  }
}

test('enrichNote: a note with an account gets "@handle" prepended to its classified tags', async () => {
  reset()
  seedNotes([{ ...note({ id: 'n1', content: 'https://example.com/a', account: 'ChefSteps' }), ai: {} }])
  await enrich.queueEnrich('n1', 'https://example.com/a')
  const stored = notes.find(n => n.id === 'n1')
  assert.ok(stored)
  assert.deepEqual(stored.tags, ['@chefsteps', 'topic'])
})

test('enrichNote: a note with no account is classified normally, no stray tag', async () => {
  reset()
  seedNotes([{ ...note({ id: 'n2', content: 'https://example.com/a', account: null }), ai: {} }])
  await enrich.queueEnrich('n2', 'https://example.com/a')
  const stored = notes.find(n => n.id === 'n2')
  assert.ok(stored)
  assert.deepEqual(stored.tags, ['topic'])
})

test('reclassifyWithCaption (the Instagram caption path): also gets the account tag', async () => {
  reset()
  const id = 'n3'
  seedNotes([{ ...note({ id, content: IG_URL, url: IG_URL, type: 'link', account: 'natgeo' }), ai: {} }])
  fetchLinkMetaImpl = async () => ({
    siteTitle: 'Title',
    siteDesc: 'Title\ncaption body',
    siteName: 'Instagram',
    thumb: null,
  })
  enrich.queueIgMeta(id, IG_URL)
  await drainIgQueue()
  await enrich.queueJob(() => {})
  const stored = notes.find(n => n.id === id)
  assert.ok(stored)
  assert.deepEqual(stored.tags, ['@natgeo', 'topic'])
})

test('retagNote: forces a fresh classify even on an already-classified, hand-edited note — old tags are discarded', async () => {
  reset()
  const id = 'n4'
  seedNotes([
    {
      ...note({ id, content: 'https://example.com/a', account: 'natgeo', tags: ['user-picked-this-tag'] }),
      ai: { classify: true, embed: true, tagsEdited: true },
    },
  ])
  classifyImpl = async () => ({
    type: 'link',
    category: 'General',
    title: 'Fresh',
    summary: 'S',
    tags: ['fresh-topic'],
  })
  const returned = await enrich.retagNote(id)
  assert.ok(returned, 'retagNote found the note it was asked about')
  assert.equal(returned.pending, true, 'the immediate response is optimistic — pending until the queued job lands')
  await enrich.queueJob(() => {}) // drain the job retagNote queued
  const stored = notes.find(n => n.id === id)
  assert.ok(stored)
  assert.deepEqual(stored.tags, ['@natgeo', 'fresh-topic'], 'old hand-edited tag is gone, account tag re-applied')
  assert.ok(stored.ai)
  assert.equal(
    stored.ai.tagsEdited,
    false,
    'the tagsEdited guard is cleared — this is an explicit user-triggered replace',
  )
  assert.equal(stored.pending, false, 'pending is flipped back once the queued job actually completes')
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
