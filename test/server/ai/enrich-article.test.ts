// Proves the extracted article reaches BOTH consumers: the classify/embed
// input string, and the persisted note. Both are one-line list edits in
// enrich.js that fail silently if dropped, so they get a behavioural test
// rather than relying on the meta.js unit tests alone.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { note } from '../../helpers/notes.ts'
import type { NoteRecord } from '../../../server/data/notes.ts'
import type { LinkMeta } from '../../../server/ai/meta.ts'
import type { Residency } from '../../../server/ai/roles.ts'
import type { ClassifyArgs } from '../../../server/ai/providers/types.ts'

const URL_ = 'https://example.com/bread'
const ARTICLE = 'Autolyse is the resting period after flour and water are first combined.'

let notes: NoteRecord[] = []
let classifyCalls: string[] = []
let embedCalls: string[] = []

const realMeta = await import('../../../server/ai/meta.ts')
const realStore = await import('../../../server/data/notes.ts')
const realTags = await import('../../../server/lib/tags.ts')
const realTagvocab = await import('../../../server/data/tagvocab.ts')
const realNormalise = await import('../../../server/ai/normalise.ts')
const realCollections = await import('../../../server/data/collections.ts')
const realSettings = await import('../../../server/data/settings.ts')

mock.module('../../../server/ai/meta.ts', {
  namedExports: {
    ...realMeta,
    fetchLinkMeta: async (): Promise<LinkMeta> => ({
      siteTitle: 'A Baking Post',
      siteDesc: 'Some thoughts on baking',
      siteName: 'Example',
      thumb: null,
      article: ARTICLE,
    }),
  },
})
mock.module('../../../server/data/notes.ts', {
  namedExports: {
    ...realStore,
    allNotes: () => notes,
    getNote: (id: string) => notes.find(n => n.id === id) ?? null,
    updateNote: async (id: string, patch: Partial<NoteRecord>) => {
      const n = notes.find(x => x.id === id)
      if (n) Object.assign(n, patch) // mirrors real updateNote's shallow merge
      return n
    },
  },
})
mock.module('../../../server/lib/tags.ts', { namedExports: { ...realTags, buildVocabulary: () => [] } })
mock.module('../../../server/data/tagvocab.ts', {
  namedExports: { ...realTagvocab, canonicalize: async (t: string[]) => t },
})
mock.module('../../../server/ai/index.ts', {
  namedExports: {
    ...realNormalise,
    classify: async (args: ClassifyArgs) => {
      classifyCalls.push(args.text)
      return { type: 'link', category: 'General', title: 'T', summary: 'S', tags: [] }
    },
    embedText: async (text: string) => {
      embedCalls.push(text)
      return [0, 0, 0]
    },
  },
})
mock.module('../../../server/data/collections.ts', { namedExports: { ...realCollections, autoAdd: async () => {} } })
mock.module('../../../server/data/settings.ts', {
  namedExports: {
    ...realSettings,
    getResidency: (): Residency => ({ llm: 'ondemand', embed: 'always', vision: 'ondemand' }),
  },
})

const enrich = await import('../../../server/ai/enrich.ts')

test('extracted article reaches classify, embed and the stored note', async () => {
  notes = [{ ...note({ id: 'n1', content: URL_, url: URL_, type: 'link' }), ai: {} }]
  classifyCalls = []
  embedCalls = []

  await enrich.queueEnrich('n1', { absPath: null, text: URL_, isUrl: true, hasImage: false })

  assert.match(classifyCalls[0], /Autolyse is the resting period/, 'article missing from classify input')
  assert.match(embedCalls[0], /Autolyse is the resting period/, 'article missing from embed input')
  const stored = notes.find(n => n.id === 'n1')
  assert.ok(stored)
  assert.equal(stored.article, ARTICLE, 'article was not persisted onto the note')
})
