import test from 'node:test'
import assert from 'node:assert/strict'
import * as store from '../../../server/data/notes.ts'
import { handleNotesDelta, handleNotes } from '../../../server/routes/notes.ts'
import { mockRes, records } from '../../helpers/http.ts'

const urlOf = (qs: string) => new URL(`http://x/api/notes/delta${qs}`)

test('rev bumps on add/update/delete and changedSince reports patches', async () => {
  store._reset()
  const { rev: r0 } = store.revState()
  const a = await store.addNote({ type: 'text', content: 'a' })
  const b = await store.addNote({ type: 'text', content: 'b' })
  const { rev: r1 } = store.revState()
  assert.ok(r1 > r0)
  await store.updateNote(a.id, { title: 'patched' })
  const changed = store.changedSince(r1)
  assert.deepEqual(
    changed.map(n => n.id),
    [a.id],
  )
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
  const { res, sent } = mockRes()
  handleNotesDelta(res, urlOf(`?since=${r1}&boot=${encodeURIComponent(bootId)}`))
  const body = sent.json()
  assert.equal(body.resync, undefined)
  assert.deepEqual(
    records(body.notes).map(n => n.id),
    [a.id],
  )
  assert.deepEqual(body.deleted, [])
  assert.equal(body.bootId, bootId)
})

test('GET /api/notes/delta with mismatched boot returns resync: true', async () => {
  store._reset()
  await store.addNote({ type: 'text', content: 'a' })
  const { res, sent } = mockRes()
  handleNotesDelta(res, urlOf('?since=0&boot=not-the-real-boot'))
  const body = sent.json()
  assert.equal(body.resync, true)
  assert.ok('rev' in body)
  assert.ok('bootId' in body)
  assert.ok('pendingTotal' in body)
})

test('paged /api/notes response includes rev and bootId matching revState', async () => {
  store._reset()
  await store.addNote({ type: 'text', content: 'a' })
  const { res, sent } = mockRes()
  handleNotes(res, new URL('http://x/api/notes?offset=0&limit=10'))
  const state = store.revState()
  const body = sent.json()
  assert.equal(body.rev, state.rev)
  assert.equal(body.bootId, state.bootId)
})
