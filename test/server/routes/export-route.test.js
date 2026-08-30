// Tests for server/routes/export.js — GET /api/export bundles notes, spaces,
// chats, and settings into one downloadable JSON file. Read-only, so unlike
// import-route.test.js there's no rollback/mutation path to exercise; the
// data stores are mocked purely to control what handleExport sees.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

const realStore = await import('../../../server/data/notes.js')
const realCollections = await import('../../../server/data/collections.js')
const realChats = await import('../../../server/data/chats.js')
const realSettings = await import('../../../server/data/settings.js')

mock.module('../../../server/data/notes.js', {
  namedExports: {
    ...realStore,
    allNotes: () => [{ id: 'n1', title: 'Note one', embedding: null }],
  },
})
mock.module('../../../server/data/collections.js', {
  namedExports: {
    ...realCollections,
    all: () => [{ id: 's1', name: 'Space one', itemIds: ['n1'] }],
  },
})
mock.module('../../../server/data/chats.js', {
  namedExports: {
    ...realChats,
    all: () => [{ id: 'c1', title: 'Chat one', messages: [{ role: 'user', text: 'hi' }] }],
  },
})
mock.module('../../../server/data/settings.js', {
  namedExports: {
    ...realSettings,
    get: () => ({ llm: 'model-a' }),
    getResidency: () => ({ llm: 'always' }),
  },
})

const { handleExport } = await import('../../../server/routes/export.js')

function fakeRes() {
  return {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers },
    end(str) { this.body = str },
  }
}

test('handleExport bundles notes, spaces, chats, and settings with a download header', () => {
  const res = fakeRes()
  handleExport(res)

  assert.equal(res.statusCode, 200)
  assert.match(res.headers['Content-Disposition'], /^attachment; filename="kothai-export-\d{4}-\d{2}-\d{2}\.json"$/)
  assert.equal(res.headers['Content-Type'], 'application/json; charset=utf-8')

  const bundle = JSON.parse(res.body)
  assert.equal(bundle.version, 1)
  assert.equal(typeof bundle.exportedAt, 'string')
  assert.deepEqual(bundle.notes, [{ id: 'n1', title: 'Note one', embedding: null }])
  assert.deepEqual(bundle.collections, [{ id: 's1', name: 'Space one', itemIds: ['n1'] }])
  assert.deepEqual(bundle.chats, [{ id: 'c1', title: 'Chat one', messages: [{ role: 'user', text: 'hi' }] }])
  assert.deepEqual(bundle.settings, { current: { llm: 'model-a' }, residency: { llm: 'always' } })
})
