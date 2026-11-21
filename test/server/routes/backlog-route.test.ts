// GET /api/enrich/backlog. The Settings Enrichment row reads both the backlog
// count and the queue's current run from this one response.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mockRes } from '../../helpers/http.ts'
import { note } from '../../helpers/notes.ts'

const realNotes = await import('../../../server/data/notes.ts')
const realAi = await import('../../../server/ai/index.ts')

mock.module('../../../server/data/notes.ts', { namedExports: { ...realNotes, allNotes: () => [note()] } })
mock.module('../../../server/ai/index.ts', {
  namedExports: { ...realAi, roleEnabled: (role: string) => role !== 'vision' },
})
mock.module('../../../server/ai/queue.ts', {
  namedExports: { queueJob: async () => {}, queueProgress: () => ({ done: 2, total: 5 }) },
})

const { handleBacklog } = await import('../../../server/routes/enrich.ts')

test('reports the backlog count alongside the queue run', () => {
  const { res, sent } = mockRes()
  handleBacklog(res)
  assert.equal(sent.code, 200)
  assert.deepEqual(sent.json(), { count: 1, done: 2, total: 5 })
})
