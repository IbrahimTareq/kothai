// Unit tests for the clearAll() added to each content store. Each runs against
// an isolated in-memory slate via _reset(), so nothing here touches the real
// data/ dir. The contract every store shares: wipe the table AND the in-memory
// cache, report how many rows went, and stay usable afterwards (a wipe must
// leave a working empty store, not a half-loaded one).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as store from '../../../server/data/notes.js'
import * as collections from '../../../server/data/collections.js'
import * as chats from '../../../server/data/chats.js'
import * as tagvocab from '../../../server/data/tagvocab.js'

test('notes.clearAll empties the store, reports the count, and leaves it writable', async () => {
  store._reset()
  await store.addNote({ title: 'a', content: 'a' })
  await store.addNote({ title: 'b', content: 'b' })
  assert.equal(store.count(), 2)
  assert.equal(await store.clearAll(), 2)
  assert.equal(store.count(), 0)
  assert.deepEqual(store.allNotes(), [])
  const after = await store.addNote({ title: 'c', content: 'c' })
  assert.equal(store.count(), 1)
  assert.ok(after.id)
})

test('notes.clearAll on an already-empty store is a no-op reporting 0', async () => {
  store._reset()
  assert.equal(await store.clearAll(), 0)
  assert.equal(store.count(), 0)
})

test('notes.clearAll drops writes queued by persist:false so a wipe cannot be resurrected by a later flush', async () => {
  store._reset()
  await store.addNote({ title: 'queued', content: 'q' }, { persist: false })
  assert.equal(await store.clearAll(), 1)
  await store.flush()
  assert.equal(store.count(), 0)
  assert.deepEqual(store.allNotes(), [])
})

test('collections.clearAll empties spaces, reports the count, and leaves the store writable', async () => {
  collections._reset()
  await collections.create({ name: 'Reads' })
  await collections.create({ name: 'Recipes' })
  assert.equal(collections.all().length, 2)
  assert.equal(await collections.clearAll(), 2)
  assert.deepEqual(collections.all(), [])
  const fresh = await collections.create({ name: 'New' })
  assert.equal(collections.all().length, 1)
  assert.ok(fresh.id)
})

test('chats.clearAll empties history, reports the count, and leaves the store writable', async () => {
  chats._reset()
  await chats.appendExchange('c1', { text: 'hi' }, { text: 'hello' })
  await chats.appendExchange('c2', { text: 'yo' }, { text: 'hey' })
  assert.equal(chats.all().length, 2)
  assert.equal(await chats.clearAll(), 2)
  assert.deepEqual(chats.all(), [])
  await chats.appendExchange('c3', { text: 'again' }, { text: 'sure' })
  assert.equal(chats.all().length, 1)
})

test('tagvocab.clearAll empties the registry so it can re-seed from scratch after a wipe', async () => {
  tagvocab._reset()
  await tagvocab.canonicalize(['coffee', 'travel'], { embed: async () => [1, 0, 0] })
  assert.ok(tagvocab.size() > 0)
  const cleared = await tagvocab.clearAll()
  assert.equal(cleared, 1) // 'coffee' and 'travel' collapse to one entry at this embedding
  assert.equal(tagvocab.size(), 0)
})
