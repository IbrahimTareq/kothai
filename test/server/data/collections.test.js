// Unit tests for server/data/collections.js — the Spaces store + membership logic.
// Runs against an isolated in-memory slate via _reset() (marks the module
// "loaded" so load() never touches the real data/ dir and persist() writes are
// ignored). All matching/backfill logic is pure, so no filesystem is needed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
// Relative specifier → resolved against THIS file's location, not cwd.
import * as collections from '../../../server/data/collections.js'
import * as store from '../../../server/data/notes.js'

test('manual collection: add/remove items, newest-first, removal sticks', async () => {
  collections._reset()
  const c = await collections.create({ name: 'Reads' }) // no tags → manual
  assert.equal(c.tags.length, 0)
  await collections.addItem(c.id, 'n1')
  await collections.addItem(c.id, 'n2')
  let got = collections.get(c.id)
  assert.deepEqual(got.itemIds, ['n2', 'n1']) // newest-first
  assert.equal(got.count, 2)
  await collections.removeItem(c.id, 'n1')
  got = collections.get(c.id)
  assert.deepEqual(got.itemIds, ['n2'])
  assert.deepEqual(got.removedIds, ['n1'])
})

test('smart collection backfills existing tag matches (match ANY, case-insensitive)', async () => {
  collections._reset()
  const notes = [
    { id: 'a', tags: ['Recipe', 'dinner'] },
    { id: 'b', tags: ['travel'] },
    { id: 'c', tags: ['cooking'] },
  ]
  const c = await collections.create({ name: 'Food', tags: ['recipe', 'cooking'] }, notes)
  assert.deepEqual(new Set(c.itemIds), new Set(['a', 'c']))
  assert.equal(c.count, 2)
})

test('autoAdd fills matching smart collections and respects removedIds', async () => {
  collections._reset()
  const smart = await collections.create({ name: 'Food', tags: ['recipe'] })
  const manual = await collections.create({ name: 'Misc' })
  await collections.autoAdd('x', ['recipe', 'quick'])
  assert.deepEqual(collections.get(smart.id).itemIds, ['x'])
  assert.deepEqual(collections.get(manual.id).itemIds, []) // no rule → no auto-add
  // hand-remove, then a re-import with the same tag must NOT boomerang back
  await collections.removeItem(smart.id, 'x')
  await collections.autoAdd('x', ['recipe'])
  assert.deepEqual(collections.get(smart.id).itemIds, [])
})

test('editing tags backfills additively; never retroactively removes', async () => {
  collections._reset()
  const notes = [
    { id: 'a', tags: ['recipe'] },
    { id: 'b', tags: ['travel'] },
  ]
  const c = await collections.create({ name: 'Food', tags: ['recipe'] }, notes)
  assert.deepEqual(c.itemIds, ['a'])
  const widened = await collections.update(c.id, { tags: ['recipe', 'travel'] }, notes)
  assert.deepEqual(new Set(widened.itemIds), new Set(['a', 'b']))
  const narrowed = await collections.update(c.id, { tags: ['nonsense'] }, notes)
  assert.deepEqual(new Set(narrowed.itemIds), new Set(['a', 'b'])) // additive only
})

test('deleteItemEverywhere purges an id from itemIds and removedIds', async () => {
  collections._reset()
  const c1 = await collections.create({ name: 'A' })
  const c2 = await collections.create({ name: 'B' })
  await collections.addItem(c1.id, 'z')
  await collections.addItem(c2.id, 'z')
  await collections.removeItem(c2.id, 'z') // z now in c2.removedIds
  await collections.deleteItemEverywhere('z')
  assert.deepEqual(collections.get(c1.id).itemIds, [])
  assert.deepEqual(collections.get(c2.id).removedIds, [])
})

test('collection operations never mutate the caller-provided notes', async () => {
  collections._reset()
  const notes = [{ id: 'a', tags: ['recipe'] }]
  const snapshot = JSON.stringify(notes)
  await collections.create({ name: 'Food', tags: ['recipe'] }, notes)
  assert.equal(JSON.stringify(notes), snapshot)
})

test('update/addItem/removeItem return null for a missing collection', async () => {
  collections._reset()
  assert.equal(await collections.update('nope', { name: 'x' }, []), null)
  assert.equal(await collections.addItem('nope', 'i'), null)
  assert.equal(await collections.removeItem('nope', 'i'), null)
})

test('smart matching agrees on spaces vs hyphens (shared normalizer)', async () => {
  collections._reset()
  const notes = [{ id: 'a', tags: ['Machine Learning'] }] // note stored with a space
  const c = await collections.create({ name: 'ML', tags: ['machine-learning'] }, notes)
  assert.deepEqual(c.itemIds, ['a']) // must match despite space vs hyphen
})

test('all() resolves cover notes for the first members', async () => {
  store._reset(); collections._reset()
  const n1 = await store.addNote({ type: 'video', url: 'https://x/1', thumb: '/uploads/a.jpg' })
  const n2 = await store.addNote({ type: 'text', content: 'b' })
  const c = await collections.create({ name: 'Trip' })
  await collections.addItem(c.id, n1.id)
  await collections.addItem(c.id, n2.id)
  const listed = collections.all().find((x) => x.id === c.id)
  assert.equal(listed.covers.length, 2)
  assert.equal(listed.covers[0].id, n2.id, 'newest membership first, same as itemIds')
  assert.ok(!('embedding' in listed.covers[0]))
})

