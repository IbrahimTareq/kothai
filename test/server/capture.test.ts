// saveCapture is the single save path: one note written immediately, one
// enrichment job queued behind it. Both callers (the HTTP route and Telegram
// ingest) go through here, so these tests pin the shape both depend on.
//
// Mocks are installed before the subject is imported — mock.module only
// affects modules resolved after it runs.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

const added: Record<string, unknown>[] = []
const queued: { id: string; url: string }[] = []
const metaQueued: { id: string; url: string }[] = []

mock.module('../../server/data/notes.ts', {
  namedExports: {
    addNote: async (note: Record<string, unknown>) => {
      added.push(note)
      return { id: 'note-1', ...note }
    },
  },
})
mock.module('../../server/ai/enrich.ts', {
  namedExports: {
    queueEnrich: (id: string, url: string) => queued.push({ id, url }),
    queueLinkMeta: (id: string, url: string) => metaQueued.push({ id, url }),
  },
})

const { saveCapture } = await import('../../server/capture.ts')

test('saveCapture: a URL becomes a pending link note and queues enrichment', async () => {
  added.length = 0
  queued.length = 0
  const note = await saveCapture({ url: 'https://example.com/a' })
  assert.equal(added[0].type, 'link')
  assert.equal(added[0].url, 'https://example.com/a')
  assert.equal(added[0].pending, true)
  assert.deepEqual(queued, [{ id: note.id, url: 'https://example.com/a' }])
})

test('saveCapture: a link to a video host is saved as a video', async () => {
  added.length = 0
  await saveCapture({ url: 'https://youtu.be/abc123' })
  assert.equal(added[0].type, 'video')
})

test('saveCapture: a demo visitor’s link is stamped as theirs, and an ordinary save is not', async () => {
  added.length = 0
  await saveCapture({ url: 'https://example.com/b', visitor: 'v1' })
  await saveCapture({ url: 'https://example.com/c' })
  assert.equal(added[0].visitor, 'v1')
  assert.ok(!('visitor' in added[1]), 'an ordinary install must write notes exactly as before')
})

// The demo seeded its library through here with only the serial chain behind
// it, so each card's thumbnail waited out every earlier note's vision,
// classify and embed calls: over a minute before the demo's grid had images.
test('saveCapture: a link also goes to the fast metadata lane, so its thumbnail skips the model queue', async () => {
  metaQueued.length = 0
  const note = await saveCapture({ url: 'https://example.com/d' })
  assert.deepEqual(metaQueued, [{ id: note.id, url: 'https://example.com/d' }])
})
