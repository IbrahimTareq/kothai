// Tests for enrich.ts's Instagram off-chain pipeline: queueIgMeta (its own
// FIFO, separate from the main enrichChain) and reclassifyWithCaption (the
// follow-up classify/embed pass once a caption lands). This is the riskiest
// new code from the Instagram-import review round — two real bugs
// (metaFetched write-order clobber, caption never reaching classify/embed)
// were found here — so these tests reproduce the exact scenarios that
// exposed them, plus the failure-isolation and no-loop guarantees. It now
// also covers a pending import's single pass, deferred until its fetch settles.
//
// Every module enrich.ts touches is mocked via node:test's mock.module
// (requires --experimental-test-module-mocks, wired into `pnpm test`) so
// this runs with zero network I/O and zero real model calls — classify/embed
// are just plain stub functions, and the "store" is an in-memory array that
// mirrors real updateNote's `Object.assign(note, patch)` shallow merge
// exactly, since that merge semantics is what MUST FIX A's bug depended on.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { note } from '../../helpers/notes.ts'
import type { NoteRecord } from '../../../server/data/notes.ts'
import type { LinkMeta } from '../../../server/links/meta.ts'
import type { Residency } from '../../../server/ai/roles.ts'
import type { Classification, ClassifyArgs, DescribeImageArgs } from '../../../server/ai/providers/types.ts'

const IG_URL = 'https://www.instagram.com/p/AAA111/'

// ---- in-memory fake store, mirroring notes.ts's real merge semantics ----
let notes: NoteRecord[] = []
function seedNotes(list: NoteRecord[]) {
  notes = list.map(n => ({ ...n }))
}
function fakeAllNotes() {
  return notes
}
async function fakeUpdateNote(id: string, patch: Partial<NoteRecord>) {
  const n = notes.find(x => x.id === id)
  if (!n) return null
  Object.assign(n, patch) // exactly server/data/notes.ts's real updateNote
  return n
}

// The store's find() answers `NoteRecord | undefined`, and every assertion
// below is about a note the test itself seeded. Asserting the lookup at each
// site would be twenty copies of the same line; missing it would report
// "cannot read property of undefined" instead of naming the note that went
// missing.
function seeded(id: string): NoteRecord {
  const n = notes.find(x => x.id === id)
  if (!n) throw new Error(`no note ${id} in the fake store — was it seeded?`)
  return n
}

// ---- swappable stub implementations, reconfigured per test ----
// Annotated at the declaration rather than per literal: each is reassigned in
// several tests, and without this the first assignment would fix the type and
// every later one would widen it.
let fetchLinkMetaImpl: (url: string, id: string) => Promise<LinkMeta>
let classifyImpl: (args: ClassifyArgs) => Promise<Classification>
let embedTextImpl: (text: string) => Promise<number[]>
let describeImageImpl: (args: DescribeImageArgs) => Promise<string>
let residencyImpl: () => Residency
let fetchLinkMetaCalls: string[]
let classifyCalls: string[]
let classifyArgs: ClassifyArgs[]
let embedCalls: string[]
let autoAddCalls: { id: string; tags: string[] }[]
let describeImageCalls: DescribeImageArgs[]
let thumbRetryCalls: string[]

function reset() {
  seedNotes([])
  fetchLinkMetaCalls = []
  classifyCalls = []
  classifyArgs = []
  embedCalls = []
  autoAddCalls = []
  describeImageCalls = []
  thumbRetryCalls = []
  fetchLinkMetaImpl = async () => ({ siteTitle: null, siteDesc: null, siteName: 'Instagram', thumb: null })
  classifyImpl = async () => ({ type: 'link', category: 'General', title: 'T', summary: 'S', tags: [] })
  embedTextImpl = async () => [0, 0, 0]
  describeImageImpl = async () => 'default thumbnail description' // benign, distinct string a test can assert against or ignore
  residencyImpl = () => ({ llm: 'ondemand', embed: 'always', vision: 'ondemand' })
}
reset()

const realMeta = await import('../../../server/links/meta.ts')
const realStore = await import('../../../server/data/notes.ts')
const realTags = await import('../../../server/data/tags.ts')
const realTagvocab = await import('../../../server/data/tagvocab.ts')
const realNormalise = await import('../../../server/ai/normalise.ts')
const realCollections = await import('../../../server/data/collections.ts')
const realSettings = await import('../../../server/data/settings.ts')

