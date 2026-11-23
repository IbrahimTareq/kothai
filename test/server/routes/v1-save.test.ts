// POST /api/v1/save: the share-extension path. A fresh note per call, with the
// optional note stored as the note's own mindNote.
//
// Enrichment is stubbed: a queued job would reach for the network and the model.
// Mocks are installed before the subject is imported.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

mock.module('../../../server/ai/enrich.ts', {
  namedExports: { queueEnrich: () => {}, queueLinkMeta: () => {} },
})

const store = await import('../../../server/data/notes.ts')
const { handleSaveV1 } = await import('../../../server/routes/v1.ts')
const { demoLimits } = await import('../../../server/routes/demo.ts')
const { mockReq, mockRes } = await import('../../helpers/http.ts')

async function save(body: unknown, viewer: string | null = null) {
  const { res, sent } = mockRes()
  await handleSaveV1(mockReq({ method: 'POST', body: JSON.stringify(body) }), res, viewer)
  return sent
}

test('saves a link and its note', async () => {
  store._reset()
  const sent = await save({ url: 'https://example.com/a', note: 'read this on the train' })
  assert.equal(sent.code, 200)
  const note = sent.json().note as Record<string, unknown>
  assert.equal(note.url, 'https://example.com/a')
  assert.equal(note.mindNote, 'read this on the train')
  assert.equal(store.getNote(note.id as string)?.mindNote, 'read this on the train')
})

test('the note is clipped to 4000 characters, as a mindNote edit is', async () => {
  store._reset()
  const sent = await save({ url: 'https://example.com/b', note: 'x'.repeat(5000) })
  assert.equal((sent.json().note as Record<string, unknown>).mindNote, 'x'.repeat(4000))
})

test('a save without a note writes no mindNote', async () => {
  store._reset()
  const sent = await save({ url: 'https://example.com/c' })
  assert.equal(sent.code, 200)
  assert.equal((sent.json().note as Record<string, unknown>).mindNote, undefined)
})

test('a non-link is 400 links_only', async () => {
  store._reset()
  for (const body of [{ url: 'not a link' }, {}, { url: 5 }, 'nope']) {
    const sent = await save(body)
    assert.equal(sent.code, 400)
    assert.equal(sent.json().code, 'links_only')
  }
  assert.equal(store.allNotes().length, 0)
})

test('on the demo, a visitor past the daily limit is 429 demo_limit', async () => {
  store._reset()
  demoLimits.save.reset()
  let sent = await save({ url: 'https://example.com/d' }, 'v1')
  for (let i = 0; i < 10 && sent.code === 200; i++) sent = await save({ url: `https://example.com/d${i}` }, 'v1')
  assert.equal(sent.code, 429)
  assert.equal(sent.json().code, 'demo_limit')
  demoLimits.save.reset()
})
