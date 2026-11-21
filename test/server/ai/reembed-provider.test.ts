// Vectors from the removed on-device provider sit in another space than an
// endpoint's. This is the guard that rebuilds them, and the guard that stays
// quiet when nothing changed — a spurious re-embed of a large library is
// expensive.
//
// The pure predicate is tested on its own; the queueing function gets the
// same harness reembed-recipe.test.ts uses, because the decisions worth
// protecting are the ones about the marker, not the return value. Recording
// the marker too eagerly strands a library that still owes a sweep; recording
// it too late (or never) re-embeds the library on every boot.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { note } from '../../helpers/notes.ts'
import type { NoteRecord } from '../../../server/data/notes.ts'
import type { SettingsPatch } from '../../../server/data/settings.ts'
import type { Role } from '../../../server/ai/roles.ts'
import { RemoteError } from '../../../server/ai/providers/remote-http.ts'

let notes: NoteRecord[] = []
let embedCalls: { text: string; markerNow: string | null }[] = []
let enabledImpl = (): Record<Role, boolean> => ({ llm: true, embed: true, vision: true })
let storedProvider: string | null = null
let savedPatches: SettingsPatch[] = []
// What the next embed call throws, by input text; null embeds normally.
let failWith: (text: string) => Error | null = () => null

const realStore = await import('../../../server/data/notes.ts')
const realTags = await import('../../../server/data/tags.ts')
const realTagvocab = await import('../../../server/data/tagvocab.ts')
const realNormalise = await import('../../../server/ai/normalise.ts')
const realCollections = await import('../../../server/data/collections.ts')
const realSettings = await import('../../../server/data/settings.ts')

mock.module('../../../server/data/notes.ts', {
  namedExports: {
    ...realStore,
    allNotes: () => notes,
    getNote: (id: string) => notes.find(n => n.id === id) ?? null,
    count: () => notes.length,
    updateNote: async (id: string, patch: Partial<NoteRecord>) => {
      const n = notes.find(x => x.id === id)
      if (n) Object.assign(n, patch)
      return n
    },
    flush: async () => {},
  },
})
mock.module('../../../server/data/tags.ts', { namedExports: { ...realTags, buildVocabulary: () => [] } })
// Stubbed for the reason reembed-recipe.test.ts gives: the real registry
// reseed opens the on-disk database, and the slower sweep let one test's
// marker write land after the next test had reset it.
mock.module('../../../server/data/tagvocab.ts', {
  namedExports: {
    ...realTagvocab,
    canonicalize: async (t: string[]) => t,
    clearAll: async () => 0,
    rebuildFromNotes: async () => {},
  },
})
mock.module('../../../server/ai/index.ts', {
  namedExports: {
    roleEnabled: (role: Role) => enabledImpl()[role],
    ...realNormalise,
    classify: async () => ({ type: 'link', category: 'General', title: 'T', summary: 'S', tags: [] }),
    // Each call records the marker as it stands mid-sweep, so the test can see
    // whether the new value was written before the vectors it describes exist.
    embedText: async (text: string) => {
      embedCalls.push({ text, markerNow: storedProvider })
      const failure = failWith(text)
      if (failure) throw failure
      return [text.length]
    },
  },
})
mock.module('../../../server/data/collections.ts', { namedExports: { ...realCollections, autoAdd: async () => {} } })
mock.module('../../../server/data/settings.ts', {
  namedExports: {
    ...realSettings,
    getEmbedRecipe: () => 'recipe-current',
    getEmbedProvider: () => storedProvider,
    save: async (patch: SettingsPatch) => {
      savedPatches.push(patch)
      if (patch.embedProvider !== undefined) storedProvider = patch.embedProvider
      return {}
    },
  },
})

const enrich = await import('../../../server/ai/enrich.ts')
const reembed = await import('../../../server/ai/reembed.ts')

const NOTE: NoteRecord = note({
  id: 'n1',
  title: 'Brown butter pasta',
  summary: 'A ten minute recipe.',
  content: 'text',
  tags: ['pasta'],
})

function reset(list: NoteRecord[] = [], marker: string | null = null) {
  notes = list.map(n => ({ ...n }))
  embedCalls = []
  savedPatches = []
  failWith = () => null
  storedProvider = marker
  enabledImpl = () => ({ llm: true, embed: true, vision: true })
}

const drain = () => enrich.queueJob(() => {})

test('only vectors marked as coming from an endpoint are current', () => {
  assert.equal(reembed.embedProviderChanged('remote'), false)
  assert.equal(reembed.embedProviderChanged('local'), true, 'vectors from the removed on-device provider')
  assert.equal(reembed.embedProviderChanged(null), true, 'an install that predates the marker')
})

test('with the embed role off, nothing is queued AND no marker is written', async () => {
  reset([NOTE], 'local')
  enabledImpl = () => ({ llm: false, embed: false, vision: false })

  assert.equal(reembed.queueEmbedProviderReembed(), false)
  await drain()
  assert.equal(embedCalls.length, 0)
  assert.equal(storedProvider, 'local', 'recording a provider the role never embedded with would strand the library')
  assert.deepEqual(savedPatches, [], 'the role being off is not evidence of anything worth recording')

  // Role switched back on: the old marker means the change is still owed.
  enabledImpl = () => ({ llm: true, embed: true, vision: true })
  assert.equal(reembed.queueEmbedProviderReembed(), true)
  // Undrained, this sweep finished inside the next test and wrote its marker
  // over that test's reset — once the sweep grew a registry reseed step.
  await drain()
})

