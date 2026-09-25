// A fresh demo deploy has to be a working demo with nothing done by hand: the
// demo refuses /api/setup, so a visitor could never finish the first-run
// screen, and an empty library shows them nothing to ask about. So boot picks
// the endpoint's preset models and seeds the shared library.
//
// The data dir is a temp one, set before the dynamic imports because
// server/config.ts freezes it at import time. The settings store keeps its
// state for the life of the process, so the model tests below run in order.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

process.env.KOTHAI_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'kothai-demo-seed-'))

// saveCapture is where a save's real work starts, so standing it in keeps the
// AI pipeline and the network out of these tests. It still adds the bare note,
// as the real one does before any of that work, so the seed can find it.
const saved: string[] = []
mock.module('../../../server/capture.ts', {
  namedExports: {
    saveCapture: async ({ url }: { url: string }) => {
      saved.push(url)
      return (await import('../../../server/data/notes.ts')).addNote({ type: 'link', content: url, url })
    },
  },
})

const store = await import('../../../server/data/notes.ts')
const settings = await import('../../../server/data/settings.ts')
const tagvocab = await import('../../../server/data/tagvocab.ts')
const collections = await import('../../../server/data/collections.ts')
const { UPLOAD_DIR } = await import('../../../server/config.ts')
const { EMBED_RECIPE } = await import('../../../server/ai/prompts.ts')
const { configureDemo, seedDemo } = await import('../../../server/routes/demo.ts')

// A snapshot directory that does not exist: live seeding, as on a checkout
// that has not built one.
const NONE = pathToFileURL(path.join(os.tmpdir(), 'kothai-no-demo-snapshot/'))

test('an empty demo library is seeded with every save in the list, in order', async () => {
  store._reset()
  saved.length = 0
  await seedDemo({ snapshot: NONE })
  assert.equal(saved[0], 'https://en.wikipedia.org/wiki/Spirited_Away')
  assert.equal(
    saved[saved.length - 1],
    'https://en.wikipedia.org/wiki/Sourdough',
    'the last line is the first card a visitor sees',
  )
  // Kothai saves links only, so a line that is not one would seed a card
  // nothing can render.
  assert.ok(
    saved.every(s => /^https?:\/\/\S+$/.test(s)),
    'every save is a link — no comments, blank lines or plain-text notes',
  )
})

// Spaces opened on "No spaces yet" and Ask had nothing to show a space or its
// canvas with, until a visitor had made one and found links to put in it.
test('an empty demo library comes with its shared spaces, each holding its links', async () => {
  store._reset()
  collections._reset()
  await seedDemo({ snapshot: NONE })
  const spaces = collections.all()
  assert.deepEqual(
    spaces.map(c => c.name),
    ['Kyoto trip', 'Weekend baking', 'Design reading'],
  )
  assert.ok(
    spaces.every(c => !c.visitor),
    'shared, so every visitor sees them and the nightly reset keeps them',
  )
  const links = spaces.flatMap(c => c.itemIds.map(id => store.getNote(id)?.url))
  // 5 + 6 + 4: a link mistyped in the list would quietly leave its space short.
  assert.equal(links.length, 15)
  assert.ok(links.every(u => u && LIBRARY.includes(u)))
})

// It had never been built, and nothing said so: every deploy seeded live on
// the operator's key while the log stayed quiet.
test('a demo with no prebuilt library says so in the log', async () => {
  store._reset()
  collections._reset()
  const warn = mock.method(console, 'warn', () => {})
  await seedDemo({ snapshot: NONE })
  warn.mock.restore()
  assert.match(String(warn.mock.calls[0]?.arguments[0]), /no prebuilt library/)
})

test('a demo library that already holds notes is left alone', async () => {
  store._reset()
  await store.addNote({ type: 'link', content: 'already here' })
  saved.length = 0
  await seedDemo({ snapshot: NONE })
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

// ---- the prebuilt library ------------------------------------------------------
// With no volume, every deploy seeded from nothing: every link fetched, and a
// classify, a vision call and an embed per note, before a visitor saw a
// finished card. scripts/demo-snapshot.ts builds the finished library once;
// boot restores it. These run after the model tests above, so the settings
// hold the OpenRouter preset's embedding model.
const LIBRARY = readFileSync(new URL('../../../server/demo-library.txt', import.meta.url), 'utf8')
const b64 = (v: number[]) => Buffer.from(Float32Array.from(v).buffer).toString('base64')

function snapshot(over: Record<string, unknown> = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kothai-demo-snapshot-'))
  mkdirSync(path.join(dir, 'uploads'))
  writeFileSync(path.join(dir, 'uploads', 'meta-s2.jpg'), 'jpeg bytes')
  const older = { id: 's1', createdAt: '2026-01-01T00:00:00.000Z', type: 'link', url: 'https://a.example/' }
  const newer = { id: 's2', createdAt: '2026-01-02T00:00:00.000Z', type: 'link', url: 'https://b.example/' }
  const built = {
    library: LIBRARY,
    embed: 'openai/text-embedding-3-small',
    recipe: EMBED_RECIPE,
    notes: [
      { ...older, title: 'Older', tags: ['recipes'], embedding: b64([1, 0, 0]) },
      { ...newer, title: 'Newer', tags: ['travel'], thumb: '/uploads/meta-s2.jpg', embedding: b64([0, 1, 0]) },
    ],
    tags: { recipes: b64([1, 0, 0]), travel: b64([0, 1, 0]) },
  }
  writeFileSync(path.join(dir, 'library.json'), JSON.stringify({ ...built, ...over }))
  return pathToFileURL(`${dir}/`)
}

test('a prebuilt library is restored as built: no save queued, no model asked', async () => {
  store._reset()
  tagvocab._reset()
  saved.length = 0
  await seedDemo({ snapshot: snapshot() })
  assert.equal(saved.length, 0)
  assert.deepEqual(
    store.allNotes().map(n => n.id),
    ['s2', 's1'],
    'newest first, as it was built',
  )
  assert.equal(store.getNote('s2')?.thumb, '/uploads/meta-s2.jpg')
  assert.ok(existsSync(path.join(UPLOAD_DIR, 'meta-s2.jpg')), 'its thumbnail is copied into uploads')
  assert.equal(tagvocab.size(), 2, 'the tag registry comes with it, so a visitor’s tags snap to the seed’s')
  const [top] = store.hybridSearch([1, 0, 0], 'zzz')
  assert.equal(top?.id, 's1', 'the vectors survived, so Ask can retrieve by them')
})

// Each of these would restore a library whose vectors or contents no longer
// match what boot would build, so a stale snapshot seeds live instead.
test('a prebuilt library from another list, embedding model or recipe is passed over for a live seed', async () => {
  for (const stale of [{ library: 'https://old.example/\n' }, { embed: 'text-embedding-3-large' }, { recipe: 'v1' }]) {
    store._reset()
    saved.length = 0
    await seedDemo({ snapshot: snapshot(stale) })
    assert.equal(store.getNote('s1'), null, `nothing restored for ${JSON.stringify(stale)}`)
    assert.ok(saved.length > 0, `seeded live for ${JSON.stringify(stale)}`)
  }
})
