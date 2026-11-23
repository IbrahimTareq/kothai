// GET /api/v1/changes: the offline cache's sync feed. Cursors are built by hand
// where a test needs a foreign boot or a stale rev; everything else walks the
// real cursor the route handed out.
import test from 'node:test'
import assert from 'node:assert/strict'
import * as store from '../../../server/data/notes.ts'
import * as collections from '../../../server/data/collections.ts'
import { handleChanges } from '../../../server/routes/v1.ts'
import { decodeCursor, encodeCursor } from '../../../server/routes/v1-cursor.ts'
import { mockRes, records } from '../../helpers/http.ts'

function changes(since?: string, viewer: string | null = null) {
  const { res, sent } = mockRes()
  const qs = since === undefined ? '' : `?since=${since}`
  handleChanges(res, new URL(`http://x/api/v1/changes${qs}`), viewer)
  return sent
}

async function fresh() {
  store._reset()
  collections._reset()
  return changes().json().cursor as string
}

test('no since gives resync with a cursor', async () => {
  store._reset()
  collections._reset()
  const sent = changes()
  assert.equal(sent.code, 200)
  const body = sent.json()
  assert.equal(body.resync, true)
  assert.equal(typeof body.cursor, 'string')
  assert.ok(decodeCursor(String(body.cursor)))
})

test('a note added after the cursor comes back in notes; one updated comes back once', async () => {
  const cursor = await fresh()
  const a = await store.addNote({ type: 'link', content: 'a' })
  await store.updateNote(a.id, { title: 'patched' })
  const body = changes(cursor).json()
  assert.deepEqual(
    records(body.notes).map(n => n.id),
    [a.id],
  )
  assert.equal(records(body.notes)[0].title, 'patched')
  assert.deepEqual(body.deleted, [])
  assert.equal(records(changes(body.cursor as string).json().notes).length, 0)
})

test('a deleted note’s id comes back in deleted', async () => {
  const a = await store.addNote({ type: 'link', content: 'a' })
  const cursor = changes().json().cursor as string
  await store.deleteNote(a.id)
  assert.deepEqual(changes(cursor).json().deleted, [a.id])
})

test('a cursor from another boot answers resync', async () => {
  await fresh()
  const { rev } = store.revState()
  const foreign = encodeCursor({ boot: 'some-other-boot', rev, spacesRev: collections.spacesRevState() })
  const body = changes(foreign).json()
  assert.equal(body.resync, true)
  assert.equal('notes' in body, false)
})

test('a cursor older than the tombstone window answers resync', async () => {
  await fresh()
  const stale = changes().json().cursor as string
  const ids = []
  for (let i = 0; i < 3; i++) ids.push((await store.addNote({ type: 'link', content: String(i) })).id)
  store._setTombstoneCap(2)
  try {
    for (const id of ids) await store.deleteNote(id)
    assert.equal(changes(stale).json().resync, true)
  } finally {
    store._setTombstoneCap(1000)
  }
})

test('spaces is present only when a space changed since the cursor', async () => {
  const cursor = await fresh()
  await store.addNote({ type: 'link', content: 'a' })
  const quiet = changes(cursor).json()
  assert.equal('spaces' in quiet, false)
  const s = await collections.create({ name: 'S' })
  const loud = changes(quiet.cursor as string).json()
  assert.deepEqual(
    records(loud.spaces).map(x => x.id),
    [s.id],
  )
  assert.equal('spaces' in changes(loud.cursor as string).json(), false)
})

test('a malformed since is 400 bad_cursor', async () => {
  await fresh()
  const partial = encodeCursor({ boot: 'x', rev: 'nope' })
  for (const since of ['%%%', Buffer.from('7').toString('base64url'), partial]) {
    const sent = changes(since)
    assert.equal(sent.code, 400)
    assert.equal(sent.json().code, 'bad_cursor')
  }
})

test('notes are filtered by viewer; deletions are not', async () => {
  const cursor = await fresh()
  const mine = await store.addNote({ type: 'link', content: 'm', visitor: 'v1' })
  const theirs = await store.addNote({ type: 'link', content: 't', visitor: 'v2' })
  const body = changes(cursor, 'v1').json()
  assert.deepEqual(
    records(body.notes).map(n => n.id),
    [mine.id],
  )
  await store.deleteNote(theirs.id)
  assert.deepEqual(changes(body.cursor as string, 'v1').json().deleted, [theirs.id])
})
