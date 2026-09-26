// Tests for server/routes/duplicates.ts — links saved more than once.
//
// Only the importer refuses a link that is already saved; /api/save and
// Telegram store whatever arrives, so the same link pasted twice is two notes.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mockRes, records, text } from '../../helpers/http.ts'
import { note } from '../../helpers/notes.ts'
import type { ServerNote } from '../../../server/types.ts'

let notes: ServerNote[] = []

const realStore = await import('../../../server/data/notes.ts')
mock.module('../../../server/data/notes.ts', {
  namedExports: { ...realStore, allNotes: () => notes.map(n => ({ ...n })) },
})

const { handleDuplicates } = await import('../../../server/routes/duplicates.ts')

function groups() {
  const { res, sent } = mockRes()
  handleDuplicates(res)
  assert.equal(sent.code, 200)
  const body = sent.json().groups
  assert.ok(Array.isArray(body))
  return body.map(g => records(g).map(n => text(n.id)))
}

test('the same link under tracking noise and www is one group, oldest first', () => {
  notes = [
    note({ id: 'b', url: 'https://www.instagram.com/reel/AAA/?igsh=x', createdAt: '2026-02-01T00:00:00.000Z' }),
    note({ id: 'a', url: 'https://instagram.com/p/AAA/', createdAt: '2026-01-01T00:00:00.000Z' }),
    note({ id: 'c', url: 'https://example.com/other' }),
  ]
  assert.deepEqual(groups(), [['a', 'b']])
})

test('a note without a link is never a duplicate, and distinct queries stay distinct', () => {
  notes = [
    note({ id: 'a', url: null }),
    note({ id: 'b', url: null }),
    note({ id: 'c', url: 'https://youtube.com/watch?v=AAA' }),
    note({ id: 'd', url: 'https://youtube.com/watch?v=BBB' }),
  ]
  assert.deepEqual(groups(), [])
})
