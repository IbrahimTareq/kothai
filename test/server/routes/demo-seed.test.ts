// A fresh demo deploy has to be a working demo with nothing done by hand: the
// demo refuses /api/setup, so a visitor could never finish the first-run
// screen, and an empty library shows them nothing to ask about. So boot picks
// the endpoint's preset models and seeds the shared library.
//
// The data dir is a temp one, set before the dynamic imports because
// server/config.ts freezes it at import time. The settings store keeps its
// state for the life of the process, so the model tests below run in order.
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

process.env.KOTHAI_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'kothai-demo-seed-'))

// saveCapture is where a save's real work starts, so standing it in keeps the
// AI pipeline and the network out of these tests.
const saved: string[] = []
mock.module('../../../server/capture.ts', {
  namedExports: {
    saveCapture: async ({ text }: { text: string }) => {
      saved.push(text)
      return { id: String(saved.length) }
    },
  },
})

const store = await import('../../../server/data/notes.ts')
const settings = await import('../../../server/data/settings.ts')
const { configureDemo, seedDemo } = await import('../../../server/routes/demo.ts')

test('an empty demo library is seeded with every save in the list, in order', async () => {
  store._reset()
  saved.length = 0
  await seedDemo()
  assert.equal(saved[0], 'https://en.wikipedia.org/wiki/Spirited_Away')
  assert.match(saved[saved.length - 1], /^Sourdough notes:/, 'the last line is the first card a visitor sees')
  assert.ok(
    saved.every(s => s.trim() && !s.startsWith('#')),
    'comments and blank lines are not saves',
  )
})

test('a demo library that already holds notes is left alone', async () => {
  store._reset()
  await store.addNote({ type: 'text', content: 'already here' })
  saved.length = 0
  await seedDemo()
  assert.equal(saved.length, 0)
})

test('an endpoint with no preset is left for the operator to set up', async () => {
  await settings.load()
  process.env.KOTHAI_AI_BASE_URL = 'https://example.com/v1'
  await configureDemo()
  assert.equal(settings.getRemote().llm, '')
})

test('a demo on a known endpoint takes that endpoint’s preset models', async () => {
  process.env.KOTHAI_AI_BASE_URL = 'https://openrouter.ai/api/v1'
  await configureDemo()
  assert.equal(settings.isConfigured(), true)
  assert.deepEqual(settings.getRemote(), {
    llm: 'openai/gpt-4o-mini',
    embed: 'openai/text-embedding-3-small',
    vision: 'openai/gpt-4o-mini',
  })
})

test('models an operator already chose are kept', async () => {
  process.env.KOTHAI_AI_BASE_URL = 'https://api.openai.com/v1'
  await configureDemo()
  assert.equal(
    settings.getRemote().llm,
    'openai/gpt-4o-mini',
    'must not be replaced by the OpenAI preset’s gpt-4o-mini',
  )
})
