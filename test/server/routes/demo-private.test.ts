// On the public demo every visitor shares one library, so a link a visitor
// saves is stamped with their visitor id and shown to nobody else. These pin
// each read path that could leak one: the board, one note, the change feed,
// spaces (their counts and cover previews, and the spaces a visitor makes),
// the tags a new space is offered, chats, and the cookie itself.
import test from 'node:test'
import assert from 'node:assert/strict'
import * as store from '../../../server/data/notes.ts'
import * as collections from '../../../server/data/collections.ts'
import * as chats from '../../../server/data/chats.ts'
import { handleNotes, handleNotesDelta, handleGetNote, handleTags } from '../../../server/routes/notes.ts'
import { handleChats, handleChat } from '../../../server/routes/chats.ts'
import {
  handleCollections,
  handleCreateCollection,
  handleDeleteCollection,
} from '../../../server/routes/collections.ts'
import { demoLimits, visibleTo, visitorOf } from '../../../server/routes/demo.ts'
import { mockReq, mockRes, records } from '../../helpers/http.ts'

const ids = (v: unknown) => records(v).map(n => n.id)

async function library() {
  store._reset()
  const seed = await store.addNote({ type: 'link', content: 'seed' })
  const mine = await store.addNote({ type: 'link', content: 'mine', visitor: 'a', pending: true })
  const theirs = await store.addNote({ type: 'link', content: 'theirs', visitor: 'b', pending: true })
  return { seed, mine, theirs }
}

test('a visitor sees the shared library and their own links, never another visitor’s', async () => {
  const { seed, mine } = await library()
  const { res, sent } = mockRes()
  handleNotes(res, new URL('http://x/api/notes'), 'a')
  const body = sent.json()
  assert.deepEqual(ids(body.notes), [mine.id, seed.id])
  assert.equal(body.total, 2)
  assert.equal(body.pendingTotal, 1, 'another visitor’s pending link must not count either')
})

test('another visitor’s link is a 404, not a leak', async () => {
  const { mine, theirs } = await library()
  const other = mockRes()
  handleGetNote(other.res, theirs.id, 'a')
  assert.equal(other.sent.code, 404)
  const own = mockRes()
  handleGetNote(own.res, mine.id, 'a')
  assert.equal(own.sent.code, 200)
})

test('the change feed carries only what the visitor can see', async () => {
  store._reset()
  await store.addNote({ type: 'link', content: 'seed' })
  const { rev, bootId } = store.revState()
  const mine = await store.addNote({ type: 'link', content: 'mine', visitor: 'a', pending: true })
  await store.addNote({ type: 'link', content: 'theirs', visitor: 'b', pending: true })
  const { res, sent } = mockRes()
  handleNotesDelta(res, new URL(`http://x/api/notes/delta?since=${rev}&boot=${bootId}`), 'a')
  const body = sent.json()
  assert.deepEqual(ids(body.notes), [mine.id])
  assert.equal(body.pendingTotal, 1)
})

test('an install that is not a demo sees every note, exactly as before', async () => {
  store._reset()
  await store.addNote({ type: 'link', content: 'one' })
  await store.addNote({ type: 'link', content: 'two' })
  const { res, sent } = mockRes()
  handleNotes(res, new URL('http://x/api/notes'), null)
  assert.equal(sent.json().total, 2)
})

test('a space counts and previews only what the visitor can see', async () => {
  const { seed, theirs } = await library()
  collections._reset()
  const space = await collections.create({ name: 'Reading' })
  await collections.addItems(space.id, [seed.id, theirs.id])
  const { res, sent } = mockRes()
  handleCollections(res, 'a')
  const [only] = records(sent.json().collections)
  assert.equal(only.count, 1)
  assert.deepEqual(ids(only.covers), [seed.id])
})

