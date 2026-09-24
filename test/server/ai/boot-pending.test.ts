// Tests for the boot sweep (enrich.queueMetaBackfill) on notes a restart left `pending`.
//
// `pending` is on disk; the enrichNote job that clears it lives only in the
// in-memory FIFO. A restart during a bulk import dropped every job still
// queued, and nothing at boot looked at `pending` again — on a real install
// 1,596 of 1,885 notes stayed flagged for a month.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { note } from '../../helpers/notes.ts'
import type { NoteRecord } from '../../../server/data/notes.ts'
import type { Residency } from '../../../server/ai/roles.ts'

let notes: NoteRecord[] = []
let classifyCalls = 0
let describeCalls = 0
let deferred: string[] = [] // ids written with { persist: false }
let flushes = 0

const realStore = await import('../../../server/data/notes.ts')
const realTags = await import('../../../server/data/tags.ts')
const realTagvocab = await import('../../../server/data/tagvocab.ts')
const realNormalise = await import('../../../server/ai/normalise.ts')
const realCollections = await import('../../../server/data/collections.ts')
const realSettings = await import('../../../server/data/settings.ts')

mock.module('../../../server/data/notes.ts', {
  namedExports: {
    ...realStore,
    allNotes: () => notes,
    getNote: (id: string) => notes.find(n => n.id === id) ?? null,
    updateNote: async (id: string, patch: Partial<NoteRecord>, opts?: { persist?: boolean }) => {
      const n = notes.find(x => x.id === id)
      if (!n) return null
      if (opts?.persist === false) deferred.push(id)
      Object.assign(n, patch)
      return n
    },
    flush: async () => {
      flushes++
    },
  },
})
mock.module('../../../server/data/tags.ts', { namedExports: { ...realTags, buildVocabulary: () => [] } })
mock.module('../../../server/data/tagvocab.ts', {
  namedExports: { ...realTagvocab, canonicalize: async (t: string[]) => t },
})
mock.module('../../../server/ai/index.ts', {
  namedExports: {
    ...realNormalise,
    classify: async () => {
      classifyCalls++
      return { type: 'video', category: 'Real', title: 'A Real Title', summary: 'A summary.', tags: ['fresh'] }
    },
    embedText: async () => [1, 2, 3],
    describeImage: async () => {
      describeCalls++
      return 'a description'
    },
  },
})
mock.module('../../../server/data/collections.ts', { namedExports: { ...realCollections, autoAdd: async () => {} } })
mock.module('../../../server/data/settings.ts', {
  namedExports: {
    ...realSettings,
    getResidency: (): Residency => ({ llm: 'always', embed: 'always', vision: 'always' }),
  },
})

const enrich = await import('../../../server/ai/enrich.ts')

async function reset(list: NoteRecord[]) {
  await enrich.queueJob(() => {})
  notes = list.map(n => ({ ...n }))
  classifyCalls = 0
  describeCalls = 0
  deferred = []
  flushes = 0
}

// The shape 1,259 of the stuck notes had: reclassifyWithCaption, fired when
// its caption landed after the restart, gave it a title, tags and an
// embedding, but the import's enrichNote pass never ran. No siteTitle, like
// nearly every Instagram post — the case queueMetaBackfill's loop skips.
const RECLASSIFIED: NoteRecord = {
  ...note({
    id: 'ig',
    content: 'https://www.instagram.com/reel/abc/',
    url: 'https://www.instagram.com/reel/abc/',
    type: 'video',
    title: 'A Real Title',
    siteDesc: 'a caption',
    thumb: '/uploads/meta-ig.jpg',
    metaFetched: true,
  }),
  pending: true,
  ai: { thumbVision: true, classify: true, embed: true, igReclassified: true },
}

// The shape of the other 323: imported, never touched by a model at all.
const UNTOUCHED: NoteRecord = {
  ...note({
    id: 'tt',
    content: 'https://www.tiktok.com/@a/video/1',
    url: 'https://www.tiktok.com/@a/video/1',
    type: 'video',
    title: 'TikTok video',
    siteTitle: 'a caption',
    metaFetched: true,
  }),
  pending: true,
  ai: {},
}

test('a pending note whose model work is done is cleared at boot, without a vision pass', async () => {
  await reset([RECLASSIFIED])
  enrich.queueMetaBackfill()
  await enrich.queueJob(() => {})

  assert.equal(notes[0].pending, false)
  assert.equal(classifyCalls, 0)
  // Its missing thumbnail description is backlog work: one vision pass per
  // note at boot would hold the single FIFO for hours.
  assert.equal(describeCalls, 0)
  assert.deepEqual(deferred, ['ig'], 'the clear is batched')
  assert.equal(flushes, 1, 'and the batch reaches disk')
})

test('a pending note still owed classify gets its enrich pass re-queued at boot', async () => {
  await reset([UNTOUCHED])
  enrich.queueMetaBackfill()
  await enrich.queueJob(() => {})

  assert.equal(classifyCalls, 1)
  assert.equal(notes[0].title, 'A Real Title')
  assert.equal(notes[0].pending, false)
})

test('a note that is not pending is left alone', async () => {
  await reset([{ ...UNTOUCHED, pending: false }])
  enrich.queueMetaBackfill()
  await enrich.queueJob(() => {})

  assert.equal(classifyCalls, 0, 'finished notes missing a step are the backlog button’s job, not boot’s')
  assert.deepEqual(deferred, [])
})