test('vectors already from an endpoint queue nothing and leave the marker alone', async () => {
  reset([NOTE], 'remote')

  assert.equal(reembed.queueEmbedProviderReembed(), false)
  await drain()
  assert.equal(embedCalls.length, 0)
  assert.equal(storedProvider, 'remote')
  assert.deepEqual(savedPatches, [], 'the marker already says the right thing')
})

test('an empty library records the endpoint without sweeping', async () => {
  reset([], 'local')

  assert.equal(reembed.queueEmbedProviderReembed(), false)
  await drain()
  assert.equal(embedCalls.length, 0)
  assert.equal(storedProvider, 'remote', 'a fresh install must not be told it owes a re-embed on every boot')
})

test('a library of on-device vectors is re-embedded, and the marker moves only afterwards', async () => {
  reset([NOTE, { ...NOTE, id: 'n2' }], 'local')

  assert.equal(reembed.queueEmbedProviderReembed(), true)
  assert.equal(storedProvider, 'local', 'the marker must not move before the job has even run')
  await drain()

  assert.equal(embedCalls.length, 2)
  assert.ok(
    embedCalls.every(c => c.markerNow === 'local'),
    'a marker written mid-sweep would claim vectors that do not exist yet if the process died',
  )
  assert.equal(storedProvider, 'remote')
})

// Connecting an endpoint or naming an embedding model in Settings re-embeds a
// QVAC library at runtime. The marker stayed 'local' afterwards, so the next
// boot queued a second full re-embed through a possibly paid endpoint.
test('a Settings-triggered re-embed marks the vectors remote, so the next boot queues nothing', async () => {
  reset([NOTE], 'local')

  await reembed.reembedAll('embedding endpoint changed')
  assert.equal(storedProvider, 'remote')

  embedCalls = []
  assert.equal(reembed.queueEmbedProviderReembed(), false, 'the boot after finds nothing owed')
  await drain()
  assert.equal(embedCalls.length, 0)
})

// Embed failures in a sweep come in two kinds, and treating them alike broke
// the library both ways. A note the endpoint refuses (400) is that note's
// problem: blocking the markers on it re-swept the whole library every boot
// and never converged. A down endpoint is everyone's: marking the library
// rebuilt anyway labelled on-device vectors 'remote', ranked against the
// endpoint's query vectors from then on.
const rejected = () => new RemoteError('bad_request', 'Endpoint rejected the request (400).', { transient: false })
const down = () => new RemoteError('endpoint_error', 'Endpoint returned 503.', { transient: true })

test('a note the endpoint rejects loses its old vector, and the rest of the sweep finishes', async () => {
  const bad = { ...NOTE, id: 'bad', title: 'Rejected', embedding: [9, 9] }
  reset([NOTE, bad, { ...NOTE, id: 'n3' }], 'local')
  failWith = text => (text === reembed.embedBodyFor(bad) ? rejected() : null)
  const quiet = mock.method(console, 'error', () => {})

  await reembed.reembedAll('embedding endpoint changed')
  quiet.mock.restore()
  assert.equal(embedCalls.length, 3, 'the notes after it are still embedded')
  assert.equal(
    notes.find(n => n.id === 'bad')?.embedding,
    null,
    'an on-device vector left on it would be ranked against remote queries',
  )
  assert.equal(storedProvider, 'remote')
})

test('an endpoint going down mid-sweep stops it and leaves the markers, so the next boot retries', async () => {
  reset([NOTE, { ...NOTE, id: 'n2', title: 'Second' }, { ...NOTE, id: 'n3', title: 'Third' }], 'local')
  failWith = () => (embedCalls.length === 2 ? down() : null)
  const quiet = mock.method(console, 'error', () => {})

  await reembed.reembedAll('embedding endpoint changed')
  quiet.mock.restore()
  assert.equal(embedCalls.length, 2, 'the rest of the library is not sent at a down endpoint')
  assert.equal(storedProvider, 'local')
  assert.ok(savedPatches.every(p => p.embedProvider === undefined))
  // Cleared, not kept: a library already 'remote' whose model changed has no
  // other marker saying it still owes a sweep.
  assert.ok(savedPatches.some(p => p.embedRecipe === null))
  assert.equal(reembed.queueEmbedProviderReembed(), true)
  failWith = () => null
  await drain()
})

test('every note rejected is the model, not the notes: no vector is cleared and no marker moves', async () => {
  reset(
    [
      { ...NOTE, embedding: [1] },
      { ...NOTE, id: 'n2', title: 'Second', embedding: [2] },
    ],
    'local',
  )
  failWith = () => rejected()
  const quiet = mock.method(console, 'error', () => {})

  await reembed.reembedAll('embedding endpoint changed')
  quiet.mock.restore()
  assert.deepEqual(
    notes.map(n => n.embedding),
    [[1], [2]],
  )
  assert.equal(storedProvider, 'local')
  assert.ok(savedPatches.some(p => p.embedRecipe === null))
})
// A note with no text has nothing to embed, and never will: counting it as a
// failure would keep the marker stale and re-embed the library on every boot.
test('a note with nothing to embed does not hold the marker back', async () => {
  reset([NOTE, note({ id: 'empty', title: '', summary: '', content: '', tags: [] })], 'local')

  await reembed.reembedAll('embedding endpoint changed')
  assert.equal(embedCalls.length, 1)
  assert.equal(storedProvider, 'remote')
})