test('a space a visitor makes is theirs alone, and its rule fills only from what they can see', async () => {
  store._reset()
  collections._reset()
  demoLimits.space.reset()
  const seed = await store.addNote({ type: 'link', content: 'seed', tags: ['bread'] })
  await store.addNote({ type: 'link', content: 'theirs', tags: ['bread'], visitor: 'b' })
  const made = mockRes()
  const body = JSON.stringify({ name: 'Baking', tags: ['bread'] })
  await handleCreateCollection(mockReq({ method: 'POST', body }), made.res, 'a')
  assert.equal(made.sent.code, 200)
  const id = records([made.sent.json().collection])[0].id
  assert.deepEqual(collections.get(String(id))?.itemIds, [seed.id], 'another visitor’s link must not be stored in it')

  const own = mockRes()
  handleCollections(own.res, 'a')
  assert.deepEqual(ids(own.sent.json().collections), [id])
  const other = mockRes()
  handleCollections(other.res, 'b')
  assert.deepEqual(ids(other.sent.json().collections), [])
})

test('the tags a visitor is offered come only from what they can see', async () => {
  store._reset()
  await store.addNote({ type: 'link', content: 'seed', tags: ['bread'] })
  await store.addNote({ type: 'link', content: 'theirs', tags: ['bread', 'private-thing'], visitor: 'b' })
  const { res, sent } = mockRes()
  handleTags(res, 'a')
  assert.deepEqual(sent.json().tags, [{ tag: 'bread', count: 1 }])
})

test('a visitor can delete their own space and no one else’s', async () => {
  collections._reset()
  const shared = await collections.create({ name: 'Shared' })
  const theirs = await collections.create({ name: 'Theirs', visitor: 'b' })
  const mine = await collections.create({ name: 'Mine', visitor: 'a' })
  for (const c of [shared, theirs]) {
    const { res, sent } = mockRes()
    await handleDeleteCollection(res, c.id, 'a')
    assert.equal(sent.code, 404, `${c.name} must answer like a missing space`)
  }
  const { res, sent } = mockRes()
  await handleDeleteCollection(res, mine.id, 'a')
  assert.equal(sent.code, 200)
  assert.deepEqual(
    collections.all().map(c => c.name),
    ['Theirs', 'Shared'],
  )
  const plain = mockRes()
  await handleDeleteCollection(plain.res, shared.id, null)
  assert.equal(plain.sent.code, 200, 'an ordinary install deletes any space')
})

test('a visitor’s chats are theirs alone', async () => {
  chats._reset()
  const chat = await chats.appendExchange(null, { role: 'user', text: 'q' }, { role: 'ai', text: 'a' }, 'b')
  const list = mockRes()
  handleChats(list.res, new URLSearchParams(), 'a')
  assert.equal(list.sent.json().total, 0)
  const other = mockRes()
  handleChat(other.res, chat.id, 'a')
  assert.equal(other.sent.code, 404)
  const own = mockRes()
  handleChat(own.res, chat.id, 'b')
  assert.equal(own.sent.code, 200)
})

test('a new visitor is given an id, and a returning one keeps theirs', () => {
  const first = mockRes()
  const id = visitorOf(mockReq(), first.res)
  const cookie = String(first.res.getHeader('set-cookie'))
  assert.match(cookie, new RegExp(`^kothai_visitor=${id};`))
  assert.match(cookie, /HttpOnly/)

  const again = mockRes()
  assert.equal(visitorOf(mockReq({ headers: { cookie: `kothai_visitor=${id}` } }), again.res), id)
  assert.equal(again.res.getHeader('set-cookie'), undefined, 'a returning visitor needs no new cookie')
})

// The id is a random uuid, so knowing one is what makes a visitor that visitor.
// Anything else in the cookie was not issued here and is not an id at all.
test('a visitor cookie that was not issued here is replaced, not used', () => {
  const { res } = mockRes()
  const id = visitorOf(mockReq({ headers: { cookie: 'kothai_visitor=chosen-by-hand' } }), res)
  assert.match(id, /^[0-9a-f-]{36}$/)
  assert.match(String(res.getHeader('set-cookie')), new RegExp(`^kothai_visitor=${id};`))
})

test('Ask only retrieves from what the visitor can see, by keyword and by vector', async () => {
  store._reset()
  const seed = await store.addNote({ type: 'link', content: 'sourdough starter', embedding: [1, 0] })
  await store.addNote({ type: 'link', content: 'sourdough loaf', embedding: [1, 0], visitor: 'b' })
  const keep = visibleTo('a')
  assert.deepEqual(ids(store.hybridSearch(null, 'sourdough', keep)), [seed.id])
  assert.deepEqual(ids(store.hybridSearch([1, 0], '', keep)), [seed.id])
})
