// What a demo visitor may save: five links a day each, and a daily total
// across every visitor. The total is what actually bounds the inference bill —
// a visitor who clears their cookies is a new visitor with a fresh five.
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
const { demoLimits } = await import('../../../server/routes/demo.ts')
const { mockReq, mockRes } = await import('../../helpers/http.ts')

async function save(viewer: string | null, body: Record<string, unknown>) {
  const { res, sent } = mockRes()
  await handleSave(mockReq({ method: 'POST', body: JSON.stringify(body) }), res, viewer)
  return sent
}

beforeEach(() => {
  saved.length = 0
  demoLimits.save.reset()
})

test('a visitor can save five links a day, and then hears why not', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await save('a', { text: `https://example.com/${i}` })).code, 200)
  const sixth = await save('a', { text: 'https://example.com/6' })
  assert.equal(sixth.code, 429)
  assert.equal(sixth.json().code, 'demo_limit')
  assert.equal((await save('b', { text: 'https://example.com/b' })).code, 200, 'one visitor’s limit is not another’s')
})

test('a refused save does not use up the allowance', async () => {
  for (let i = 0; i < 3; i++) await save('a', { text: 'not a link' })
  for (let i = 0; i < 5; i++) assert.equal((await save('a', { text: `https://example.com/${i}` })).code, 200)
})

test('the daily total caps every visitor together', async () => {
  for (let v = 0; v < 40; v++)
    for (let i = 0; i < 5; i++) await save(`v${v}`, { text: `https://example.com/${v}/${i}` })
  assert.equal(saved.length, 200)
  assert.equal((await save('fresh', { text: 'https://example.com/fresh' })).code, 429)
})

test('an ordinary install has no limit', async () => {
  for (let i = 0; i < 7; i++) assert.equal((await save(null, { text: `https://example.com/${i}` })).code, 200)
})

test('what a visitor has left is also capped by the day’s total', async () => {
  for (let v = 0; v < 40; v++) for (let i = 0; i < 5; i++) demoLimits.save.take(`v${v}`)
  assert.equal(demoLimits.save.left('fresh'), 0)
  demoLimits.save.reset()
  assert.equal(demoLimits.save.left('fresh'), 5)
})
