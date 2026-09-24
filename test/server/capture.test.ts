// saveCapture is the single save path: one note written immediately, one
// enrichment job queued behind it. Both callers (the HTTP route and Telegram
// ingest) go through here, so these tests pin the shape both depend on.
//
// Mocks are installed before the subject is imported — mock.module only
// affects modules resolved after it runs.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

const added: Record<string, unknown>[] = []
const queued: { id: string; args: Record<string, unknown> }[] = []

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
    queueEnrich: (id: string, args: Record<string, unknown>) => queued.push({ id, args }),
  },
})
mock.module('../../server/lib/http.ts', {
  namedExports: {
    saveImage: async (dataUrl: string | null) =>
      dataUrl ? { webPath: '/uploads/x.png', absPath: '/tmp/x.png' } : null,
  },
})

const { saveCapture } = await import('../../server/capture.ts')

test('saveCapture: a URL becomes a pending link note and queues enrichment', async () => {
  added.length = 0
  queued.length = 0
  const note = await saveCapture({ text: 'https://example.com/a' })
  assert.equal(added[0].url, 'https://example.com/a')
  assert.equal(added[0].pending, true)
  assert.equal(queued.length, 1)
  assert.equal(queued[0].id, note.id)
  assert.equal(queued[0].args.isUrl, true)
})

test('saveCapture: plain text is not given a url', async () => {
  added.length = 0
  await saveCapture({ text: 'a thought' })
  assert.equal(added[0].url, null)
})

test('saveCapture: an image is stored and the note carries its web path', async () => {
  added.length = 0
  queued.length = 0
  await saveCapture({ text: '', image: 'data:image/png;base64,AAAA' })
  assert.equal(added[0].type, 'image')
  assert.equal(added[0].image, '/uploads/x.png')
  assert.equal(queued[0].args.hasImage, true)
  assert.equal(queued[0].args.absPath, '/tmp/x.png')
})

test('saveCapture: a demo visitor’s link is stamped as theirs, and an ordinary save is not', async () => {
  added.length = 0
  await saveCapture({ text: 'https://example.com/b', visitor: 'v1' })
  await saveCapture({ text: 'https://example.com/c' })
  assert.equal(added[0].visitor, 'v1')
  assert.ok(!('visitor' in added[1]), 'an ordinary install must write notes exactly as before')
})
