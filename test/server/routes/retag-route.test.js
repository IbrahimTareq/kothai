// Route-level tests for POST /api/notes/:id/retag. The retagNote() pipeline
// itself (marker-clearing, tag replacement, account tag) is already fully
// covered by test/enrich-retag.test.js — this only checks the HTTP wiring:
// status codes and response shape.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

let retagNoteImpl

const realEnrich = await import('../../../server/ai/enrich.js')
mock.module('../../../server/ai/enrich.js', {
  namedExports: { ...realEnrich, retagNote: (id) => retagNoteImpl(id) },
})

const { handleRetagNote } = await import('../../../server/routes/notes.js')

function mockRes() {
  const r = { code: 0, body: null }
  r.writeHead = (c) => { r.code = c; return r }
  r.end = (s) => { r.body = JSON.parse(s) }
  r.setHeader = () => {}
  return r
}

test('handleRetagNote: 200 with the updated note when retagNote succeeds', async () => {
  retagNoteImpl = async (id) => ({ id, pending: true, tags: ['@natgeo'] })
  const res = mockRes()
  await handleRetagNote(res, 'n1')
  assert.equal(res.code, 200)
  assert.deepEqual(res.body.note, { id: 'n1', pending: true, tags: ['@natgeo'] })
})

test('handleRetagNote: 404 when the note does not exist', async () => {
  retagNoteImpl = async () => null
  const res = mockRes()
  await handleRetagNote(res, 'does-not-exist')
  assert.equal(res.code, 404)
  assert.equal(res.body.error, 'note not found')
})
