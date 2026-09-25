// Tests for server/routes/availability.ts — the destructive step.
//
// The guard here exists because the failure mode is silent data loss: a user
// sees a count, presses remove, and never learns what went with it. Marking is
// the daily sweep's job (test/server/links/sweep.test.ts); these notes arrive
// already marked.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mockReq, mockRes } from '../../helpers/http.ts'
import { note } from '../../helpers/notes.ts'
import type { ServerNote } from '../../../server/types.ts'

let notes: ServerNote[] = []
let deleted: string[] = []

const realStore = await import('../../../server/data/notes.ts')
const realCollections = await import('../../../server/data/collections.ts')

mock.module('../../../server/data/notes.ts', {
  namedExports: {
    ...realStore,
    allNotes: () => notes.map(n => ({ ...n })),
    getNote: (id: string) => {
      const n = notes.find(x => x.id === id)
      return n ? { ...n } : null
    },
    deleteNote: async (id: string) => {
      const before = notes.length
      notes = notes.filter(n => n.id !== id)
      if (notes.length !== before) {
        deleted.push(id)
        return true
      }
      return false
    },
  },
})
mock.module('../../../server/data/collections.ts', {
  namedExports: { ...realCollections, deleteItemEverywhere: async () => {} },
})

const { handleAvailabilityRemove } = await import('../../../server/routes/availability.ts')

// Remove reads the count the user was shown, which is the whole point of the
// endpoint.
const removeReq = (payload: unknown) =>
  mockReq({ method: 'POST', url: '/api/availability/remove', body: JSON.stringify(payload) })

function seed(n: number, marked: string[]) {
  notes = []
  deleted = []
  for (let i = 0; i < n; i++) {
    const id = `n${i}`
    notes.push(note({ id, url: `https://www.tiktok.com/video/${i}`, unavailable: marked.includes(id) || undefined }))
  }
}

function find(id: string): ServerNote {
  const found = notes.find(n => n.id === id)
  assert.ok(found, `no note ${id} — the fixture and the assertion have drifted apart`)
  return found
}

test('remove deletes exactly the marked items', async () => {
  seed(6, ['n1', 'n4'])
  const { res, sent } = mockRes()
  await handleAvailabilityRemove(removeReq({ expected: 2 }), res)
  assert.equal(sent.json().removed, 2)
  assert.deepEqual(deleted.sort(), ['n1', 'n4'])
  assert.equal(notes.length, 4)
})

test('remove refuses when the count moved since the user saw it', async () => {
  // The user agreed to delete N things. If the set changed, they did not agree
  // to delete THIS set.
  seed(6, ['n1'])
  const { res, sent } = mockRes()
  await handleAvailabilityRemove(removeReq({ expected: 5 }), res)
  assert.equal(sent.code, 409)
  assert.equal(sent.json().code, 'count_mismatch')
  assert.equal(deleted.length, 0, 'nothing may be deleted on a mismatch')
  assert.equal(notes.length, 6)
})

test('remove with no marked items deletes nothing', async () => {
  seed(3, [])
  const { res, sent } = mockRes()
  await handleAvailabilityRemove(removeReq({ expected: 0 }), res)
  assert.equal(sent.json().removed, 0)
  assert.equal(deleted.length, 0)
})

test('remove clears the whole marked set when the notes carry uploaded files', async () => {
  // Notes built as {id, url} alone never entered the uploaded-file cleanup in
  // handleAvailabilityRemove, so a broken UPLOAD_DIR read there went
  // unnoticed. These notes carry files precisely so that block runs: if it
  // throws, the loop dies after the first delete and the rest of the marked
  // set survives while its notes are already gone.
  seed(4, ['n0', 'n2'])
  Object.assign(find('n0'), {
    image: '/uploads/availability-image.png',
    thumb: '/uploads/availability-thumb.png',
  })
  Object.assign(find('n2'), {
    slides: ['/uploads/availability-slide-1.png', '/uploads/availability-slide-2.png'],
  })
  const { res, sent } = mockRes()
  await handleAvailabilityRemove(removeReq({ expected: 2 }), res)
  assert.equal(sent.code, 200)
  assert.deepEqual(sent.json(), { removed: 2, unavailable: 0 })
  assert.deepEqual(deleted.sort(), ['n0', 'n2'], 'the second marked note must go too, not just the first')
  assert.equal(notes.length, 2)
})
