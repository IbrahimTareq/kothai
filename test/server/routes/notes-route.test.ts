import test from 'node:test'
import assert from 'node:assert/strict'
import * as store from '../../../server/data/notes.ts'
import * as collections from '../../../server/data/collections.ts'
import { handleNotes, handleDeleteNote } from '../../../server/routes/notes.ts'
import { mockRes, record, records } from '../../helpers/http.ts'

const urlOf = (qs: string) => new URL(`http://x/api/notes${qs}`)

test('paged /api/notes returns page, total, facets, pendingTotal', async () => {
  store._reset()
  for (let i = 0; i < 5; i++) await store.addNote({ type: 'link', content: `n${i}` })
  await store.addNote({ type: 'video', url: 'https://www.instagram.com/reel/Z/', pending: true })
  const { res, sent } = mockRes()
  handleNotes(res, urlOf('?offset=0&limit=3'), null)
  const body = sent.json()
  const notes = records(body.notes)
  assert.equal(body.total, 6)
  assert.equal(notes.length, 3)
  assert.equal(body.offset, 0)
  assert.equal(body.pendingTotal, 1)
  assert.equal(record(record(body.facets).types).video, 1)
  assert.equal(notes[0].type, 'video', 'newest first — canonical order')
  assert.ok(!('embedding' in notes[0]))
})

test('filters compose and facets ignore type/source narrowing', async () => {
  store._reset()
  await store.addNote({ type: 'link', content: 'makkah diary' })
  await store.addNote({ type: 'video', url: 'https://www.instagram.com/reel/Y/', siteDesc: 'makkah' })
  const { res, sent } = mockRes()
  handleNotes(res, urlOf('?q=makkah&type=video&limit=10'), null)
  const body = sent.json()
  assert.equal(body.total, 1, 'total reflects the fully filtered set')
  assert.deepEqual(record(body.facets).types, { link: 1, video: 1 }, 'facets count the q-set only')
})

test('no-param request is paged with defaults (offset 0, limit 120)', async () => {
  store._reset()
  for (let i = 0; i < 3; i++) await store.addNote({ type: 'link', content: String(i) })
  const { res, sent } = mockRes()
  handleNotes(res, urlOf(''), null)
  const body = sent.json()
  assert.equal(records(body.notes).length, 3)
  assert.equal(body.total, 3)
  assert.equal(body.offset, 0)
  assert.ok('facets' in body)
  assert.ok('pendingTotal' in body)
})

test('?collection=<id> narrows to only the notes added to that collection', async () => {
  store._reset()
  collections._reset()
  const a = await store.addNote({ type: 'link', content: 'in the collection' })
  const b = await store.addNote({ type: 'link', content: 'also in the collection' })
  await store.addNote({ type: 'link', content: 'not in the collection' })

  const c = await collections.create({ name: 'Test Space' })
  await collections.addItem(c.id, a.id)
  await collections.addItem(c.id, b.id)

  const { res, sent } = mockRes()
  handleNotes(res, urlOf(`?collection=${c.id}&limit=10`), null)
  const body = sent.json()
  const notes = records(body.notes)
  assert.equal(body.total, 2, 'only the two notes added to the collection are counted')
  assert.equal(notes.length, 2)
  const ids = notes.map(n => n.id)
  assert.ok(ids.includes(a.id) && ids.includes(b.id))

  const missing = mockRes()
  handleNotes(missing.res, urlOf('?collection=does-not-exist&limit=10'), null)
  const missingBody = missing.sent.json()
  assert.equal(missingBody.total, 0, 'unknown collection id falls back to empty, not the full list')
  assert.equal(records(missingBody.notes).length, 0)
})

test('deleting a note that owns uploaded files still removes the note', async () => {
  // The single-note delete path cleans up the note's uploads on the way out.
  // No fixture here ever carried an upload, so that block never ran and a
  // broken UPLOAD_DIR read inside it stayed invisible — the note vanishes from
  // the store first, so a throw there is reported to the user as a 500 on a
  // delete that already happened.
  store._reset()
  collections._reset()
  const note = await store.addNote({
    type: 'link',
    content: 'has uploads',
    thumb: '/uploads/notes-route-thumb.png',
    slides: ['/uploads/notes-route-slide-1.png'],
  })
  const { res, sent } = mockRes()
  await handleDeleteNote(res, note.id, null)
  assert.equal(sent.code, 200)
  assert.deepEqual(sent.json(), { ok: true })
  assert.equal(store.allNotes().length, 0)
})

// The list is what the grid renders, and the grid never reads a note's
// extracted article (up to 8,000 chars), its thumbnail description or its
// enrichment bookkeeping. Sent anyway, the article alone was 89% of a fresh
// demo's /api/notes: 162 KB of a 180 KB page of thirty notes.
test('/api/notes sends what a card shows, not the fields only the server reads', async () => {
  store._reset()
  const n = await store.addNote({ type: 'link', url: 'https://example.com/a', content: 'https://example.com/a' })
  await store.updateNote(n.id, {
    siteTitle: 'A page',
    siteDesc: 'What it is about',
    thumb: '/uploads/meta-a.jpg',
    article: 'x'.repeat(8000),
    thumbDescription: 'a photo of a page',
    thumbSrc: 'https://cdn.example.com/og.png',
    ai: { classify: true, embed: true },
    metaTries: 1,
  })
  const { res, sent } = mockRes()
  handleNotes(res, urlOf(''), null)
  const [card] = records(sent.json().notes)
  for (const k of ['article', 'thumbDescription', 'thumbSrc', 'ai', 'metaTries'])
    assert.ok(!(k in card), `${k} is server-only`)
  assert.equal(card.siteTitle, 'A page')
  assert.equal(card.siteDesc, 'What it is about')
  assert.equal(card.thumb, '/uploads/meta-a.jpg')
})