mock.module('../../../server/links/meta.ts', {
  namedExports: {
    ...realMeta,
    fetchLinkMeta: async (url: string, id: string) => {
      fetchLinkMetaCalls.push(url)
      return fetchLinkMetaImpl(url, id)
    },
  },
})
mock.module('../../../server/data/notes.ts', {
  namedExports: {
    ...realStore,
    allNotes: () => fakeAllNotes(),
    getNote: (id: string) => fakeAllNotes().find(n => n.id === id) ?? null,
    updateNote: (id: string, patch: Partial<NoteRecord>) => fakeUpdateNote(id, patch),
  },
})
mock.module('../../../server/data/tags.ts', { namedExports: { ...realTags, buildVocabulary: () => [] } })
mock.module('../../../server/data/tagvocab.ts', {
  namedExports: { ...realTagvocab, canonicalize: async (tags: string[]) => tags },
})
mock.module('../../../server/ai/index.ts', {
  namedExports: {
    ...realNormalise,
    classify: (args: ClassifyArgs) => {
      classifyCalls.push(args.text)
      classifyArgs.push(args)
      return classifyImpl(args)
    },
    embedText: (text: string) => {
      embedCalls.push(text)
      return embedTextImpl(text)
    },
    describeImage: (args: DescribeImageArgs) => {
      describeImageCalls.push(args)
      return describeImageImpl(args)
    },
  },
})
mock.module('../../../server/data/collections.ts', {
  namedExports: {
    ...realCollections,
    autoAdd: async (id: string, tags: string[]) => {
      autoAddCalls.push({ id, tags })
    },
  },
})
mock.module('../../../server/data/settings.ts', {
  namedExports: { ...realSettings, getResidency: () => residencyImpl() },
})
// The real one schedules minute-long timers; the boot sweep's only job is to
// hand the note over.
mock.module('../../../server/links/thumb-retry.ts', {
  namedExports: {
    queueThumbRetry: (id: string) => {
      thumbRetryCalls.push(id)
    },
  },
})

const enrich = await import('../../../server/ai/enrich.ts')

// queueIgMeta used to return the igChain promise so a test could just await
// it to know the job had landed. It's now a fire-and-forget push onto a
// deque (see enrich.ts's _igQueueState) — nothing in production awaits it,
// so instead poll until the deque is both empty AND not mid-job. pumpIg()
// sets `pumping` synchronously before its first await, so there's no race
// between calling queueIgMeta and this loop observing it as busy.
async function drainIgQueue(timeoutMs = 2000) {
  const start = Date.now()
  while (enrich._igQueueState.ids().length > 0 || enrich._igQueueState.pumping()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`drainIgQueue timed out after ${timeoutMs}ms — queue stuck?`)
    }
    await new Promise(r => setTimeout(r, 1))
  }
}

test("metaFetched write-order: a slow main-chain classify pass must not clobber the IG job's fast metaFetched:true (MUST FIX A regression)", async () => {
  reset()
  seedNotes([{ ...note({ id: 'n1', content: IG_URL, url: IG_URL, type: 'link' }), ai: {} }])
  // Reproduces the reviewer's measured ordering: IG fetch resolves fast,
  // the model pass is slow — so the IG job's store.updateNote lands first.
  // Embed, not classify: a URL-only pass no longer classifies.
  embedTextImpl = async () => {
    await new Promise(r => setTimeout(r, 15))
    return [0, 0, 0]
  }
  await enrich.queueEnrich('n1', IG_URL)
  assert.equal(seeded('n1').metaFetched, true, "the main pass's patch must never clobber metaFetched back to false")
})

