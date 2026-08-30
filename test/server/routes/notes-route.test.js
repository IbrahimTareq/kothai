import test from 'node:test'
import assert from 'node:assert/strict'
import * as store from '../../../server/data/notes.js'
import * as collections from '../../../server/data/collections.js'
import { handleNotes } from '../../../server/routes/notes.js'

function mockRes() {
  const r = { code: 0, body: null }
  r.writeHead = (c) => { r.code = c; return r }
  r.end = (s) => { r.body = JSON.parse(s) }
  r.setHeader = () => {}
  return r
}
const urlOf = (qs) => new URL('http://x/api/notes' + qs)

test('paged /api/notes returns page, total, facets, pendingTotal', async () => {
  store._reset()
  for (let i = 0; i < 5; i++) await store.addNote({ type: 'text', content: 'n' + i })
  await store.addNote({ type: 'video', url: 'https://www.instagram.com/reel/Z/', pending: true })
  const res = mockRes()
  handleNotes(res, urlOf('?offset=0&limit=3'))
  assert.equal(res.body.total, 6)
  assert.equal(res.body.notes.length, 3)
  assert.equal(res.body.offset, 0)
  assert.equal(res.body.pendingTotal, 1)
  assert.equal(res.body.facets.types.video, 1)
  assert.equal(res.body.notes[0].type, 'video', 'newest first — canonical order')
  assert.ok(!('embedding' in res.body.notes[0]))
})

test('filters compose and facets ignore type/source narrowing', async () => {
  store._reset()
  await store.addNote({ type: 'text', content: 'makkah diary' })
  await store.addNote({ type: 'video', url: 'https://www.instagram.com/reel/Y/', siteDesc: 'makkah' })
  const res = mockRes()
  handleNotes(res, urlOf('?q=makkah&type=video&limit=10'))
  assert.equal(res.body.total, 1, 'total reflects the fully filtered set')
  assert.deepEqual(res.body.facets.types, { text: 1, video: 1 }, 'facets count the q-set only')
})

test('no-param request is paged with defaults (offset 0, limit 120)', async () => {
  store._reset()
  for (let i = 0; i < 3; i++) await store.addNote({ type: 'text', content: String(i) })
  const res = mockRes()
  handleNotes(res, urlOf(''))
  assert.equal(res.body.notes.length, 3)
  assert.equal(res.body.total, 3)
  assert.equal(res.body.offset, 0)
  assert.ok('facets' in res.body)
  assert.ok('pendingTotal' in res.body)
})

test('?collection=<id> narrows to only the notes added to that collection', async () => {
  store._reset()
  collections._reset()
  const a = await store.addNote({ type: 'text', content: 'in the collection' })
  const b = await store.addNote({ type: 'text', content: 'also in the collection' })
  await store.addNote({ type: 'text', content: 'not in the collection' })

  const c = await collections.create({ name: 'Test Space' })
  await collections.addItem(c.id, a.id)
  await collections.addItem(c.id, b.id)

  const res = mockRes()
  handleNotes(res, urlOf(`?collection=${c.id}&limit=10`))
  assert.equal(res.body.total, 2, 'only the two notes added to the collection are counted')
  assert.equal(res.body.notes.length, 2)
  const ids = res.body.notes.map((n) => n.id)
  assert.ok(ids.includes(a.id) && ids.includes(b.id))

  const missing = mockRes()
  handleNotes(missing, urlOf('?collection=does-not-exist&limit=10'))
  assert.equal(missing.body.total, 0, 'unknown collection id falls back to empty, not the full list')
  assert.equal(missing.body.notes.length, 0)
})
