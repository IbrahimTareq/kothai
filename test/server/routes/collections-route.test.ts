// POST/PATCH /api/collections — a space's description and where it sits. The
// body is whatever the client posted, so the route owns trimming, the length
// cap, and what clearing the field means.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mockReq, mockRes, records } from '../../helpers/http.ts'

const collections = await import('../../../server/data/collections.ts')
const { handleCreateCollection, handleUpdateCollection } = await import('../../../server/routes/collections.ts')

async function create(body: Record<string, unknown>) {
  const { res, sent } = mockRes()
  await handleCreateCollection(mockReq({ method: 'POST', body: JSON.stringify(body) }), res, null)
  return sent
}

async function patch(id: string, body: Record<string, unknown>) {
  const { res, sent } = mockRes()
  await handleUpdateCollection(mockReq({ method: 'PATCH', body: JSON.stringify(body) }), res, id, null)
  return sent
}

test('sets a trimmed, capped description and clears it when emptied', async () => {
  collections._reset()
  const { id } = await collections.create({ name: 'Trip' })

  assert.equal((await patch(id, { description: '  Places for March  ' })).code, 200)
  assert.equal(collections.get(id)?.description, 'Places for March')

  await patch(id, { description: 'x'.repeat(1000) })
  assert.equal(collections.get(id)?.description?.length, 500)

  // Blank is how the client clears it, rather than storing ''.
  assert.equal((await patch(id, { description: '   ' })).code, 200)
  assert.equal(collections.get(id)?.description, undefined)
})

test('a description alone is an update, not "nothing to update"', async () => {
  collections._reset()
  const { id } = await collections.create({ name: 'Trip' })
  const sent = await patch(id, { description: 'why' })
  assert.equal(sent.code, 200)
  assert.equal(collections.get(id)?.name, 'Trip')
})

test('a space can be made inside another, and lifted back to the top level', async () => {
  collections._reset()
  const travel = await collections.create({ name: 'Travel' })
  const made = await create({ name: 'Japan', parentId: travel.id })
  assert.equal(made.code, 200)
  const id = String(records([made.json().collection])[0].id)
  assert.equal(collections.get(id)?.parentId, travel.id)
  assert.equal((await patch(id, { parentId: null })).code, 200)
  assert.equal(collections.get(id)?.parentId, undefined)
})

// The name rides along so the request is a valid update without the parent:
// a bare { parentId } answered 400 "nothing to update" before parentId existed,
// and would have passed this test for the wrong reason.
test('a parent that is missing, not an id, or inside the space is refused', async () => {
  collections._reset()
  const travel = await collections.create({ name: 'Travel' })
  const asia = await collections.create({ name: 'Asia', parentId: travel.id })
  const japan = await collections.create({ name: 'Japan', parentId: asia.id })
  const bad: [string, unknown][] = [
    ['itself', travel.id],
    ['its grandchild', japan.id],
    ['a missing space', 'nope'],
    ['not an id', 42],
  ]
  for (const [label, parentId] of bad) {
    assert.equal((await patch(travel.id, { name: 'Renamed', parentId })).code, 400, label)
  }
  assert.equal(collections.get(travel.id)?.name, 'Travel', 'a refused move changes nothing else either')
  assert.equal(collections.get(travel.id)?.parentId, undefined)
  assert.equal((await create({ name: 'Kyoto', parentId: 'nope' })).code, 400)
})
