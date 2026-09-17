// Tests for the generalised thumbnail vision pass.
//
// describeThumb used to run only inside the Instagram reclassify path, which
// meant a TikTok, a YouTube video or any other link with an og:image never got
// its cover frame looked at. It now runs from enrichNote for any note carrying
// a thumb. These tests pin the gating (residency, idempotency marker, presence
// of a thumb) and that the description reaches classify, embed and the note —
// the same harness shape as test/enrich-article.test.js, so no network and no
// model are involved.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { note } from '../../helpers/notes.ts'
import type { NoteRecord } from '../../../server/data/notes.ts'
import type { LinkMeta } from '../../../server/ai/meta.ts'
import type { Residency } from '../../../server/ai/roles.ts'
import type { ClassifyArgs, DescribeImageArgs } from '../../../server/ai/providers/types.ts'

const TIKTOK = 'https://www.tiktok.com/@chef/video/7300000000000000000'

let notes: NoteRecord[] = []
let classifyCalls: string[] = []
let embedCalls: string[] = []
let describeCalls: DescribeImageArgs[] = []
let describeImpl = async (): Promise<string> => 'Overlay text reads 3 INGREDIENT PASTA. A skillet on a wooden board.'
let linkMetaImpl = async (): Promise<LinkMeta> => ({
  siteTitle: 'a caption',
  siteDesc: null,
  siteName: 'TikTok',
  thumb: '/uploads/meta-t1.jpg',
  article: null,
})
let residencyImpl = (): Residency => ({ llm: 'ondemand', embed: 'always', vision: 'ondemand' })

const realMeta = await import('../../../server/ai/meta.ts')
const realStore = await import('../../../server/data/notes.ts')
const realTags = await import('../../../server/lib/tags.ts')
const realTagvocab = await import('../../../server/data/tagvocab.ts')
const realNormalise = await import('../../../server/ai/normalise.ts')
const realCollections = await import('../../../server/data/collections.ts')
const realSettings = await import('../../../server/data/settings.ts')

mock.module('../../../server/ai/meta.ts', {
  namedExports: { ...realMeta, fetchLinkMeta: async () => linkMetaImpl() },
})
mock.module('../../../server/data/notes.ts', {
  namedExports: {
    ...realStore,
    allNotes: () => notes,
    getNote: (id: string) => notes.find(n => n.id === id) ?? null,
    updateNote: async (id: string, patch: Partial<NoteRecord>) => {
      const n = notes.find(x => x.id === id)
      if (n) Object.assign(n, patch)
      return n
    },
  },
})
mock.module('../../../server/lib/tags.ts', { namedExports: { ...realTags, buildVocabulary: () => [] } })
mock.module('../../../server/data/tagvocab.ts', {
  namedExports: { ...realTagvocab, canonicalize: async (t: string[]) => t },
})
mock.module('../../../server/ai/index.ts', {
  namedExports: {
    ...realNormalise,
    classify: async (args: ClassifyArgs) => {
      classifyCalls.push(args.text)
      return { type: 'video', category: 'Food', title: 'T', summary: 'S', tags: [] }
    },
    embedText: async (text: string) => {
      embedCalls.push(text)
      return [0, 0, 0]
    },
    describeImage: async (args: DescribeImageArgs) => {
      describeCalls.push(args)
      return describeImpl()
    },
  },
})
mock.module('../../../server/data/collections.ts', { namedExports: { ...realCollections, autoAdd: async () => {} } })
mock.module('../../../server/data/settings.ts', {
  namedExports: { ...realSettings, getResidency: () => residencyImpl() },
})

const enrich = await import('../../../server/ai/enrich.ts')
const { DESCRIBE_THUMB_PROMPT } = await import('../../../server/ai/prompts.ts')

function seed(over: Partial<NoteRecord> = {}) {
  notes = [{ ...note({ id: 't1', content: TIKTOK, url: TIKTOK, type: 'video' }), ai: {}, ...over }]
  classifyCalls = []
  embedCalls = []
  describeCalls = []
}

async function run(id = 't1') {
  const n = notes.find(x => x.id === id)
  assert.ok(n, `run() was pointed at ${id}, which is not seeded`)
  await enrich.queueEnrich(id, { absPath: null, text: n.content, isUrl: true, hasImage: false })
}

test('a non-Instagram note with a thumbnail gets its cover frame described', async () => {
  seed()
  await run()

  assert.equal(describeCalls.length, 1, 'the pass no longer stops at Instagram notes')
  assert.match(describeCalls[0].absPath, /meta-t1\.jpg$/)
  assert.equal(describeCalls[0].prompt, DESCRIBE_THUMB_PROMPT)

  const stored = notes[0]
  assert.ok(stored.thumbDescription)
  assert.match(stored.thumbDescription, /3 INGREDIENT PASTA/)
  assert.ok(stored.ai)
  assert.equal(stored.ai.thumbVision, true)
  assert.match(classifyCalls[0], /3 INGREDIENT PASTA/, 'the description must reach classify')
  assert.match(embedCalls[0], /3 INGREDIENT PASTA/, 'the description must reach the embedding')
})

test('the prompt asks for burned-in text to be transcribed — the best retrieval key a short-form cover has', () => {
  assert.match(DESCRIBE_THUMB_PROMPT, /transcribe/i)
  assert.match(DESCRIBE_THUMB_PROMPT, /overlay/i)
  // Chrome is named generically now that this runs on every platform.
  assert.match(DESCRIBE_THUMB_PROMPT, /play button|progress bar|watermark/i)
  assert.doesNotMatch(DESCRIBE_THUMB_PROMPT, /Instagram/i)
})