test('addItem/removeItem/update return covers directly, not just count', async () => {
  store._reset(); collections._reset()
  const n1 = await store.addNote({ type: 'video', url: 'https://x/1', thumb: '/uploads/a.jpg' })
  const n2 = await store.addNote({ type: 'text', content: 'b' })
  const c = await collections.create({ name: 'Trip' })

  const afterAdd = await collections.addItem(c.id, n1.id)
  assert.ok(Array.isArray(afterAdd.covers), 'addItem response carries a covers array')
  assert.equal(afterAdd.covers.length, 1)
  assert.equal(afterAdd.covers[0].id, n1.id)

  const afterAdd2 = await collections.addItem(c.id, n2.id)
  assert.equal(afterAdd2.covers.length, 2)
  assert.equal(afterAdd2.covers[0].id, n2.id, 'newest membership first')

  const afterUpdate = await collections.update(c.id, { name: 'Trip 2' }, [])
  assert.ok(Array.isArray(afterUpdate.covers), 'update response carries a covers array')
  assert.equal(afterUpdate.covers.length, 2)

  const afterRemove = await collections.removeItem(c.id, n2.id)
  assert.ok(Array.isArray(afterRemove.covers), 'removeItem response carries a covers array')
  assert.equal(afterRemove.covers.length, 1)
  assert.equal(afterRemove.covers[0].id, n1.id)
})

test('create() with a backfilled smart rule returns covers directly, not just count', async () => {
  store._reset(); collections._reset()
  const n1 = await store.addNote({ type: 'video', url: 'https://x/1', thumb: '/uploads/a.jpg', tags: ['vacation'] })
  const n2 = await store.addNote({ type: 'text', content: 'b', tags: ['vacation'] })
  const c = await collections.create({ name: 'Vacation', tags: ['vacation'] }, store.allNotes())
  assert.equal(c.itemIds.length, 2, 'backfill populated membership at creation time')
  assert.ok(Array.isArray(c.covers), 'create response carries a covers array')
  assert.equal(c.covers.length, 2)
  assert.deepEqual(new Set(c.covers.map((n) => n.id)), new Set([n1.id, n2.id]))
})

// --- addItems: the batched form used by bulk import ------------------------

test('addItems: same semantics as addItem in a loop — dedup, order, removedIds cleared', async () => {
  collections._reset()
  const batched = await collections.create({ name: 'Batched' })
  await collections.addItems(batched.id, ['n1', 'n2', 'n3'])

  const looped = await collections.create({ name: 'Looped' })
  for (const id of ['n1', 'n2', 'n3']) await collections.addItem(looped.id, id)

  assert.deepEqual(collections.get(batched.id).itemIds, collections.get(looped.id).itemIds)
  assert.deepEqual(collections.get(batched.id).itemIds, ['n3', 'n2', 'n1']) // newest-first, as unshift gives
})

test('addItems: an id already present is not duplicated, and a hand-removed id is un-removed', async () => {
  collections._reset()
  const c = await collections.create({ name: 'Reads' })
  await collections.addItems(c.id, ['n1', 'n2'])
  await collections.removeItem(c.id, 'n1')
  assert.deepEqual(collections.get(c.id).removedIds, ['n1'])

  await collections.addItems(c.id, ['n1', 'n2', 'n2'])
  const got = collections.get(c.id)
  assert.deepEqual(got.itemIds.slice().sort(), ['n1', 'n2'], 'no duplicates from a repeated id')
  assert.deepEqual(got.removedIds, [], 'attach() clears removedIds, same as addItem')
})

test('addItems: an unknown collection id returns null rather than throwing', async () => {
  collections._reset()
  assert.equal(await collections.addItems('nope', ['n1']), null)
})

test('addItems: an empty batch is a no-op', async () => {
  collections._reset()
  const c = await collections.create({ name: 'Reads' })
  await collections.addItems(c.id, [])
  assert.deepEqual(collections.get(c.id).itemIds, [])
})

const canvasFor = (itemId) => ({
  nodes: [
    { id: 'item:' + itemId, type: 'item', itemId, x: 0, y: 0, width: 220, height: 100 },
    { id: 'n1', type: 'text', text: 'keep me', x: 300, y: 0, width: 220, height: 60 },
  ],
  edges: [{ id: 'e1', fromNode: 'item:' + itemId, toNode: 'n1' }],
})

test('update stores a canvas doc and null clears it', async () => {
  collections._reset()
  const c = await collections.create({ name: 'Board' })
  await collections.update(c.id, { canvas: canvasFor('n1') })
  assert.deepEqual(collections.get(c.id).canvas, canvasFor('n1'))
  await collections.update(c.id, { name: 'Renamed' })          // untouched by other patches
  assert.deepEqual(collections.get(c.id).canvas, canvasFor('n1'))
  await collections.update(c.id, { canvas: null })
  assert.equal('canvas' in collections.get(c.id), false)
})

test('removeItem prunes the card and its lines from the canvas', async () => {
  collections._reset()
  const c = await collections.create({ name: 'Board' })
  await collections.addItem(c.id, 'a')
  await collections.update(c.id, { canvas: canvasFor('a') })
  await collections.removeItem(c.id, 'a')
  assert.deepEqual(collections.get(c.id).canvas, {
    nodes: [{ id: 'n1', type: 'text', text: 'keep me', x: 300, y: 0, width: 220, height: 60 }],
    edges: [],
  })
})

test('deleteItemEverywhere prunes canvases in every collection that drew the item', async () => {
  collections._reset()
  const c1 = await collections.create({ name: 'One' })
  const c2 = await collections.create({ name: 'Two' })
  await collections.addItem(c1.id, 'a')
  await collections.update(c1.id, { canvas: canvasFor('a') })
  await collections.update(c2.id, { canvas: canvasFor('a') }) // drawn but never a member
  await collections.deleteItemEverywhere('a')
  assert.deepEqual(collections.get(c1.id).itemIds, [])
  assert.equal(collections.get(c1.id).canvas.nodes.length, 1)
  assert.equal(collections.get(c2.id).canvas.nodes.length, 1)
})
