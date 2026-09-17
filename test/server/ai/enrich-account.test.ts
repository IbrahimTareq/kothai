// Proves oEmbed's author_name reaches the note as `account`, and becomes an
// account tag in the same run. Before this it only ever landed inside
// siteDesc as "by X", so every note from a platform whose handle isn't known
// at import time — TikTok most of all, where the handle is in neither the
// export nor the URL it redirects to — had account: null forever.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { note } from '../../helpers/notes.ts'
import type { NoteRecord } from '../../../server/data/notes.ts'
import type { LinkMeta } from '../../../server/ai/meta.ts'
import type { Residency } from '../../../server/ai/roles.ts'
import type { ClassifyArgs } from '../../../server/ai/providers/types.ts'

const URL_ = 'https://www.tiktok.com/video/7325881953608158497'
const AUTHOR = 'The Muslim Journal Company'

let notes: NoteRecord[] = []
let classifyCalls: ClassifyArgs[] = []
let linkMeta: LinkMeta

const realMeta = await import('../../../server/ai/meta.ts')
const realStore = await import('../../../server/data/notes.ts')
const realTags = await import('../../../server/lib/tags.ts')
const realTagvocab = await import('../../../server/data/tagvocab.ts')
const realNormalise = await import('../../../server/ai/normalise.ts')
const realCollections = await import('../../../server/data/collections.ts')
const realSettings = await import('../../../server/data/settings.ts')

mock.module('../../../server/ai/meta.ts', {
  namedExports: { ...realMeta, fetchLinkMeta: async () => linkMeta },
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
      classifyCalls.push(args)
      return { type: 'video', category: 'General', title: 'T', summary: 'S', tags: [] }
    },
    embedText: async () => [0, 0, 0],
  },
})
mock.module('../../../server/data/collections.ts', { namedExports: { ...realCollections, autoAdd: async () => {} } })
mock.module('../../../server/data/settings.ts', {
  namedExports: {
    ...realSettings,
    getResidency: (): Residency => ({ llm: 'ondemand', embed: 'always', vision: 'off' }),
  },
})

const enrich = await import('../../../server/ai/enrich.ts')
const tags = await import('../../../server/lib/tags.ts')

function meta(over: Partial<LinkMeta> = {}): LinkMeta {
  return {
    siteTitle: 'A video',
    siteDesc: `by ${AUTHOR}`,
    siteName: 'TikTok',
    thumb: null,
    article: null,
    author: AUTHOR,
    ...over,
  }
}

// The note every test here starts from: a TikTok saved as a URL with no
// handle yet. Spelled once because `account` is the only field any of them
// varies, and a literal per test would bury that behind nine defaults.
function seed(account: string | null): NoteRecord[] {
  return [{ ...note({ id: 'n1', content: URL_, url: URL_, type: 'video', account }), ai: {} }]
}

test('an oEmbed author becomes the note account when it has none', async () => {
  notes = seed(null)
  classifyCalls = []
  linkMeta = meta()

  await enrich.queueEnrich('n1', { absPath: null, text: URL_, isUrl: true, hasImage: false })

  const stored = notes.find(n => n.id === 'n1')
  assert.ok(stored)
  assert.equal(stored.account, AUTHOR)
})

test('the account tag lands in the SAME run, not a later sweep', async () => {
  notes = seed(null)
  linkMeta = meta()

  await enrich.queueEnrich('n1', { absPath: null, text: URL_, isUrl: true, hasImage: false })

  // Whatever shape withAccountTag gives an account tag, the note must carry it
  // — reading `existing.account` alone would leave tags empty here, and a
  // second pass never comes because classify is already marked done.
  const stored = notes.find(n => n.id === 'n1')
  assert.ok(stored)
  assert.deepEqual(stored.tags, tags.withAccountTag([], AUTHOR))
  assert.ok(stored.tags.length > 0, 'an account tag was actually produced')
})

test('an account the note already has is never overwritten by a provider display name', async () => {
  // Instagram reads the handle straight from the export, and a user can edit
  // one by hand. Both outrank oEmbed's display name.
  notes = seed('natgeo')
  linkMeta = meta()

  await enrich.queueEnrich('n1', { absPath: null, text: URL_, isUrl: true, hasImage: false })

  const stored = notes.find(n => n.id === 'n1')
  assert.ok(stored)
  assert.equal(stored.account, 'natgeo')
})

test('no author from the provider leaves account alone rather than writing null over it', async () => {
  notes = seed(null)
  linkMeta = meta({ author: null })

  await enrich.queueEnrich('n1', { absPath: null, text: URL_, isUrl: true, hasImage: false })

  const stored = notes.find(n => n.id === 'n1')
  assert.ok(stored)
  assert.equal(stored.account, null)
})
