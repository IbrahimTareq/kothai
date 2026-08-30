// Tests for enrich.js's Instagram off-chain pipeline: queueIgMeta (its own
// FIFO, separate from the main enrichChain) and reclassifyWithCaption (the
// follow-up classify/embed pass once a caption lands). This is the riskiest
// new code from the Instagram-import review round — two real bugs
// (metaFetched write-order clobber, caption never reaching classify/embed)
// were found here — so these tests reproduce the exact scenarios that
// exposed them, plus the failure-isolation and no-loop guarantees.
//
// Every module enrich.js touches is mocked via node:test's mock.module
// (requires --experimental-test-module-mocks, wired into `pnpm test`) so
// this runs with zero network I/O and zero real model calls — classify/embed
// are just plain stub functions, and the "store" is an in-memory array that
// mirrors real updateNote's `Object.assign(note, patch)` shallow merge
// exactly, since that merge semantics is what MUST FIX A's bug depended on.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

const IG_URL = 'https://www.instagram.com/p/AAA111/'

// ---- in-memory fake store, mirroring notes.js's real merge semantics ----
let notes
function seedNotes(list) {
  notes = list.map((n) => ({ ...n }))
}
function fakeAllNotes() {
  return notes
}
async function fakeUpdateNote(id, patch) {
  const n = notes.find((x) => x.id === id)
  if (!n) return null
  Object.assign(n, patch) // exactly server/data/notes.js's real updateNote
  return n
}

// ---- swappable stub implementations, reconfigured per test ----
let fetchLinkMetaImpl
let classifyImpl
let embedTextImpl
let describeImageImpl
let residencyImpl
let fetchLinkMetaCalls
let classifyCalls
let classifyArgs
let embedCalls
let autoAddCalls
let describeImageCalls

function reset() {
  seedNotes([])
  fetchLinkMetaCalls = []
  classifyCalls = []
  classifyArgs = []
  embedCalls = []
  autoAddCalls = []
  describeImageCalls = []
  fetchLinkMetaImpl = async () => ({ siteTitle: null, siteDesc: null, siteName: 'Instagram', thumb: null })
  classifyImpl = async ({ text }) => ({ type: 'link', category: 'General', title: 'T', summary: 'S', tags: [] })
  embedTextImpl = async () => [0, 0, 0]
  describeImageImpl = async () => 'default thumbnail description' // benign, distinct string a test can assert against or ignore
  residencyImpl = () => ({ llm: 'ondemand', embed: 'always', vision: 'ondemand' })
}
reset()

const realMeta = await import('../../../server/ai/meta.js')
const realStore = await import('../../../server/data/notes.js')
const realTags = await import('../../../server/lib/tags.js')
const realTagvocab = await import('../../../server/data/tagvocab.js')
const realNormalise = await import('../../../server/ai/normalise.js')
const realCollections = await import('../../../server/data/collections.js')
const realSettings = await import('../../../server/data/settings.js')

mock.module('../../../server/ai/meta.js', {
  namedExports: { ...realMeta, fetchLinkMeta: async (url, id) => { fetchLinkMetaCalls.push(url); return fetchLinkMetaImpl(url, id) } },
})
mock.module('../../../server/data/notes.js', {
  namedExports: { ...realStore, allNotes: () => fakeAllNotes(), updateNote: (id, patch) => fakeUpdateNote(id, patch) },
})
mock.module('../../../server/lib/tags.js', { namedExports: { ...realTags, buildVocabulary: () => [] } })
mock.module('../../../server/data/tagvocab.js', { namedExports: { ...realTagvocab, canonicalize: async (tags) => tags } })
mock.module('../../../server/ai/index.js', {
  namedExports: {
    ...realNormalise,
    classify: (args) => { classifyCalls.push(args.text); classifyArgs.push(args); return classifyImpl(args) },
    embedText: (text) => { embedCalls.push(text); return embedTextImpl(text) },
    describeImage: (args) => { describeImageCalls.push(args); return describeImageImpl(args) },
  },
})
mock.module('../../../server/data/collections.js', {
  namedExports: { ...realCollections, autoAdd: async (id, tags) => { autoAddCalls.push({ id, tags }) } },
})
mock.module('../../../server/data/settings.js', { namedExports: { ...realSettings, getResidency: () => residencyImpl() } })

