// Route-level tests for POST /api/notes/:id/retag. The retagNote() pipeline
// itself (marker-clearing, tag replacement, account tag) is already fully
// covered by test/enrich-retag.test.ts — this only checks the HTTP wiring:
// status codes and response shape.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mockRes } from '../../helpers/http.ts'
import { note } from '../../helpers/notes.ts'
import type { ServerNote } from '../../../server/types.ts'

let retagNoteImpl: (id: string) => Promise<ServerNote | null>

const realEnrich = await import('../../../server/ai/enrich.ts')
mock.module('../../../server/ai/enrich.ts', {
  namedExports: { ...realEnrich, retagNote: (id: string) => retagNoteImpl(id) },
})

const { handleRetagNote } = await import('../../../server/routes/notes.ts')

test('handleRetagNote: 200 with the updated note when retagNote succeeds', async () => {
  // The impl echoes the id it was handed, so the assertion below also pins
  // that the route forwards :id rather than retagging something else.
  retagNoteImpl = async id => note({ id, pending: true, tags: ['@natgeo'] })
  const { res, sent } = mockRes()
  await handleRetagNote(res, 'n1', null)
  assert.equal(sent.code, 200)
  assert.deepEqual(sent.json().note, note({ id: 'n1', pending: true, tags: ['@natgeo'] }))
})

test('handleRetagNote: 404 when the note does not exist', async () => {
  retagNoteImpl = async () => null
  const { res, sent } = mockRes()
  await handleRetagNote(res, 'does-not-exist', null)
  assert.equal(sent.code, 404)
  assert.equal(sent.json().error, 'note not found')
})
