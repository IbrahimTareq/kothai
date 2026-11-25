// The boot backfill (enrich.queueMetaBackfill) on an imported bookmark a
// restart caught before its enrichNote pass ran.
//
// deriveBookmarkNote seeds siteTitle from the export so classify sees it on a
// dead link. The backfill gated on `!n.siteTitle`, so it skipped every such
// note; with both model roles off the pending loop only cleared the flag, and
// the bookmark never got a thumbnail or its link metadata.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { note } from '../../helpers/notes.ts'
import type { NoteRecord } from '../../../server/data/notes.ts'
import type { Role } from '../../../server/ai/roles.ts'
import { deriveBookmarkNote } from '../../../server/import/bookmark.ts'

const LINK = 'https://example.com/bread'
const IG = 'https://www.instagram.com/p/abc/'

let notes: NoteRecord[] = []
let fetchCalls: string[] = []

const realMeta = await import('../../../server/links/meta.ts')
const realStore = await import('../../../server/data/notes.ts')
const realNormalise = await import('../../../server/ai/normalise.ts')

mock.module('../../../server/links/meta.ts', {
  namedExports: {
    ...realMeta,
    fetchLinkMeta: async (url: string) => {
      fetchCalls.push(url)
      return {
        siteTitle: 'Fetched',
        siteDesc: 'a description',
        siteName: null,
        thumb: null,
        article: null,
        author: null,
      }
    },
  },
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
    flush: async () => {},
  },
})
mock.module('../../../server/ai/index.ts', {
  namedExports: { roleEnabled: (_role: Role) => false, ...realNormalise },
})

const enrich = await import('../../../server/ai/enrich.ts')

function imported(id: string, url: string): NoteRecord {
  const derived = deriveBookmarkNote({ url, title: 'How sourdough starters work', tags: [], note: '', savedAt: 0 })
  return { ...note({ id }), ...derived, ai: {} } as NoteRecord
}

test('a pending imported bookmark still gets its link metadata at boot with every model role off', async () => {
  notes = [imported('b1', LINK)]
  fetchCalls = []

  enrich.queueMetaBackfill()
  await enrich.queueJob(() => {})

  assert.deepEqual(fetchCalls, [LINK])
  assert.equal(notes[0].metaFetched, true)
  assert.equal(notes[0].siteDesc, 'a description')
  assert.equal(notes[0].pending, false)
})

test('an Instagram post inside a bookmark export is queued for its fetch at boot', async () => {
  notes = [imported('b2', IG)]
  enrich._igQueueState.pause()
  try {
    enrich.queueMetaBackfill()
    assert.deepEqual(enrich._igQueueState.ids(), ['b2'])
  } finally {
    enrich._igQueueState.clear()
  }
})

test('an Instagram bookmark stuck by the old failure policy is recognised despite its seeded title', () => {
  assert.equal(enrich.isStuckInstagramNote({ ...imported('b3', IG), metaFetched: true }), true)
})
