// PATCH /api/collections/:id — a space's description. The body is whatever the
// client posted, so the route owns trimming, the length cap, and what clearing
// the field means.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mockReq, mockRes } from '../../helpers/http.ts'

const collections = await import('../../../server/data/collections.ts')
const { handleUpdateCollection } = await import('../../../server/routes/collections.ts')

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
