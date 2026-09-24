// Tests for server/routes/export.ts — GET /api/export bundles notes, spaces,
// chats, and settings into one downloadable JSON file. Read-only, so unlike
// import-route.test.ts there's no rollback/mutation path to exercise; the
// data stores are mocked purely to control what handleExport sees.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mockRes } from '../../helpers/http.ts'
import { note } from '../../helpers/notes.ts'

// One fixture behind both the mocked store and the assertion, so the test says
// what it means: a note goes into the bundle exactly as the store handed it
// over. handleExport copies allNotes() through verbatim — it strips nothing —
// and pinning the whole note rather than three of its fields is what would
// catch a future filter added there.
const N1 = note({ id: 'n1', title: 'Note one', embedding: null })

const realStore = await import('../../../server/data/notes.ts')
const realCollections = await import('../../../server/data/collections.ts')
const realChats = await import('../../../server/data/chats.ts')
const realSettings = await import('../../../server/data/settings.ts')

mock.module('../../../server/data/notes.ts', {
  namedExports: {
    ...realStore,
    allNotes: () => [N1],
    getNote: (id: string) => (id === 'n1' ? N1 : null),
  },
})
mock.module('../../../server/data/collections.ts', {
  namedExports: {
    ...realCollections,
    all: () => [{ id: 's1', name: 'Space one', itemIds: ['n1'] }],
  },
})
mock.module('../../../server/data/chats.ts', {
  namedExports: {
    ...realChats,
    all: () => [{ id: 'c1', title: 'Chat one', messages: [{ role: 'user', text: 'hi' }] }],
  },
})
mock.module('../../../server/data/settings.ts', {
  namedExports: {
    ...realSettings,
    get: () => ({ llm: 'model-a' }),
    getResidency: () => ({ llm: 'always' }),
  },
})

const { handleExport } = await import('../../../server/routes/export.ts')

test('handleExport bundles notes, spaces, chats, and settings with a download header', () => {
  const { res, sent } = mockRes()
  handleExport(res)

  assert.equal(sent.code, 200)
  assert.match(sent.headers['content-disposition'], /^attachment; filename="kothai-export-\d{4}-\d{2}-\d{2}\.json"$/)
  assert.equal(sent.headers['content-type'], 'application/json; charset=utf-8')

  const bundle = sent.json()
  assert.equal(bundle.version, 1)
  assert.equal(typeof bundle.exportedAt, 'string')
  assert.deepEqual(bundle.notes, [N1])
  assert.deepEqual(bundle.collections, [{ id: 's1', name: 'Space one', itemIds: ['n1'] }])
  assert.deepEqual(bundle.chats, [{ id: 'c1', title: 'Chat one', messages: [{ role: 'user', text: 'hi' }] }])
  assert.deepEqual(bundle.settings, { current: { llm: 'model-a' }, residency: { llm: 'always' } })
})
