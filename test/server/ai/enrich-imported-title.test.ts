// An imported bookmark whose link is dead: the export's title is the only
// information left about it. Classify used to see the URL alone and replace
// that title (and invent tags) from it — the same failure enrich.ts records for
// Instagram, where the bare URL gave "platform, view, web".
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { note } from '../../helpers/notes.ts'
import type { NoteRecord } from '../../../server/data/notes.ts'
import type { LinkMeta } from '../../../server/links/meta.ts'
import type { Role } from '../../../server/ai/roles.ts'
import type { ClassifyArgs } from '../../../server/ai/providers/types.ts'
import { deriveBookmarkNote } from '../../../server/import/bookmark.ts'

const DEAD = 'https://gone.example/2016/article'
const LIVE = 'https://example.com/bread'

let notes: NoteRecord[] = []
let classifyCalls: string[] = []
let fetched: LinkMeta | null = null

const realMeta = await import('../../../server/links/meta.ts')
const realStore = await import('../../../server/data/notes.ts')
const realTags = await import('../../../server/data/tags.ts')
const realTagvocab = await import('../../../server/data/tagvocab.ts')
const realNormalise = await import('../../../server/ai/normalise.ts')
const realCollections = await import('../../../server/data/collections.ts')

mock.module('../../../server/links/meta.ts', {
  namedExports: { ...realMeta, fetchLinkMeta: async () => fetched },
})
mock.module('../../../server/data/notes.ts', {
  namedExports: {
    ...realStore,
    allNotes: () => notes,
    getNote: (id: string) => notes.find(n => n.id === id) ?? null,
    updateNote: async (id: string, patch: Partial<NoteRecord>) => {
      const n = notes.find(x => x.id === id)
      if (n) Object.assign(n, patch)
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
    roleEnabled: (role: Role) => ({ llm: true, embed: false, vision: false })[role],
    ...realNormalise,
    classify: async (args: ClassifyArgs) => {
      classifyCalls.push(args.text)
      return { type: 'link', category: 'General', title: 'T', summary: 'S', tags: [] }
    },
    embedText: async () => [0],
  },
})
mock.module('../../../server/data/collections.ts', { namedExports: { ...realCollections, autoAdd: async () => {} } })

const enrich = await import('../../../server/ai/enrich.ts')

test('a dead-link imported bookmark is classified with the title from the export', async () => {
  const derived = deriveBookmarkNote({
    url: DEAD,
    title: 'How sourdough starters work',
    tags: [],
    note: '',
    savedAt: 0,
  })
  notes = [{ ...note({ id: 'b1' }), ...derived, ai: {} } as NoteRecord]
  classifyCalls = []
  fetched = null

  await enrich.queueEnrich('b1', DEAD)

  assert.equal(classifyCalls.length, 1)
  assert.match(classifyCalls[0], /How sourdough starters work/)
})

test('a note saved by hand classifies on the same text as before', async () => {
  notes = [{ ...note({ id: 'h1', content: LIVE, url: LIVE, type: 'link' }), ai: {} }]
  classifyCalls = []
  fetched = { siteTitle: 'A Baking Post', siteDesc: 'Thoughts', siteName: 'Example', thumb: null, article: 'Body.' }

  await enrich.queueEnrich('h1', LIVE)

  assert.deepEqual(classifyCalls, [`${LIVE}\n\nA Baking Post\n\nThoughts\n\nBody.`])
})