test('a landed caption triggers exactly one classify, built from stored fields — the URL-only pass no longer classifies', async () => {
  reset()
  const id = 'n2'
  seedNotes([{ ...note({ id, content: IG_URL, url: IG_URL, type: 'link' }), ai: {} }])
  fetchLinkMetaImpl = async () => ({
    siteTitle: 'My Title',
    siteDesc: 'My Title\nthe full caption text',
    siteName: 'Instagram',
    thumb: '/uploads/x.jpg',
  })
  await enrich.queueEnrich(id, IG_URL)
  await drainIgQueue() // drains the deque past the internal job enrichNote fired
  await enrich.queueJob(() => {}) // drains enrichChain past the reclassify job queueIgMeta enqueued

  assert.equal(
    fetchLinkMetaCalls.filter(u => u === IG_URL).length,
    1,
    'fetchLinkMeta must be called exactly once — reclassify must not re-fetch',
  )
  assert.equal(classifyCalls.length, 1, 'the URL-only pass skips classify; only the caption pass runs it')
  assert.match(classifyCalls[0], /the full caption text/, "built from the note's own stored siteDesc")
  assert.match(
    classifyCalls[0],
    new RegExp(IG_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    "the pass still includes the note's own content",
  )

  const saved = seeded(id)
  assert.ok(saved.ai)
  assert.equal(saved.ai.igReclassified, true)
  assert.equal(saved.ai.classify, true)
  assert.equal(saved.ai.embed, true)

  // The seeded fetch also returned a thumb — the caption pass must describe
  // it and fold that into the same classify text as the caption.
  assert.equal(describeImageCalls.length, 1)
  assert.match(describeImageCalls[0].absPath, /x\.jpg$/)
  assert.match(classifyCalls[0], /default thumbnail description/)
  assert.equal(saved.ai.thumbVision, true)
  // Persisted, not just folded into richText: Ask's answer prompt and
  // textSearch both read this field off the note.
  assert.equal(saved.thumbDescription, 'default thumbnail description')

  // No loop: further chain activity must not grow the call counts.
  await enrich.queueJob(() => {})
  await enrich.queueJob(() => {})
  assert.equal(classifyCalls.length, 1, 'nothing re-queues itself — the counts stay put')
})

test('thumbnail vision respects the vision residency — off means no describeImage call, caption still reclassifies', async () => {
  reset()
  const id = 'n2b'
  residencyImpl = () => ({ llm: 'ondemand', embed: 'always', vision: 'off' })
  seedNotes([{ ...note({ id, content: IG_URL, url: IG_URL, type: 'link' }), ai: {} }])
  fetchLinkMetaImpl = async () => ({
    siteTitle: 'Title',
    siteDesc: 'Title\ncaption text',
    siteName: 'Instagram',
    thumb: '/uploads/y.jpg',
  })
  enrich.queueIgMeta(id, IG_URL)
  await drainIgQueue()
  await enrich.queueJob(() => {})

  assert.equal(describeImageCalls.length, 0, 'vision off must skip the describe call entirely')
  assert.equal(classifyCalls.length, 1, 'the caption-only reclassify still runs')
  assert.doesNotMatch(classifyCalls[0], /thumbnail description/)
  const saved = seeded(id)
  assert.ok(saved.ai)
  assert.equal(saved.ai.thumbVision, undefined)
})

test('thumbnail vision only runs once per note — a prior ai.thumbVision marker plus a stored description skips the repeat describeImage call', async () => {
  reset()
  const id = 'n2c'
  seedNotes([
    {
      ...note({ id, content: IG_URL, url: IG_URL, type: 'link' }),
      thumbDescription: 'a previously stored description',
      ai: { thumbVision: true },
    },
  ])
  fetchLinkMetaImpl = async () => ({
    siteTitle: 'Title',
    siteDesc: 'Title\ncaption text',
    siteName: 'Instagram',
    thumb: '/uploads/z.jpg',
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
  seedNotes([{ ...note({ id, content: IG_URL, url: IG_URL, type: 'link' }), ai: { thumbVision: true } }])
  fetchLinkMetaImpl = async () => ({
    siteTitle: 'Title',
    siteDesc: 'Title\ncaption text',
    siteName: 'Instagram',
    thumb: '/uploads/z.jpg',
  })
  enrich.queueIgMeta(id, IG_URL)
  await drainIgQueue()
  await enrich.queueJob(() => {})

  assert.equal(
    describeImageCalls.length,
    1,
    'a marker with nothing stored must not strand the note without a description',
  )
  const saved = seeded(id)
  assert.equal(saved.thumbDescription, 'default thumbnail description')

  // Now that it IS stored, a further pass short-circuits on the marker.
  saved.ai = { ...saved.ai, igReclassified: false }
  enrich.queueIgMeta(id, IG_URL)
  await drainIgQueue()
  await enrich.queueJob(() => {})
  assert.equal(describeImageCalls.length, 1, 'the self-heal is one-shot, not a permanent re-run')
})

test('a describeImage failure does not block the caption reclassify (failure isolation, same posture as classify/embed)', async () => {
  reset()
  const id = 'n2d'
  seedNotes([{ ...note({ id, content: IG_URL, url: IG_URL, type: 'link' }), ai: {} }])
  fetchLinkMetaImpl = async () => ({
    siteTitle: 'Title',
    siteDesc: 'Title\ncaption text',
    siteName: 'Instagram',
    thumb: '/uploads/w.jpg',
  })
  describeImageImpl = async () => {
    throw new Error('simulated vision failure')
  }
  enrich.queueIgMeta(id, IG_URL)
  await drainIgQueue()
  await enrich.queueJob(() => {})

  assert.equal(describeImageCalls.length, 1, 'the describe call was attempted')
  assert.equal(classifyCalls.length, 1, 'a vision failure must not prevent the caption-only reclassify from running')
  assert.match(classifyCalls[0], /caption text/)
  const saved = seeded(id)
  assert.ok(saved.ai)
  assert.equal(saved.ai.igReclassified, true, 'classify/embed still succeeded off the caption alone')
  assert.equal(saved.ai.thumbVision, undefined, 'a failed describe must not be marked done — eligible for retry')
})

test('hashtags in the caption reach classify() as candidateTags, junk-free and deduped', async () => {
  reset()
  const id = 'n2e'
  seedNotes([{ ...note({ id, content: IG_URL, url: IG_URL, type: 'link' }), ai: {} }])
  fetchLinkMetaImpl = async () => ({
    siteTitle: null,
    siteDesc: 'Masjid Al Haram Makkah\n\nsomeuser\n\nA calm scene\n#peace #Peace #makkah',
    siteName: 'Instagram',
    thumb: null,
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
  seedNotes([{ ...note({ id, content: IG_URL, url: IG_URL, type: 'link' }), ai: {} }])
  fetchLinkMetaImpl = async () => ({
    siteTitle: 'Title',
    siteDesc: 'Title\ncaption body',
    siteName: 'Instagram',
    thumb: null,
  })

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
  assert.equal(
    classifyCalls.length,
    1,
    'the igReclassified marker makes the second call a no-op, not another reclassify',
  )
})

test('an IG fetch failure leaves the chain healthy for subsequent jobs (failure isolation)', async () => {
  reset()
  seedNotes([
    { ...note({ id: 'n4', content: IG_URL, url: IG_URL }), ai: {} },
    { ...note({ id: 'n5', content: IG_URL, url: IG_URL }), ai: {} },
  ])
  let calls = 0
  fetchLinkMetaImpl = async () => {
    calls++
    if (calls === 1) throw new Error('simulated network failure')
    return { siteTitle: 'ok now', siteDesc: 'it recovered', siteName: 'Instagram', thumb: null }
  }

  enrich.queueIgMeta('n4', IG_URL) // fails
  await drainIgQueue()
  const n4 = seeded('n4')
  // A failure no longer permanently sets metaFetched — it records a try
  // count + backoff instead, so a later boot backfill can retry it (see
  // test/enrich-retry.test.ts for the retry-policy unit tests).
  assert.equal(n4.metaFetched, undefined, 'a failure must not permanently mark the note as fetched')
  assert.equal(n4.metaTries, 1)
  assert.ok(n4.metaNextTry !== undefined, 'a backoff window was recorded at all')
  assert.ok(n4.metaNextTry > Date.now(), 'a backoff window is set for the next attempt')
  assert.equal(n4.siteTitle, undefined)

  enrich.queueIgMeta('n5', IG_URL) // must still run — one failure doesn't wedge the chain
  await drainIgQueue()
  await enrich.queueJob(() => {})
  const n5 = seeded('n5')
  assert.equal(n5.metaFetched, true)
  assert.equal(n5.siteTitle, 'ok now')
  assert.equal(classifyCalls.length, 1, 'n5 got its reclassify pass; n4 (failed fetch) did not trigger one')
})

test('a reclassify failure leaves the note recoverable — igReclassified is NOT set, so it is retried later (MUST FIX 1a regression)', async () => {
  reset()
  const id = 'n6'
  residencyImpl = () => ({ llm: 'ondemand', embed: 'off', vision: 'ondemand' }) // isolate to classify only
  seedNotes([{ ...note({ id, content: IG_URL, url: IG_URL, type: 'link' }), ai: {} }])
  fetchLinkMetaImpl = async () => ({
    siteTitle: 'Cap',
    siteDesc: 'Cap\nfull caption',
    siteName: 'Instagram',
    thumb: null,
  })
  classifyImpl = async () => {
    throw new Error('transient model failure') // the first pass skips classify, so this is the reclassify
  }

  await enrich.queueEnrich(id, IG_URL) // first pass succeeds → ai.classify: true
  await drainIgQueue()
  await enrich.queueJob(() => {}) // drains the reclassify job, which fails

  let saved = seeded(id)
  assert.ok(saved.ai)
  assert.equal(
    saved.ai.classify,
    true,
    'the URL-only pass recorded "nothing to classify from", and that must not be undone',
  )
  assert.equal(
    saved.ai.igReclassified,
    undefined,
    'a failed reclassify must NOT set the marker — the note stays eligible for a retry',
  )

  // Prove it really is recoverable: the boot sweep (queueMetaBackfill) finds
  // it again (siteTitle present, igReclassified absent) and this time it succeeds.
  classifyImpl = async () => ({
    type: 'link',
    category: 'General',
    title: 'Real Title',
    summary: 'Real Summary',
    tags: [],
  })
  enrich.queueMetaBackfill()
  await enrich.queueJob(() => {})
  saved = seeded(id)
  assert.ok(saved.ai)
  assert.equal(saved.ai.igReclassified, true)
  assert.equal(saved.title, 'Real Title', 'the note is no longer permanently stranded on URL-only metadata')
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
  seedNotes([
    {
      ...note({
        id,
        content: IG_URL,
        url: IG_URL,
        type: 'link',
        metaFetched: true,
        siteTitle: 'Stranded Title',
        siteDesc: 'Stranded Title\nthe caption',
      }),
      ai: { classify: true },
    },
  ])

  enrich.queueMetaBackfill()
  await enrich.queueJob(() => {})

  assert.equal(fetchLinkMetaCalls.length, 0, 'the caption is already on disk — no fetch should happen')
  assert.equal(classifyCalls.length, 1)
  assert.match(classifyCalls[0], /the caption/)
  const saved = seeded(id)
  assert.ok(saved.ai)
  assert.equal(saved.ai.igReclassified, true)
})

// The note above has a siteTitle, which almost no real Instagram post does:
// the caption lands in siteDesc alone (9 of ~1,670 on a real install carried
// a siteTitle). Such a note enters the `!n.siteTitle` block, whose Instagram
// arm used to `continue` past every sweep below it — 191 notes sat with a
// caption they had never been classified on.
const CAPTION_ONLY: NoteRecord = {
  ...note({
    id: 'n7b',
    content: IG_URL,
    url: IG_URL,
    type: 'link',
    metaFetched: true,
    siteDesc: 'the caption, and no siteTitle',
    thumb: '/uploads/meta-n7b.jpg',
  }),
  ai: { classify: true, embed: true },
}

test('boot sweep: a caption-only note (no siteTitle, like nearly every Instagram post) still gets its reclassify', async () => {
  reset()
  seedNotes([CAPTION_ONLY])

  enrich.queueMetaBackfill()
  await drainIgQueue()
  await enrich.queueJob(() => {})

  assert.equal(fetchLinkMetaCalls.length, 0, 'the caption is on disk — no Instagram fetch at boot')
  assert.equal(classifyCalls.length, 1)
  assert.match(classifyCalls[0], /the caption, and no siteTitle/)
  assert.equal(seeded('n7b').ai?.igReclassified, true)
})

test('boot sweep: the reclassify it queues leaves thumbnail vision to the backlog', async () => {
  reset()
  seedNotes([CAPTION_ONLY])

  enrich.queueMetaBackfill()
  await enrich.queueJob(() => {})

  // One vision pass per note at boot would hold the single FIFO for as long
  // as the sweep is wide — see stepsFor's comment in backlog.ts.
  assert.equal(describeImageCalls.length, 0)
  assert.equal(classifyCalls.length, 1, 'classify and embed still run on the caption')
  assert.equal(embedCalls.length, 1)
})

test('boot sweep: an Instagram note whose thumbnail only failed for now is put back on thumb-retry', async () => {
  reset()
  seedNotes([
    {
      ...note({ id: 'n7c', content: IG_URL, url: IG_URL, type: 'link', metaFetched: true, siteDesc: 'cap' }),
      thumbSrc: 'https://scontent.cdninstagram.com/x.jpg',
      ai: { classify: true, embed: true, igReclassified: true },
    },
  ])

  enrich.queueMetaBackfill()

  assert.deepEqual(thumbRetryCalls, ['n7c'])
})

test('hand-edited tags survive a reclassify (MUST FIX 2)', async () => {
  reset()
  const id = 'n8'
  // ai.tagsEdited: true is what handleUpdateNote (server/routes/notes.ts)
  // sets when the user edits tags by hand — reclassifyWithCaption must
  // respect it even though it bypasses stepsFor's normal protection.
  seedNotes([
    {
      ...note({ id, content: IG_URL, url: IG_URL, type: 'link', tags: ['user-tag'] }),
      ai: { classify: true, tagsEdited: true },
    },
  ])
  fetchLinkMetaImpl = async () => ({
    siteTitle: 'Cap',
    siteDesc: 'Cap\nfull caption',
    siteName: 'Instagram',
    thumb: null,
  })
  classifyImpl = async () => ({
    type: 'link',
    category: 'General',
    title: 'New Title',
    summary: 'New Summary',
    tags: ['ai-tag'],
  })

  enrich.queueIgMeta(id, IG_URL)
  await drainIgQueue()
  await enrich.queueJob(() => {})

  const saved = seeded(id)
  assert.deepEqual(saved.tags, ['user-tag'], 'the AI-suggested tags must never overwrite a hand edit')
  assert.equal(saved.title, 'New Title', 'title/summary/category still benefit from the caption')
  assert.equal(saved.summary, 'New Summary')
  assert.equal(autoAddCalls.length, 0, 'discarded AI tags must never reach smart-collection auto-add either')
})

test('a resweep reuses the stored caption instead of leaving classify caption-less or re-fetching (MUST FIX 3)', async () => {
  reset()
  const id = 'n9'
  // Simulates: llm/embed were off during import (so classify never ran even
  // though the caption fetch — which is role-independent — already
  // completed), then a role got switched on and queueBacklog resweeps.
  seedNotes([
    {
      ...note({
        id,
        content: IG_URL,
        url: IG_URL,
        type: 'link',
        metaFetched: true,
        siteTitle: 'Stored Title',
        siteDesc: 'Stored Title\nstored caption body',
      }),
      ai: {},
    },
  ])

  await enrich.queueEnrich(id, IG_URL)

  assert.equal(fetchLinkMetaCalls.length, 0, 'metaFetched was already true — must not re-fetch')
  assert.equal(classifyCalls.length, 1)
  assert.match(
    classifyCalls[0],
    /stored caption body/,
    'richText must include the already-stored caption, not just the bare URL',
  )
  const saved = seeded(id)
  assert.ok(saved.ai)
  assert.equal(saved.ai.classify, true)
})

test('a resweep retries a PREVIOUSLY FAILED Instagram fetch, but not a previously successful one (MUST FIX 1, retry gating)', async () => {
  reset()
  const failedId = 'n10' // metaFetched:true but no caption — e.g. a 429/soft-ban mid-import
  const okId = 'n11' // metaFetched:true with a caption already landed
  seedNotes([
    { ...note({ id: failedId, content: IG_URL, url: IG_URL, type: 'link', metaFetched: true }), ai: {} },
    {
      ...note({
        id: okId,
        content: IG_URL,
        url: IG_URL,
        type: 'link',
        metaFetched: true,
        siteTitle: 'Cap',
        siteDesc: 'Cap\nbody',
      }),
      ai: { classify: true },
    },
  ])
  fetchLinkMetaImpl = async () => ({
    siteTitle: 'Recovered',
    siteDesc: 'Recovered\nnow it works',
    siteName: 'Instagram',
    thumb: null,
  })

  await enrich.queueEnrich(failedId, IG_URL)
  await enrich.queueEnrich(okId, IG_URL)
  await drainIgQueue()
  await enrich.queueJob(() => {})

  assert.equal(
    fetchLinkMetaCalls.filter(u => u === IG_URL).length,
    1,
    'only the previously-failed note should trigger a re-fetch',
  )
  const failed = seeded(failedId)
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
  seedNotes([{ ...note({ id, content: IG_URL, url: IG_URL, type: 'link', metaFetched: true }), ai: {} }])

  enrich._igQueueState.pause()
  try {
    enrich.queueMetaBackfill()
    const stuck = seeded(id)
    assert.equal(stuck.metaFetched, false, 'the stale permanent-failure flag must be cleared')
    assert.equal(stuck.metaTries, 1, 'a fresh, bounded retry budget is granted')
    assert.equal(stuck.metaNextTry, 0, 'eligible immediately, not stuck behind a backoff window')
    assert.deepEqual(
      enrich._igQueueState.ids(),
      [id],
      'and it is queued for a real retry attempt, with the pump paused so nothing has fetched yet',
    )
  } finally {
    enrich._igQueueState.resume()
  }

  await drainIgQueue()
  await enrich.queueJob(() => {})
  assert.equal(
    fetchLinkMetaCalls.filter(u => u === IG_URL).length,
    1,
    'the unstuck note actually gets a real fetch attempt, not just a rewritten flag',
  )
})

test("queueMetaBackfill's eligibility branch: a note still backing off is skipped, one whose window has passed is queued", async () => {
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
    {
      ...note({ id: stillBackingOffId, content: stillBackingOffUrl, url: stillBackingOffUrl, type: 'link' }),
      metaTries: 1,
      metaNextTry: now + 600_000,
      ai: {},
    },
    {
      ...note({ id: eligibleId, content: eligibleUrl, url: eligibleUrl, type: 'link' }),
      metaTries: 1,
      metaNextTry: now - 1,
      ai: {},
    },
  ])

  enrich._igQueueState.pause()
  try {
    enrich.queueMetaBackfill()
    assert.deepEqual(
      enrich._igQueueState.ids(),
      [eligibleId],
      'only the note whose retry window has passed is queued — the still-backing-off note is skipped',
    )
  } finally {
    enrich._igQueueState.resume()
  }

  await drainIgQueue()
  await enrich.queueJob(() => {})
  assert.equal(fetchLinkMetaCalls.filter(u => u === eligibleUrl).length, 1, 'the eligible note gets its retry fetch')
  assert.equal(
    fetchLinkMetaCalls.filter(u => u === stillBackingOffUrl).length,
    0,
    'the still-backing-off note must not be fetched yet',
  )
  const stillBackingOff = seeded(stillBackingOffId)
  assert.equal(stillBackingOff.metaTries, 1, 'left untouched — no attempt was made')
})

test('a prioritize call for a note whose IG job is already in flight must not re-queue it (Important #1 regression: igInFlight guard)', async () => {
  reset()
  const id = 'n13'
  seedNotes([{ ...note({ id, content: IG_URL, url: IG_URL, type: 'link' }), ai: {} }])
  // A controllable delay: fetchLinkMeta stays pending until the test itself
  // resolves it, so there's a window to observe the job as "shifted out of
  // the queue but not yet settled" — exactly the race the reviewer found
  // (pumpIg's old igQueued.delete happened before runIgJob/store.updateNote
  // landed, so a same-note prioritize call in that window looked eligible
  // and queued a wholly redundant second fetch).
  let resolveFetch: ((meta: LinkMeta) => void) | undefined
  fetchLinkMetaImpl = () =>
    new Promise(resolve => {
      resolveFetch = resolve
    })

  enrich.queueIgMeta(id, IG_URL) // shifts synchronously; fetchLinkMeta is now pending

  assert.deepEqual(enrich._igQueueState.ids(), [], 'the job was shifted out of the queue')
  assert.deepEqual(enrich._igQueueState.inFlight(), [id], 'and marked in-flight while its fetch is pending')

  // Simulate a POST /api/enrich/prioritize call landing for this same note
  // while its fetch is still in flight (plausible: metaFetched is still
  // false on disk since the write hasn't landed).
  enrich.queueIgMeta(id, IG_URL)
  assert.deepEqual(enrich._igQueueState.ids(), [], 'must NOT be re-added to the queue while its job is in flight')

  // queueIgMeta shifts its job synchronously, so the executor above has run
  // and handed its resolve over by now. Checked rather than assumed: if that
  // ever stops holding, the failure is "the fetch never started", not a
  // 2s drainIgQueue timeout three lines later.
  assert.ok(resolveFetch, 'the pending fetch never started, so there is nothing to resolve')
  resolveFetch({ siteTitle: null, siteDesc: null, siteName: 'Instagram', thumb: null })
  await drainIgQueue()
  await enrich.queueJob(() => {})

  assert.equal(
    fetchLinkMetaCalls.filter(u => u === IG_URL).length,
    1,
    'only one fetch should ever run — no redundant throttle-slot burn',
  )
  assert.deepEqual(enrich._igQueueState.inFlight(), [], 'in-flight marker is cleared once the job settles')
})

test('a reclassify with tagsEdited embeds the kept (existing) tags, not the discarded AI tags (MUST FIX 2, embed input)', async () => {
  reset()
  const id = 'n12'
  seedNotes([
    {
      ...note({ id, content: IG_URL, url: IG_URL, type: 'link', tags: ['kept-tag'] }),
      ai: { classify: true, tagsEdited: true },
    },
  ])
  fetchLinkMetaImpl = async () => ({
    siteTitle: 'Cap',
    siteDesc: 'Cap\nfull caption',
    siteName: 'Instagram',
    thumb: null,
  })
  classifyImpl = async () => ({
    type: 'link',
    category: 'General',
    title: 'T',
    summary: 'S',
    tags: ['discarded-ai-tag'],
  })

  enrich.queueIgMeta(id, IG_URL)
  await drainIgQueue()
  await enrich.queueJob(() => {})

  assert.equal(embedCalls.length, 1)
  assert.match(embedCalls[0], /kept-tag/, "the embedding must reflect the user's surviving tag")
  assert.doesNotMatch(embedCalls[0], /discarded-ai-tag/, 'the embedding must not encode a tag the note no longer has')
})

// ---- pending imports: one labelling pass, started by the fetch ----
// An import used to classify each post from its bare URL first (tags like
// `platform, view, web`), clear `pending`, and queue the caption pass behind
// the whole import. These pin the replacement: no model work until the
// fetch has been attempted, then exactly one pass.

test('a pending Instagram note that was never fetched gets no model work until its fetch settles', async () => {
  reset()
  const id = 'p1'
  seedNotes([{ ...note({ id, content: IG_URL, url: IG_URL, pending: true }), ai: {} }])
  enrich._igQueueState.pause()
  try {
    await enrich.queueEnrich(id, IG_URL)

    assert.deepEqual(enrich._igQueueState.ids(), [id], 'the fetch is queued')
    assert.equal(classifyCalls.length, 0)
    assert.equal(embedCalls.length, 0)
    assert.equal(describeImageCalls.length, 0)
    assert.equal(seeded(id).pending, true, 'nothing has labelled it yet, so it still says so')
  } finally {
    enrich._igQueueState.clear()
  }
})

test('a pending note whose fetch lands a caption is labelled once, from the caption and its hashtags', async () => {
  reset()
  const id = 'p2'
  seedNotes([{ ...note({ id, content: IG_URL, url: IG_URL, pending: true }), ai: {} }])
  fetchLinkMetaImpl = async () => ({
    siteTitle: null,
    siteDesc: 'a calm scene #makkah',
    siteName: 'Instagram',
    thumb: null,
  })
  await enrich.queueEnrich(id, IG_URL) // defers, queues the fetch
  await drainIgQueue() // the fetch settles and hands the note back
  await enrich.queueJob(() => {}) // the one labelling pass

  assert.equal(classifyCalls.length, 1)
  assert.match(classifyCalls[0], /a calm scene/)
  assert.deepEqual(classifyArgs[0].candidateTags, ['makkah'])
  const saved = seeded(id)
  assert.equal(saved.pending, false)
  assert.equal(saved.ai?.igReclassified, true)

  // A restart must not label every imported post a second time.
  enrich.queueMetaBackfill()
  await enrich.queueJob(() => {})
  assert.equal(classifyCalls.length, 1)
})

test('a pending note whose fetch finds only a thumbnail is labelled from the thumbnail description', async () => {
  reset()
  const id = 'p4'
  seedNotes([{ ...note({ id, content: IG_URL, url: IG_URL, pending: true }), ai: {} }])
  fetchLinkMetaImpl = async () => ({ siteTitle: null, siteDesc: null, siteName: 'Instagram', thumb: '/uploads/t.jpg' })
  await enrich.queueEnrich(id, IG_URL)
  await drainIgQueue()
  await enrich.queueJob(() => {})

  assert.equal(describeImageCalls.length, 1)
  assert.equal(classifyCalls.length, 1)
  assert.match(classifyCalls[0], /default thumbnail description/)
  assert.equal(seeded(id).pending, false)
})

test('a caption-less post whose thumbnail describe failed keeps classify open for the backlog to finish', async () => {
  reset()
  const id = 'p11'
  seedNotes([{ ...note({ id, content: IG_URL, url: IG_URL, pending: true }), ai: {} }])
  fetchLinkMetaImpl = async () => ({ siteTitle: null, siteDesc: null, siteName: 'Instagram', thumb: '/uploads/q.jpg' })
  describeImageImpl = async () => {
    throw new Error('vision down')
  }
  await enrich.queueEnrich(id, IG_URL)
  await drainIgQueue()
  await enrich.queueJob(() => {})

  assert.equal(classifyCalls.length, 0, 'never classify a bare URL')
  assert.notEqual(seeded(id).ai?.classify, true, 'the thumbnail is still to be read, so classify stays owed')
  assert.equal(seeded(id).pending, false)

  // The Settings backlog's resweep describes the thumbnail and classifies from it.
  describeImageImpl = async () => 'default thumbnail description'
  await enrich.queueEnrich(id, IG_URL)
  await drainIgQueue()

  assert.equal(classifyCalls.length, 1)
  assert.match(classifyCalls[0], /default thumbnail description/)
})

// Regression guard for "every route clears pending" on defer -> settle -> enrichNote; it passed before this route existed too.
test('with every role off, a settled fetch still clears pending', async () => {
  reset()
  const id = 'p5'
  residencyImpl = () => ({ llm: 'off', embed: 'off', vision: 'off' })
  seedNotes([{ ...note({ id, content: IG_URL, url: IG_URL, pending: true }), ai: {} }])
  fetchLinkMetaImpl = async () => ({ siteTitle: null, siteDesc: 'caption', siteName: 'Instagram', thumb: null })
  await enrich.queueEnrich(id, IG_URL)
  await drainIgQueue()
  await enrich.queueJob(() => {})

  assert.equal(classifyCalls.length, 0)
  assert.equal(seeded(id).pending, false)
})

test('boot: a pending note that was never fetched is queued for its fetch, not labelled', async () => {
  reset()
  const id = 'p6'
  seedNotes([{ ...note({ id, content: IG_URL, url: IG_URL, pending: true }), ai: {} }])
  enrich._igQueueState.pause()
  try {
    enrich.queueMetaBackfill()
    await enrich.queueJob(() => {})

    assert.deepEqual(enrich._igQueueState.ids(), [id])
    assert.equal(classifyCalls.length, 0)
    assert.equal(seeded(id).pending, true)
  } finally {
    enrich._igQueueState.clear()
  }
})

test("a fetch that settles while the chain is busy doesn't cost a second pass or a second fetch", async () => {
  reset()
  const id = 'p9'
  seedNotes([{ ...note({ id, content: IG_URL, url: IG_URL, pending: true }), ai: {} }])
  // Something slow holds the chain, the import's own pass queues behind it,
  // and the fetch settles meanwhile, so the handler's pass queues last.
  let release!: () => void
  const held = new Promise<void>(r => {
    release = r
  })
  void enrich.queueJob(() => held)
  void enrich.queueEnrich(id, IG_URL)
  enrich.queueIgMeta(id, IG_URL)
  await drainIgQueue()
  release()
  await enrich.queueJob(() => {})
  await drainIgQueue()

  assert.equal(fetchLinkMetaCalls.length, 1, 'the handler found the note already labelled and left it alone')
  assert.equal(seeded(id).pending, false)
})

test('boot: a pending note whose caption already landed gets one full pass, with its thumbnail', async () => {
  reset()
  const id = 'p8'
  seedNotes([
    {
      ...note({
        id,
        content: IG_URL,
        url: IG_URL,
        pending: true,
        metaFetched: true,
        siteDesc: 'the caption',
        thumb: '/uploads/p8.jpg',
      }),
      ai: {},
    },
  ])
  enrich.queueMetaBackfill()
  await enrich.queueJob(() => {})

  assert.equal(classifyCalls.length, 1)
  assert.match(classifyCalls[0], /default thumbnail description/, 'the one pass read the thumbnail')
  assert.equal(embedCalls.length, 1)
  assert.equal(seeded(id).pending, false)
})

test('a pending note whose fetch fails is settled without classify: import title kept, account tag added', async () => {
  reset()
  const id = 'p3'
  seedNotes([
    {
      ...note({
        id,
        content: IG_URL,
        url: IG_URL,
        pending: true,
        title: '@someone · Post',
        tags: ['instagram'],
        account: 'someone',
      }),
      ai: {},
    },
  ])
  fetchLinkMetaImpl = async () => {
    throw new Error('429')
  }
  await enrich.queueEnrich(id, IG_URL)
  await drainIgQueue()
  await enrich.queueJob(() => {})
  await drainIgQueue()

  assert.equal(classifyCalls.length, 0, 'never classify a bare URL')
  assert.equal(fetchLinkMetaCalls.length, 1, 'the backoff owns retries — no immediate re-fetch')
  const saved = seeded(id)
  assert.equal(saved.pending, false)
  assert.equal(saved.title, '@someone · Post')
  assert.deepEqual(saved.tags, ['@someone', 'instagram'])
  assert.equal(saved.ai?.classify, true, 'nothing to classify from, so the backlog stops counting it')
  assert.equal(embedCalls.length, 1, 'embed still runs')
})

test('boot: a pending note whose fetch already failed is settled, not left pending', async () => {
  reset()
  const id = 'p6b'
  seedNotes([
    {
      ...note({ id, content: IG_URL, url: IG_URL, pending: true }),
      metaTries: 1,
      metaNextTry: Date.now() + 600_000,
      ai: {},
    },
  ])
  enrich.queueMetaBackfill()
  await enrich.queueJob(() => {})

  assert.equal(fetchLinkMetaCalls.length, 0, 'still backing off')
  assert.equal(classifyCalls.length, 0)
  assert.equal(seeded(id).pending, false)
  assert.equal(seeded(id).ai?.classify, true)
})

test('queueLinkMeta hands an Instagram link to the Instagram lane instead of dropping it', () => {
  reset()
  enrich._igQueueState.pause()
  try {
    enrich.queueLinkMeta('p7', IG_URL)
    assert.deepEqual(enrich._igQueueState.ids(), ['p7'])
  } finally {
    enrich._igQueueState.clear()
  }
})

test('a caption-less post with a stored thumbnail description is classified from it, not marked bare', async () => {
  reset()
  seedNotes([
    {
      ...note({
        id: 'p10',
        content: IG_URL,
        url: IG_URL,
        metaFetched: true,
        thumb: '/uploads/p10.jpg',
        tags: ['platform', 'view'],
      }),
      thumbDescription: 'a stored description of the reel',
      ai: { thumbVision: true },
    },
  ])
  await enrich.queueEnrich('p10', IG_URL)

  assert.equal(classifyCalls.length, 1)
  assert.match(classifyCalls[0], /a stored description of the reel/)
  assert.equal(describeImageCalls.length, 0, 'no repeat vision')
})