const enrich = await import('../../../server/ai/enrich.js')

// queueIgMeta used to return the igChain promise so a test could just await
// it to know the job had landed. It's now a fire-and-forget push onto a
// deque (see enrich.js's _igQueueState) — nothing in production awaits it,
// so instead poll until the deque is both empty AND not mid-job. pumpIg()
// sets `pumping` synchronously before its first await, so there's no race
// between calling queueIgMeta and this loop observing it as busy.
async function drainIgQueue(timeoutMs = 2000) {
  const start = Date.now()
  while (enrich._igQueueState.ids().length > 0 || enrich._igQueueState.pumping()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`drainIgQueue timed out after ${timeoutMs}ms — queue stuck?`)
    }
    await new Promise((r) => setTimeout(r, 1))
  }
}

test('metaFetched write-order: a slow main-chain classify pass must not clobber the IG job\'s fast metaFetched:true (MUST FIX A regression)', async () => {
  reset()
  seedNotes([{ id: 'n1', content: IG_URL, url: IG_URL, type: 'link', ai: {} }])
  // Reproduces the reviewer's measured ordering: IG fetch resolves fast,
  // classify is slow — so the IG job's store.updateNote lands first.
  classifyImpl = async ({ text }) => {
    await new Promise((r) => setTimeout(r, 15))
    return { type: 'link', category: 'General', title: 'T', summary: 'S', tags: [] }
  }
  await enrich.queueEnrich('n1', { absPath: null, text: IG_URL, isUrl: true, hasImage: false })
  assert.equal(notes.find((n) => n.id === 'n1').metaFetched, true, 'the main pass\'s patch must never clobber metaFetched back to false')
})