test('vision residency off skips the describe call entirely, and the rest of enrichment still runs', async () => {
  seed()
  residencyImpl = () => ({ llm: 'ondemand', embed: 'always', vision: 'off' })
  await run()
  residencyImpl = () => ({ llm: 'ondemand', embed: 'always', vision: 'ondemand' })

  assert.equal(describeCalls.length, 0)
  assert.equal(notes[0].thumbDescription, undefined)
  assert.ok(notes[0].ai)
  assert.equal(notes[0].ai.thumbVision, undefined)
  assert.equal(classifyCalls.length, 1, 'classify still ran off the caption alone')
})

test('a note with no thumbnail never reaches the vision model', async () => {
  seed()
  linkMetaImpl = async () => ({
    siteTitle: 'a caption',
    siteDesc: null,
    siteName: 'TikTok',
    thumb: null,
    article: null,
  })
  await run()
  linkMetaImpl = async () => ({
    siteTitle: 'a caption',
    siteDesc: null,
    siteName: 'TikTok',
    thumb: '/uploads/meta-t1.jpg',
    article: null,
  })

  assert.equal(describeCalls.length, 0)
})

test('the ai.thumbVision marker makes the pass idempotent across repeat enrichments', async () => {
  seed()
  await run()
  assert.equal(describeCalls.length, 1)
  await run()
  assert.equal(describeCalls.length, 1, 'a second pass must not pay for the same frame again')
})

test('a describe failure leaves the marker unset so a later pass retries, and does not block classify/embed', async () => {
  seed()
  describeImpl = async () => {
    throw new Error('simulated vision failure')
  }
  await run()
  describeImpl = async () => 'Overlay text reads 3 INGREDIENT PASTA. A skillet on a wooden board.'

  assert.equal(describeCalls.length, 1)
  assert.ok(notes[0].ai)
  assert.equal(notes[0].ai.thumbVision, undefined)
  assert.equal(notes[0].thumbDescription, undefined)
  assert.equal(classifyCalls.length, 1, 'a vision failure is isolated, like every other step')
  assert.equal(embedCalls.length, 1)
})

test('a description landing on an ALREADY-embedded note forces a re-embed', async () => {
  // The resweep case: classified and embedded long ago with no frame
  // description, so stepsFor offers neither step and the new text would
  // otherwise never reach a vector.
  seed({ ai: { classify: true, embed: true }, thumb: '/uploads/meta-t1.jpg' })
  await run()

  assert.equal(classifyCalls.length, 0, 'classify was already done')
  assert.equal(embedCalls.length, 1)
  assert.match(embedCalls[0], /3 INGREDIENT PASTA/)
})

test('a thumbnail already on the note is described even when this pass fetches no link metadata', async () => {
  seed({ thumb: '/uploads/meta-old.jpg' })
  linkMetaImpl = async () => {
    throw new Error('offline')
  }
  await run()
  linkMetaImpl = async () => ({
    siteTitle: 'a caption',
    siteDesc: null,
    siteName: 'TikTok',
    thumb: '/uploads/meta-t1.jpg',
    article: null,
  })

  assert.equal(describeCalls.length, 1)
  assert.match(describeCalls[0].absPath, /meta-old\.jpg$/)
})

// ---- reaching the notes that need it -------------------------------------
// A note described before the description was persisted carries
// ai.thumbVision: true with nothing to show for it, AND ai.igReclassified
// (the two always ran together), so reclassifyWithCaption returns before it
// reaches describeThumb. It is also already classified and embedded. The
// enrichment backlog is what reaches it — which is why stepsFor keys this
// step on the stored description rather than on the lying marker.
const { stepsFor, backlogCount } = await import('../../../server/ai/backlog.ts')

const STRANDED: NoteRecord = {
  ...note({ id: 'stranded', thumb: '/uploads/meta-stranded.jpg' }),
  // Exactly the shape ~1,280 notes of the live library are in.
  ai: { classify: true, embed: true, thumbVision: true, igReclassified: true },
}
const ON: Residency = { llm: 'ondemand', embed: 'always', vision: 'ondemand' }

test('the backlog offers thumbVision for a note whose marker claims done but whose description is gone', () => {
  assert.ok(stepsFor(STRANDED, ON).includes('thumbVision'))
  assert.equal(backlogCount([STRANDED], ON), 1)
})

test('the backlog leaves alone a note that has its description, one with no thumbnail, and any note when vision is off', () => {
  assert.ok(!stepsFor({ ...STRANDED, thumbDescription: 'already there' }, ON).includes('thumbVision'))
  assert.ok(!stepsFor({ ...STRANDED, thumb: null }, ON).includes('thumbVision'))
  assert.ok(!stepsFor(STRANDED, { ...ON, vision: 'off' }).includes('thumbVision'))
})

test('running the backlog on a stranded note recovers the description and re-embeds it', async () => {
  notes = [{ ...STRANDED, content: TIKTOK, url: TIKTOK, type: 'video', siteDesc: 'a caption', metaFetched: true }]
  describeCalls = []
  embedCalls = []

  await run('stranded')

  assert.equal(describeCalls.length, 1)
  assert.ok(notes[0].thumbDescription)
  assert.match(notes[0].thumbDescription, /3 INGREDIENT PASTA/)
  assert.equal(embedCalls.length, 1, 'the recovered text must reach a vector')
})

test('the boot backfill does NOT queue this work — it is thousands of vision calls and would starve every new save', async () => {
  notes = [
    {
      ...STRANDED,
      content: TIKTOK,
      url: TIKTOK,
      type: 'video',
      siteTitle: 'x',
      siteDesc: 'a caption',
      metaFetched: true,
    },
  ]
  describeCalls = []

  enrich.queueMetaBackfill()
  await enrich.queueJob(() => {})

  assert.equal(describeCalls.length, 0, 'this belongs behind the user-triggered backlog, not on the boot queue')
})
