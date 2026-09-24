// Kothai saves links only. The capture box already refuses anything else, so
// this is the rule for a client that skipped it — and it holds on an ordinary
// install, not just on the demo where it began.
import { test, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// saveCapture is where a save's real work starts (the note row and its
// enrichment job), so standing it in keeps the AI pipeline out of these tests.
const saved: string[] = []
mock.module('../../../server/capture.ts', {
  namedExports: {
    saveCapture: async ({ url }: { url: string }) => {
      saved.push(url)
      return { id: String(saved.length), url }
    },
  },
})

const { handleSave } = await import('../../../server/routes/notes.ts')
const { mockReq, mockRes } = await import('../../helpers/http.ts')

async function save(body: Record<string, unknown>) {
  const { res, sent } = mockRes()
  await handleSave(mockReq({ method: 'POST', body: JSON.stringify(body) }), res, null)
  return sent
}

beforeEach(() => {
  saved.length = 0
})

test('a link is saved', async () => {
  const sent = await save({ text: '  https://example.com/a  ' })
  assert.equal(sent.code, 200)
  assert.deepEqual(saved, ['https://example.com/a'])
})

test('plain text, code and an image are refused, and nothing is saved', async () => {
  for (const body of [
    { text: 'a thought' },
    { text: 'const x = 1;' },
    { text: '', image: 'data:image/png;base64,AAAA' },
    { text: 'check out https://example.com' },
  ]) {
    const sent = await save(body)
    assert.equal(sent.code, 400, JSON.stringify(body))
    assert.equal(sent.json().code, 'links_only')
  }
  assert.deepEqual(saved, [])
})
