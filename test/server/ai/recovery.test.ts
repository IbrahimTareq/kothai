// Tests for server/ai/recovery.ts — the re-run queued when the inference
// endpoint's circuit closes again after an outage.
//
// A note enriched while the endpoint was down (out of credits, timing out)
// keeps its heuristic title and no embedding, with its classify/embed markers
// unset and `pending` cleared. Nothing at boot or afterwards looked at it
// again: only the Settings backlog button would, and only if the user noticed
// the count.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { note } from '../../helpers/notes.ts'
import type { NoteRecord } from '../../../server/data/notes.ts'
import type { Residency } from '../../../server/ai/roles.ts'

let notes: NoteRecord[] = []
let classifyCalls = 0
let describeCalls = 0
let writes: string[] = []

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
    updateNote: async (id: string, patch: Partial<NoteRecord>) => {
      const n = notes.find(x => x.id === id)
      if (!n) return null
      writes.push(id)
      Object.assign(n, patch)
      return n
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

// The one seam: the handler recovery.ts registers is captured, and each test
// plays the circuit closing by calling it.
let recover = () => {}
mock.module('../../../server/ai/providers/remote-singleton.ts', {
  namedExports: {
    remoteProvider: {
      onRecover: (fn: () => void) => {
        recover = fn
      },
    },
  },
})

const enrich = await import('../../../server/ai/enrich.ts')
await import('../../../server/ai/recovery.ts')

async function reset(list: NoteRecord[]) {
  await enrich.queueJob(() => {})
  notes = list.map(n => ({ ...n }))
  classifyCalls = 0
  describeCalls = 0
  writes = []
}

// Its enrich pass ran while the endpoint was down: metadata landed, both
// model steps failed, and `pending` was cleared regardless.
const MISSED: NoteRecord = {
  ...note({
    id: 'missed',
    content: 'https://www.tiktok.com/@a/video/1',
    url: 'https://www.tiktok.com/@a/video/1',
    type: 'video',
    title: 'TikTok video',
    siteTitle: 'a caption',
    metaFetched: true,
  }),
  pending: false,
  ai: {},
}

test('a note the outage cost its classify and embed is re-enriched', async () => {
  await reset([MISSED])
  recover()
  await enrich.queueJob(() => {})

  assert.equal(classifyCalls, 1)
  assert.equal(notes[0].title, 'A Real Title')
  assert.equal(notes[0].ai?.embed, true)
})

test('a pending note is left to the pass it is already owed', async () => {
  await reset([{ ...MISSED, pending: true }])
  recover()
  await enrich.queueJob(() => {})
  assert.equal(classifyCalls, 0)
  assert.deepEqual(writes, [])
})

test('a note owed only a thumbnail description is not queued', async () => {
  // One vision pass per note is hours of the single FIFO on a real library —
  // the stall stepsFor's comment refuses to start without being asked.
  await reset([{ ...MISSED, thumb: '/uploads/t.jpg', ai: { classify: true, embed: true } }])
  recover()
  await enrich.queueJob(() => {})
  assert.equal(describeCalls, 0)
  assert.deepEqual(writes, [])
})

test('a second recovery does not queue a note whose first job has not run yet', async () => {
  // A flapping circuit recovers more than once while the first set is still
  // waiting its turn in the FIFO.
  await reset([MISSED])
  recover()
  recover()
  await enrich.queueJob(() => {})
  assert.deepEqual(writes, ['missed'])
})

test('a note the re-run failed again is queued by the next recovery', async () => {
  await reset([MISSED])
  recover()
  await enrich.queueJob(() => {})
  notes[0].ai = {} // the endpoint fell over again before its pass landed
  recover()
  await enrich.queueJob(() => {})
  assert.deepEqual(writes, ['missed', 'missed'])
})