test('a landed caption triggers exactly one re-classify/re-embed, built from stored fields — not a re-fetch', async () => {
  reset()
  const id = 'n2'
  seedNotes([{ id, content: IG_URL, url: IG_URL, type: 'link', ai: {} }])
  fetchLinkMetaImpl = async () => ({
    siteTitle: 'My Title', siteDesc: 'My Title\nthe full caption text', siteName: 'Instagram', thumb: '/uploads/x.jpg',
  })
  await enrich.queueEnrich(id, { absPath: null, text: IG_URL, isUrl: true, hasImage: false })
  await drainIgQueue() // drains the deque past the internal job enrichNote fired
  await enrich.queueJob(() => {}) // drains enrichChain past the reclassify job queueIgMeta enqueued

  assert.equal(fetchLinkMetaCalls.filter((u) => u === IG_URL).length, 1, 'fetchLinkMeta must be called exactly once — reclassify must not re-fetch')
  assert.equal(classifyCalls.length, 2, 'classify runs once in enrichNote (text-only) and once more in reclassifyWithCaption (with caption)')
  assert.equal(classifyCalls[0], IG_URL, 'the first pass has no caption yet')
  assert.match(classifyCalls[1], /the full caption text/, 'the second pass is built from the note\'s own stored siteDesc')
  assert.match(classifyCalls[1], new RegExp(IG_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the second pass still includes the note\'s own content')

  const note = notes.find((n) => n.id === id)
  assert.equal(note.ai.igReclassified, true)
  assert.equal(note.ai.classify, true)
  assert.equal(note.ai.embed, true)

  // The seeded fetch also returned a thumb — the reclassify pass must
  // describe it and fold that into the same classify text as the caption.
  assert.equal(describeImageCalls.length, 1)
  assert.match(describeImageCalls[0].absPath, /x\.jpg$/)
  assert.match(classifyCalls[1], /default thumbnail description/)
  assert.equal(note.ai.thumbVision, true)
  // Persisted, not just folded into richText: Ask's answer prompt and
  // textSearch both read this field off the note.
  assert.equal(note.thumbDescription, 'default thumbnail description')

  // No loop: further chain activity must not grow the call counts.
  await enrich.queueJob(() => {})
  await enrich.queueJob(() => {})
  assert.equal(classifyCalls.length, 2, 'nothing re-queues itself — the counts stay put')
})

test('thumbnail vision respects the vision residency — off means no describeImage call, caption still reclassifies', async () => {
  reset()
  const id = 'n2b'
  residencyImpl = () => ({ llm: 'ondemand', embed: 'always', vision: 'off' })
  seedNotes([{ id, content: IG_URL, url: IG_URL, type: 'link', ai: {} }])
  fetchLinkMetaImpl = async () => ({
    siteTitle: 'Title', siteDesc: 'Title\ncaption text', siteName: 'Instagram', thumb: '/uploads/y.jpg',
  })
  enrich.queueIgMeta(id, IG_URL)
  await drainIgQueue()
  await enrich.queueJob(() => {})

  assert.equal(describeImageCalls.length, 0, 'vision off must skip the describe call entirely')
  assert.equal(classifyCalls.length, 1, 'the caption-only reclassify still runs')
  assert.doesNotMatch(classifyCalls[0], /thumbnail description/)
  const note = notes.find((n) => n.id === id)
  assert.equal(note.ai.thumbVision, undefined)
})

test('thumbnail vision only runs once per note — a prior ai.thumbVision marker plus a stored description skips the repeat describeImage call', async () => {
  reset()
  const id = 'n2c'
  seedNotes([{ id, content: IG_URL, url: IG_URL, type: 'link', thumbDescription: 'a previously stored description', ai: { thumbVision: true } }])
  fetchLinkMetaImpl = async () => ({
    siteTitle: 'Title', siteDesc: 'Title\ncaption text', siteName: 'Instagram', thumb: '/uploads/z.jpg',
  })
  enrich.queueIgMeta(id, IG_URL)
  await drainIgQueue()
  await enrich.queueJob(() => {})

  assert.equal(describeImageCalls.length, 0, 'already-described notes must not pay for a repeat vision call')
  assert.equal(classifyCalls.length, 1, 'the reclassify itself still runs — only the vision step is skipped')
  // The stored description is still what gets embedded/classified — skipping
  // the model call must not silently drop the text from richText.
  assert.match(classifyCalls[0], /a previously stored description/)
})

test('a thumbVision marker with NO stored description re-runs vision once, then stays put (self-heal for notes described before the field existed)', async () => {
  reset()
  const id = 'n2c2'
  // Exactly the shape a real library carries in the thousands: the vision
  // pass ran and set the marker, but its output was only ever a local.
  seedNotes([{ id, content: IG_URL, url: IG_URL, type: 'link', ai: { thumbVision: true } }])
  fetchLinkMetaImpl = async () => ({
    siteTitle: 'Title', siteDesc: 'Title\ncaption text', siteName: 'Instagram', thumb: '/uploads/z.jpg',
  })
  enrich.queueIgMeta(id, IG_URL)
  await drainIgQueue()
  await enrich.queueJob(() => {})

  assert.equal(describeImageCalls.length, 1, 'a marker with nothing stored must not strand the note without a description')
  const note = notes.find((n) => n.id === id)
  assert.equal(note.thumbDescription, 'default thumbnail description')

  // Now that it IS stored, a further pass short-circuits on the marker.
  note.ai = { ...note.ai, igReclassified: false }
  enrich.queueIgMeta(id, IG_URL)
  await drainIgQueue()
  await enrich.queueJob(() => {})
  assert.equal(describeImageCalls.length, 1, 'the self-heal is one-shot, not a permanent re-run')
})

test('a describeImage failure does not block the caption reclassify (failure isolation, same posture as classify/embed)', async () => {
  reset()
  const id = 'n2d'
  seedNotes([{ id, content: IG_URL, url: IG_URL, type: 'link', ai: {} }])
  fetchLinkMetaImpl = async () => ({
    siteTitle: 'Title', siteDesc: 'Title\ncaption text', siteName: 'Instagram', thumb: '/uploads/w.jpg',
  })
  describeImageImpl = async () => { throw new Error('simulated vision failure') }
  enrich.queueIgMeta(id, IG_URL)
  await drainIgQueue()
  await enrich.queueJob(() => {})

  assert.equal(describeImageCalls.length, 1, 'the describe call was attempted')
  assert.equal(classifyCalls.length, 1, 'a vision failure must not prevent the caption-only reclassify from running')
  assert.match(classifyCalls[0], /caption text/)
  const note = notes.find((n) => n.id === id)
  assert.equal(note.ai.igReclassified, true, 'classify/embed still succeeded off the caption alone')
  assert.equal(note.ai.thumbVision, undefined, 'a failed describe must not be marked done — eligible for retry')
})

test('hashtags in the caption reach classify() as candidateTags, junk-free and deduped', async () => {
  reset()
  const id = 'n2e'
  seedNotes([{ id, content: IG_URL, url: IG_URL, type: 'link', ai: {} }])
  fetchLinkMetaImpl = async () => ({
    siteTitle: null,
    siteDesc: 'Masjid Al Haram Makkah\n\nsomeuser\n\nA calm scene\n#peace #Peace #makkah',
    siteName: 'Instagram', thumb: null,
  })
  enrich.queueIgMeta(id, IG_URL)
  await drainIgQueue()
  await enrich.queueJob(() => {})

  assert.equal(classifyArgs.length, 1)
  assert.deepEqual(classifyArgs[0].candidateTags, ['peace', 'makkah'], 'extracted from siteDesc, normalized, deduped')
})

test('a second queueIgMeta call for the same note cannot cause an unbounded re-classify cycle', async () => {
  reset()
  const id = 'n3'
  seedNotes([{ id, content: IG_URL, url: IG_URL, type: 'link', ai: {} }])
  fetchLinkMetaImpl = async () => ({ siteTitle: 'Title', siteDesc: 'Title\ncaption body', siteName: 'Instagram', thumb: null })

  enrich.queueIgMeta(id, IG_URL)
  await drainIgQueue()
  await enrich.queueJob(() => {})
  assert.equal(classifyCalls.length, 1, 'first landed caption triggers one reclassify')

  // Simulate queueIgMeta firing again for the same id (e.g. a boot-time
  // backfill racing an in-flight import) — the igReclassified marker must
  // make the second one a no-op, not a second reclassify.
  enrich.queueIgMeta(id, IG_URL)
  await drainIgQueue()
  await enrich.queueJob(() => {})
  assert.equal(classifyCalls.length, 1, 'the igReclassified marker makes the second call a no-op, not another reclassify')
})

test('an IG fetch failure leaves the chain healthy for subsequent jobs (failure isolation)', async () => {
  reset()
  seedNotes([
    { id: 'n4', content: IG_URL, url: IG_URL, ai: {} },
    { id: 'n5', content: IG_URL, url: IG_URL, ai: {} },
  ])
  let calls = 0
  fetchLinkMetaImpl = async () => {
    calls++
    if (calls === 1) throw new Error('simulated network failure')
    return { siteTitle: 'ok now', siteDesc: 'it recovered', siteName: 'Instagram', thumb: null }
  }

  enrich.queueIgMeta('n4', IG_URL) // fails
  await drainIgQueue()
  const n4 = notes.find((n) => n.id === 'n4')
  // A failure no longer permanently sets metaFetched — it records a try
  // count + backoff instead, so a later boot backfill can retry it (see
  // test/enrich-retry.test.js for the retry-policy unit tests).
  assert.equal(n4.metaFetched, undefined, 'a failure must not permanently mark the note as fetched')
  assert.equal(n4.metaTries, 1)
  assert.ok(n4.metaNextTry > Date.now(), 'a backoff window is set for the next attempt')
  assert.equal(n4.siteTitle, undefined)

  enrich.queueIgMeta('n5', IG_URL) // must still run — one failure doesn't wedge the chain
  await drainIgQueue()
  await enrich.queueJob(() => {})
  const n5 = notes.find((n) => n.id === 'n5')
  assert.equal(n5.metaFetched, true)
  assert.equal(n5.siteTitle, 'ok now')
  assert.equal(classifyCalls.length, 1, 'n5 got its reclassify pass; n4 (failed fetch) did not trigger one')
})

test('a reclassify failure leaves the note recoverable — igReclassified is NOT set, so it is retried later (MUST FIX 1a regression)', async () => {
  reset()
  const id = 'n6'
  residencyImpl = () => ({ llm: 'ondemand', embed: 'off', vision: 'ondemand' }) // isolate to classify only
  seedNotes([{ id, content: IG_URL, url: IG_URL, type: 'link', ai: {} }])
  fetchLinkMetaImpl = async () => ({ siteTitle: 'Cap', siteDesc: 'Cap\nfull caption', siteName: 'Instagram', thumb: null })
  let classifyCallCount = 0
  classifyImpl = async () => {
    classifyCallCount++
    if (classifyCallCount >= 2) throw new Error('transient model failure') // fails on the RECLASSIFY call, not the first pass
    return { type: 'link', category: 'General', title: 'T', summary: 'S', tags: [] }
  }

  await enrich.queueEnrich(id, { absPath: null, text: IG_URL, isUrl: true, hasImage: false }) // first pass succeeds → ai.classify: true
  await drainIgQueue()
  await enrich.queueJob(() => {}) // drains the reclassify job, which fails

  let note = notes.find((n) => n.id === id)
  assert.equal(note.ai.classify, true, 'the first, URL-only classify pass had already succeeded and must not be undone')
  assert.equal(note.ai.igReclassified, undefined, 'a failed reclassify must NOT set the marker — the note stays eligible for a retry')

  // Prove it really is recoverable: the boot sweep (queueMetaBackfill) finds
  // it again (siteTitle present, igReclassified absent) and this time it succeeds.
  classifyImpl = async () => ({ type: 'link', category: 'General', title: 'Real Title', summary: 'Real Summary', tags: [] })
  enrich.queueMetaBackfill()
  await enrich.queueJob(() => {})
  note = notes.find((n) => n.id === id)
  assert.equal(note.ai.igReclassified, true)
  assert.equal(note.title, 'Real Title', 'the note is no longer permanently stranded on URL-only metadata')
})

test('boot sweep: a note whose caption landed but whose reclassify never ran gets picked up on the next boot (MUST FIX 1b)', async () => {
  reset()
  const id = 'n7'
  // Simulates a restart mid-import: the IG fetch completed and patched
  // siteTitle/siteDesc/metaFetched, but the process died before the
  // queued reclassify job ran. ai.classify is already true from the
  // original URL-only pass, so queueBacklog's stepsFor gate would skip it —
  // queueMetaBackfill's normal `!n.siteTitle && !n.metaFetched` gate would
  // too (siteTitle is present). Only the dedicated sweep catches this.
  seedNotes([{
    id, content: IG_URL, url: IG_URL, type: 'link', metaFetched: true,
    siteTitle: 'Stranded Title', siteDesc: 'Stranded Title\nthe caption', ai: { classify: true },
  }])

  enrich.queueMetaBackfill()
  await enrich.queueJob(() => {})

  assert.equal(fetchLinkMetaCalls.length, 0, 'the caption is already on disk — no fetch should happen')
  assert.equal(classifyCalls.length, 1)
  assert.match(classifyCalls[0], /the caption/)
  const note = notes.find((n) => n.id === id)
  assert.equal(note.ai.igReclassified, true)
})

test('hand-edited tags survive a reclassify (MUST FIX 2)', async () => {
  reset()
  const id = 'n8'
  // ai.tagsEdited: true is what handleUpdateNote (server/routes/notes.js)
  // sets when the user edits tags by hand — reclassifyWithCaption must
  // respect it even though it bypasses stepsFor's normal protection.
  seedNotes([{ id, content: IG_URL, url: IG_URL, type: 'link', tags: ['user-tag'], ai: { classify: true, tagsEdited: true } }])
  fetchLinkMetaImpl = async () => ({ siteTitle: 'Cap', siteDesc: 'Cap\nfull caption', siteName: 'Instagram', thumb: null })
  classifyImpl = async () => ({ type: 'link', category: 'General', title: 'New Title', summary: 'New Summary', tags: ['ai-tag'] })

  enrich.queueIgMeta(id, IG_URL)
  await drainIgQueue()
  await enrich.queueJob(() => {})

  const note = notes.find((n) => n.id === id)
  assert.deepEqual(note.tags, ['user-tag'], 'the AI-suggested tags must never overwrite a hand edit')
  assert.equal(note.title, 'New Title', 'title/summary/category still benefit from the caption')
  assert.equal(note.summary, 'New Summary')
  assert.equal(autoAddCalls.length, 0, 'discarded AI tags must never reach smart-collection auto-add either')
})

test('a resweep reuses the stored caption instead of leaving classify caption-less or re-fetching (MUST FIX 3)', async () => {
  reset()
  const id = 'n9'
  // Simulates: llm/embed were off during import (so classify never ran even
  // though the caption fetch — which is role-independent — already
  // completed), then a role got switched on and queueBacklog resweeps.
  seedNotes([{
    id, content: IG_URL, url: IG_URL, type: 'link', metaFetched: true,
    siteTitle: 'Stored Title', siteDesc: 'Stored Title\nstored caption body', ai: {},
  }])

  await enrich.queueEnrich(id, { absPath: null, text: IG_URL, isUrl: true, hasImage: false })

  assert.equal(fetchLinkMetaCalls.length, 0, 'metaFetched was already true — must not re-fetch')
  assert.equal(classifyCalls.length, 1)
  assert.match(classifyCalls[0], /stored caption body/, 'richText must include the already-stored caption, not just the bare URL')
  const note = notes.find((n) => n.id === id)
  assert.equal(note.ai.classify, true)
})

test('a resweep retries a PREVIOUSLY FAILED Instagram fetch, but not a previously successful one (MUST FIX 1, retry gating)', async () => {
  reset()
  const failedId = 'n10' // metaFetched:true but no caption — e.g. a 429/soft-ban mid-import
  const okId = 'n11' // metaFetched:true with a caption already landed
  seedNotes([
    { id: failedId, content: IG_URL, url: IG_URL, type: 'link', metaFetched: true, ai: {} },
    { id: okId, content: IG_URL, url: IG_URL, type: 'link', metaFetched: true, siteTitle: 'Cap', siteDesc: 'Cap\nbody', ai: { classify: true } },
  ])
  fetchLinkMetaImpl = async () => ({ siteTitle: 'Recovered', siteDesc: 'Recovered\nnow it works', siteName: 'Instagram', thumb: null })

  await enrich.queueEnrich(failedId, { absPath: null, text: IG_URL, isUrl: true, hasImage: false })
  await enrich.queueEnrich(okId, { absPath: null, text: IG_URL, isUrl: true, hasImage: false })
  await drainIgQueue()
  await enrich.queueJob(() => {})

  assert.equal(fetchLinkMetaCalls.filter((u) => u === IG_URL).length, 1, 'only the previously-failed note should trigger a re-fetch')
  const failed = notes.find((n) => n.id === failedId)
  assert.equal(failed.siteTitle, 'Recovered', 'the resweep gave the failed note a real caption this time')
})

test('queueMetaBackfill unsticks a note stranded by the OLD permanent-failure policy: clears metaFetched, grants a fresh retry budget, and actually queues a real fetch', async () => {
  reset()
  const id = 'n14'
  // Stuck by the OLD policy: queueIgMeta used to set metaFetched: true
  // unconditionally, even on failure, so this note never got a caption or
  // thumb and had no way back in. isStuckInstagramNote must recognize it and
  // queueMetaBackfill must both rewrite its retry state AND actually queue it
  // — not just one or the other.
  seedNotes([{ id, content: IG_URL, url: IG_URL, type: 'link', metaFetched: true, ai: {} }])

  enrich._igQueueState.pause()
  try {
    enrich.queueMetaBackfill()
    const stuck = notes.find((n) => n.id === id)
    assert.equal(stuck.metaFetched, false, 'the stale permanent-failure flag must be cleared')
    assert.equal(stuck.metaTries, 1, 'a fresh, bounded retry budget is granted')
    assert.equal(stuck.metaNextTry, 0, 'eligible immediately, not stuck behind a backoff window')
    assert.deepEqual(enrich._igQueueState.ids(), [id], 'and it is queued for a real retry attempt, with the pump paused so nothing has fetched yet')
  } finally {
    enrich._igQueueState.resume()
  }

  await drainIgQueue()
  await enrich.queueJob(() => {})
  assert.equal(fetchLinkMetaCalls.filter((u) => u === IG_URL).length, 1, 'the unstuck note actually gets a real fetch attempt, not just a rewritten flag')
})

test('queueMetaBackfill\'s eligibility branch: a note still backing off is skipped, one whose window has passed is queued', async () => {
  reset()
  const stillBackingOffId = 'n15'
  const eligibleId = 'n16'
  const stillBackingOffUrl = 'https://www.instagram.com/p/BACKOFF1/'
  const eligibleUrl = 'https://www.instagram.com/p/ELIGIBLE1/'
  const now = Date.now()
  // Both notes previously failed once (metaTries: 1) but never got marked
  // metaFetched — the current, non-stuck failure representation. Only their
  // metaNextTry differs: one is still in the backoff window, the other's has
  // already passed.
  seedNotes([
    { id: stillBackingOffId, content: stillBackingOffUrl, url: stillBackingOffUrl, type: 'link', metaTries: 1, metaNextTry: now + 600_000, ai: {} },
    { id: eligibleId, content: eligibleUrl, url: eligibleUrl, type: 'link', metaTries: 1, metaNextTry: now - 1, ai: {} },
  ])

  enrich._igQueueState.pause()
  try {
    enrich.queueMetaBackfill()
    assert.deepEqual(enrich._igQueueState.ids(), [eligibleId], 'only the note whose retry window has passed is queued — the still-backing-off note is skipped')
  } finally {
    enrich._igQueueState.resume()
  }

  await drainIgQueue()
  await enrich.queueJob(() => {})
  assert.equal(fetchLinkMetaCalls.filter((u) => u === eligibleUrl).length, 1, 'the eligible note gets its retry fetch')
  assert.equal(fetchLinkMetaCalls.filter((u) => u === stillBackingOffUrl).length, 0, 'the still-backing-off note must not be fetched yet')
  const stillBackingOff = notes.find((n) => n.id === stillBackingOffId)
  assert.equal(stillBackingOff.metaTries, 1, 'left untouched — no attempt was made')
})

test('a prioritize call for a note whose IG job is already in flight must not re-queue it (Important #1 regression: igInFlight guard)', async () => {
  reset()
  const id = 'n13'
  seedNotes([{ id, content: IG_URL, url: IG_URL, type: 'link', ai: {} }])
  // A controllable delay: fetchLinkMeta stays pending until the test itself
  // resolves it, so there's a window to observe the job as "shifted out of
  // the queue but not yet settled" — exactly the race the reviewer found
  // (pumpIg's old igQueued.delete happened before runIgJob/store.updateNote
  // landed, so a same-note prioritize call in that window looked eligible
  // and queued a wholly redundant second fetch).
  let resolveFetch
  fetchLinkMetaImpl = () => new Promise((resolve) => { resolveFetch = resolve })

  enrich.queueIgMeta(id, IG_URL) // shifts synchronously; fetchLinkMeta is now pending

  assert.deepEqual(enrich._igQueueState.ids(), [], 'the job was shifted out of the queue')
  assert.deepEqual(enrich._igQueueState.inFlight(), [id], 'and marked in-flight while its fetch is pending')

  // Simulate a POST /api/enrich/prioritize call landing for this same note
  // while its fetch is still in flight (plausible: metaFetched is still
  // false on disk since the write hasn't landed).
  enrich.queueIgMeta(id, IG_URL)
  assert.deepEqual(enrich._igQueueState.ids(), [], 'must NOT be re-added to the queue while its job is in flight')

  resolveFetch({ siteTitle: null, siteDesc: null, siteName: 'Instagram', thumb: null })
  await drainIgQueue()
  await enrich.queueJob(() => {})

  assert.equal(fetchLinkMetaCalls.filter((u) => u === IG_URL).length, 1, 'only one fetch should ever run — no redundant throttle-slot burn')
  assert.deepEqual(enrich._igQueueState.inFlight(), [], 'in-flight marker is cleared once the job settles')
})

test('a reclassify with tagsEdited embeds the kept (existing) tags, not the discarded AI tags (MUST FIX 2, embed input)', async () => {
  reset()
  const id = 'n12'
  seedNotes([{ id, content: IG_URL, url: IG_URL, type: 'link', tags: ['kept-tag'], ai: { classify: true, tagsEdited: true } }])
  fetchLinkMetaImpl = async () => ({ siteTitle: 'Cap', siteDesc: 'Cap\nfull caption', siteName: 'Instagram', thumb: null })
  classifyImpl = async () => ({ type: 'link', category: 'General', title: 'T', summary: 'S', tags: ['discarded-ai-tag'] })

  enrich.queueIgMeta(id, IG_URL)
  await drainIgQueue()
  await enrich.queueJob(() => {})

  assert.equal(embedCalls.length, 1)
  assert.match(embedCalls[0], /kept-tag/, 'the embedding must reflect the user\'s surviving tag')
  assert.doesNotMatch(embedCalls[0], /discarded-ai-tag/, 'the embedding must not encode a tag the note no longer has')
})
