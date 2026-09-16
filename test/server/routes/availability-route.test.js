// Tests for server/routes/availability.ts — the sweep and the destructive step.
//
// Both guards here exist because the failure mode is silent data loss: a user
// sees a count, presses remove, and never learns what went with it.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

let notes = []
let deleted = []
let verdicts = {} // url -> 'alive' | 'dead' | 'unknown'

const realStore = await import('../../../server/data/notes.ts')
const realCollections = await import('../../../server/data/collections.ts')
const realAvail = await import('../../../server/ai/availability.ts')

mock.module('../../../server/data/notes.ts', {
  namedExports: {
    ...realStore,
    allNotes: () => notes.map(n => ({ ...n })),
    getNote: id => {
      const n = notes.find(x => x.id === id)
      return n ? { ...n } : null
    },
    updateNote: async (id, patch) => {
      const n = notes.find(x => x.id === id)
      if (n) Object.assign(n, patch)
      return n
    },
    deleteNote: async id => {
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
mock.module('../../../server/ai/availability.ts', {
  namedExports: {
    ...realAvail,
    isCheckable: url => typeof url === 'string' && url.includes('tiktok.com'),
    checkAvailability: async url => verdicts[url] || 'unknown',
  },
})

const { handleAvailabilityScan, handleAvailabilityRemove } = await import('../../../server/routes/availability.ts')

function fakeReq(payload) {
  const req = new EventEmitter()
  req.destroy = () => {}
  setImmediate(() => {
    req.emit('data', Buffer.from(JSON.stringify(payload)))
    req.emit('end')
  })
  return req
}
function fakeRes() {
  return {
    statusCode: null,
    body: null,
    writeHead(c) {
      this.statusCode = c
    },
    end(s) {
      this.body = s ? JSON.parse(s) : null
    },
  }
}
function seed(n, verdict) {
  notes = Array.from({ length: n }, (_, i) => ({ id: `n${i}`, url: `https://www.tiktok.com/video/${i}` }))
  verdicts = {}
  for (const x of notes) verdicts[x.url] = verdict(x)
  deleted = []
}

test('a scan marks gone links and leaves everything else alone', async () => {
  seed(10, n => (n.id === 'n3' || n.id === 'n7' ? 'dead' : 'alive'))
  const res = fakeRes()
  await handleAvailabilityScan(fakeReq({}), res)
  assert.equal(res.body.dead, 2)
  assert.equal(res.body.marked, 2)
  assert.equal(res.body.unavailable, 2)
  assert.deepEqual(
    notes
      .filter(n => n.unavailable)
      .map(n => n.id)
      .sort(),
    ['n3', 'n7'],
  )
  assert.equal(deleted.length, 0, 'a scan never deletes')
})

test('an unreachable link is left untouched — not marked, not cleared', async () => {
  seed(10, n => (n.id === 'n1' ? 'unknown' : 'alive'))
  notes.find(n => n.id === 'n1').unavailable = true // marked by an earlier scan
  await handleAvailabilityScan(fakeReq({}), fakeRes())
  assert.equal(notes.find(n => n.id === 'n1').unavailable, true, 'an inconclusive check must not clear a mark either')
})

test('a link that comes back has its mark cleared', async () => {
  seed(5, () => 'alive')
  for (const n of notes) n.unavailable = true
  const res = fakeRes()
  await handleAvailabilityScan(fakeReq({}), res)
  assert.equal(res.body.cleared, 5)
  assert.equal(res.body.unavailable, 0)
})

test('an implausible number of dead links aborts the sweep without marking anything', async () => {
  // A throttle or a changed API answers every request the same way. Believing
  // it would hand the user a "remove 100 items" button for a live library.
  seed(100, () => 'dead')
  const res = fakeRes()
  await handleAvailabilityScan(fakeReq({}), res)
  assert.equal(res.body.aborted, true)
  assert.equal(res.body.marked, 0)
  assert.equal(notes.filter(n => n.unavailable).length, 0, 'nothing may be marked when the sweep is not believed')
  assert.match(res.body.error, /too many to believe/i)
})

test('a small sample is not judged by ratio — 3 of 4 gone is ordinary', async () => {
  seed(4, n => (n.id === 'n0' ? 'alive' : 'dead'))
  const res = fakeRes()
  await handleAvailabilityScan(fakeReq({}), res)
  assert.equal(res.body.aborted, false)
  assert.equal(res.body.marked, 3)
})

test('remove deletes exactly the marked items', async () => {
  seed(6, n => (n.id === 'n1' || n.id === 'n4' ? 'dead' : 'alive'))
  await handleAvailabilityScan(fakeReq({}), fakeRes())
  const res = fakeRes()
  await handleAvailabilityRemove(fakeReq({ expected: 2 }), res)
  assert.equal(res.body.removed, 2)
  assert.deepEqual(deleted.sort(), ['n1', 'n4'])
  assert.equal(notes.length, 4)
})

test('remove refuses when the count moved since the user saw it', async () => {
  // The user agreed to delete N things. If the set changed, they did not agree
  // to delete THIS set.
  seed(6, n => (n.id === 'n1' ? 'dead' : 'alive'))
  await handleAvailabilityScan(fakeReq({}), fakeRes())
  const res = fakeRes()
  await handleAvailabilityRemove(fakeReq({ expected: 5 }), res)
  assert.equal(res.statusCode, 409)
  assert.equal(res.body.code, 'count_mismatch')
  assert.equal(deleted.length, 0, 'nothing may be deleted on a mismatch')
  assert.equal(notes.length, 6)
})

test('remove with no marked items deletes nothing', async () => {
  seed(3, () => 'alive')
  const res = fakeRes()
  await handleAvailabilityRemove(fakeReq({ expected: 0 }), res)
  assert.equal(res.body.removed, 0)
  assert.equal(deleted.length, 0)
})

test('remove clears the whole marked set when the notes carry uploaded files', async () => {
  // Every fixture above builds notes as {id, url} only, so the uploaded-file
  // cleanup in handleAvailabilityRemove was never entered and a broken
  // UPLOAD_DIR read there went unnoticed. These notes carry files precisely so
  // that block runs: if it throws, the loop dies after the first delete and
  // the rest of the marked set survives while its notes are already gone.
  seed(4, n => (n.id === 'n0' || n.id === 'n2' ? 'dead' : 'alive'))
  Object.assign(
    notes.find(n => n.id === 'n0'),
    {
      image: '/uploads/availability-image.png',
      thumb: '/uploads/availability-thumb.png',
    },
  )
  Object.assign(
    notes.find(n => n.id === 'n2'),
    {
      slides: ['/uploads/availability-slide-1.png', '/uploads/availability-slide-2.png'],
    },
  )
  await handleAvailabilityScan(fakeReq({}), fakeRes())
  const res = fakeRes()
  await handleAvailabilityRemove(fakeReq({ expected: 2 }), res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.body, { removed: 2, unavailable: 0 })
  assert.deepEqual(deleted.sort(), ['n0', 'n2'], 'the second marked note must go too, not just the first')
  assert.equal(notes.length, 2)
})
