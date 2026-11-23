// GET /api/v1/notes (keyset paging) and /api/v1/spaces. Ids and createdAt are
// set by hand: a keyset needs a total order, so ties and mid-walk inserts are
// the cases that matter and wall-clock stamps cannot produce them.
import test from 'node:test'
import assert from 'node:assert/strict'
import * as store from '../../../server/data/notes.ts'
import * as collections from '../../../server/data/collections.ts'
import { handleNotesPage, handleSpaces } from '../../../server/routes/v1.ts'
import { decodeCursor, encodeCursor } from '../../../server/routes/v1-cursor.ts'
import { mockRes, records } from '../../helpers/http.ts'

const at = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()

async function seed(n: number) {
  store._reset()
  collections._reset()
  for (let i = 1; i <= n; i++) await store.addNote({ id: `n${i}`, createdAt: at(i), content: `c${i}` })
}

function page(qs = '', viewer: string | null = null) {
  const { res, sent } = mockRes()
  handleNotesPage(res, new URL(`http://x/api/v1/notes${qs}`), viewer)
  return sent
}
const ids = (body: Record<string, unknown>) => records(body.notes).map(n => n.id)

test('pages walk the library newest-first with no repeats', async () => {
  await seed(5)
  const seen: unknown[] = []
  let next: unknown = null
  let pages = 0
  do {
    const sent = page(`?limit=2${next ? `&cursor=${next}` : ''}`)
    assert.equal(sent.code, 200)
    const body = sent.json()
    seen.push(...ids(body))
    next = body.next
    pages++
  } while (next)
  assert.equal(pages, 3)
  assert.deepEqual(seen, ['n5', 'n4', 'n3', 'n2', 'n1'])
})

test('a save between two page fetches neither skips nor repeats', async () => {
  await seed(4)
  const first = page('?limit=2').json()
  await store.addNote({ id: 'newer', createdAt: at(99) })
  const second = page(`?limit=2&cursor=${first.next}`).json()
  assert.deepEqual([...ids(first), ...ids(second)].sort(), ['n1', 'n2', 'n3', 'n4'])
  assert.equal(second.next, null)
})

test('equal createdAt ties break by id', async () => {
  store._reset()
  for (const id of ['a', 'c', 'b']) await store.addNote({ id, createdAt: at(1) })
  const first = page('?limit=2').json()
  assert.deepEqual(ids(first), ['c', 'b'])
  assert.deepEqual(ids(page(`?limit=2&cursor=${first.next}`).json()), ['a'])
})

test('space=<id> limits the page to that space', async () => {
  await seed(4)
  const space = await collections.create({ name: 'S' })
  await collections.addItems(space.id, ['n1', 'n3'])
  assert.deepEqual(ids(page(`?space=${space.id}`).json()), ['n3', 'n1'])
})

test('limit is capped at 200; a malformed cursor is 400 bad_cursor', async () => {
  await seed(201)
  assert.equal(records(page('?limit=999').json().notes).length, 200)
  assert.equal(page('?limit=999').json().next !== null, true)
  for (const cursor of ['%%%', encodeCursor(['x']).concat('!'), Buffer.from('7').toString('base64url')]) {
    const sent = page(`?cursor=${cursor}`)
    assert.equal(sent.code, 400)
    assert.equal(sent.json().code, 'bad_cursor')
  }
})

test('a cursor whose fields are not strings is 400 bad_cursor', async () => {
  await seed(1)
  const sent = page(`?cursor=${encodeCursor({ createdAt: {}, id: [] })}`)
  assert.equal(sent.code, 400)
  assert.equal(sent.json().code, 'bad_cursor')
})

test('an unknown space is 404 not_found, not an empty page', async () => {
  await seed(2)
  const sent = page('?space=nope')
  assert.equal(sent.code, 404)
  assert.equal(sent.json().code, 'not_found')
})

test('another visitor’s space answers like a missing one', async () => {
  await seed(2)
  const space = await collections.create({ name: 'S', visitor: 'b' })
  await collections.addItems(space.id, ['n1'])
  assert.equal(page(`?space=${space.id}`, 'a').code, 404)
  assert.deepEqual(ids(page(`?space=${space.id}`, 'b').json()), ['n1'])
})

test('unavailable notes are not listed', async () => {
  await seed(3)
  await store.updateNote('n2', { unavailable: true })
  assert.deepEqual(ids(page().json()), ['n3', 'n1'])
})

test('another visitor’s notes are hidden from a demo viewer', async () => {
  await seed(2)
  await store.updateNote('n1', { visitor: 'v1' })
  assert.deepEqual(ids(page('', 'v2').json()), ['n2'])
})

test('decodeCursor is total', () => {
  assert.deepEqual(decodeCursor(encodeCursor({ a: 1 })), { a: 1 })
  for (const s of [
    '',
    '%%%',
    'not json',
    Buffer.from('7').toString('base64url'),
    Buffer.from('null').toString('base64url'),
  ])
    assert.equal(decodeCursor(s), null)
})

test('spaces list counts only members the viewer can see', async () => {
  await seed(2)
  await store.updateNote('n1', { visitor: 'v1' })
  const s = await collections.create({ name: 'S', visitor: undefined })
  await collections.addItems(s.id, ['n1', 'n2'])
  const { res, sent } = mockRes()
  handleSpaces(res, 'v2')
  const [space] = records(sent.json().spaces)
  assert.equal(space.count, 1)
  assert.deepEqual(Object.keys(space).sort(), ['count', 'createdAt', 'id', 'name'])
})
