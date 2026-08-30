import test from 'node:test'
import assert from 'node:assert/strict'
import * as store from '../../../server/data/notes.js'
import { handleNotesDelta, handleNotes } from '../../../server/routes/notes.js'

function mockRes() {
  const r = { code: 0, body: null }
  r.writeHead = (c) => { r.code = c; return r }
  r.end = (s) => { r.body = JSON.parse(s) }
  r.setHeader = () => {}
  return r
}
const urlOf = (qs) => new URL('http://x/api/notes/delta' + qs)

test('rev bumps on add/update/delete and changedSince reports patches', async () => {
  store._reset()
  const { rev: r0 } = store.revState()
  const a = await store.addNote({ type: 'text', content: 'a' })
  const b = await store.addNote({ type: 'text', content: 'b' })
  const { rev: r1 } = store.revState()
  assert.ok(r1 > r0)
  await store.updateNote(a.id, { title: 'patched' })
  const changed = store.changedSince(r1)
  assert.deepEqual(changed.map((n) => n.id), [a.id])
  assert.equal(changed[0].title, 'patched')
  assert.ok(!('_rev' in changed[0]), 'internal rev never leaves the store')
  assert.ok(!('embedding' in changed[0]))
  await store.deleteNote(b.id)
  assert.deepEqual(store.deletedSince(r1), [b.id])
})

test('batched { persist:false } writes still bump rev', async () => {
  store._reset()
  const { rev: r0 } = store.revState()
  await store.addNote({ type: 'text', content: 'x' }, { persist: false })
  await store.flush()
  assert.ok(store.revState().rev > r0)
  assert.equal(store.changedSince(r0).length, 1)
})

test('deltaOk refuses a since that predates the tombstone window', async () => {
  store._reset()
  assert.equal(store.deltaOk(0), true, 'no discarded tombstones yet')
  // simulate overflow via the exported cap
  const ids = []
  for (let i = 0; i < 3; i++) ids.push((await store.addNote({ type: 'text', content: String(i) })).id)
  store._setTombstoneCap(2)
  const sinceBefore = store.revState().rev
  for (const id of ids) await store.deleteNote(id)
  assert.equal(store.deltaOk(0), false, 'rev 0 predates the trimmed window')
  assert.equal(store.deltaOk(store.revState().rev), true)
  store._setTombstoneCap(1000)
})

test('GET /api/notes/delta with matching boot returns notes/deleted', async () => {
  store._reset()
  const { bootId } = store.revState()
  const a = await store.addNote({ type: 'text', content: 'a' })
  const { rev: r1 } = store.revState()
  await store.updateNote(a.id, { title: 'patched' })
  const res = mockRes()
  handleNotesDelta(res, urlOf(`?since=${r1}&boot=${encodeURIComponent(bootId)}`))
  assert.equal(res.body.resync, undefined)
  assert.deepEqual(res.body.notes.map((n) => n.id), [a.id])
  assert.deepEqual(res.body.deleted, [])
  assert.equal(res.body.bootId, bootId)
})

test('GET /api/notes/delta with mismatched boot returns resync: true', async () => {
  store._reset()
  await store.addNote({ type: 'text', content: 'a' })
  const res = mockRes()
  handleNotesDelta(res, urlOf('?since=0&boot=not-the-real-boot'))
  assert.equal(res.body.resync, true)
  assert.ok('rev' in res.body)
  assert.ok('bootId' in res.body)
  assert.ok('pendingTotal' in res.body)
})

test('paged /api/notes response includes rev and bootId matching revState', async () => {
  store._reset()
  await store.addNote({ type: 'text', content: 'a' })
  const res = mockRes()
  handleNotes(res, new URL('http://x/api/notes?offset=0&limit=10'))
  const state = store.revState()
  assert.equal(res.body.rev, state.rev)
  assert.equal(res.body.bootId, state.bootId)
})
