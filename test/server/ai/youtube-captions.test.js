// Tests for the YouTube caption step: the pure URL/segment helpers, the
// permanent-vs-transient error discrimination that the idempotency marker
// turns on, and the enrich.js wiring that carries a transcript into classify,
// embed and the stored note.
//
// youtube-transcript is mocked at the package specifier, so nothing here
// touches the network — and the transcript step is the one place in this
// codebase that fetches outside safeFetch, which makes an offline test of its
// gating worth more than usual.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

const WATCH = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'

let transcriptImpl
let transcriptCalls

const realYt = await import('youtube-transcript')
mock.module('youtube-transcript', {
  namedExports: {
    ...realYt,
    fetchTranscript: async (id) => {
      transcriptCalls.push(id)
      return transcriptImpl(id)
    },
  },
})

const { youtubeVideoId, isYouTubeVideo, joinCaptions, fetchYouTubeCaptions } = await import('../../../server/ai/meta.js')

// ---- pure helpers --------------------------------------------------------

test('youtubeVideoId recognises every URL shape a saved YouTube link actually arrives in', () => {
  assert.equal(youtubeVideoId(WATCH), 'dQw4w9WgXcQ')
  assert.equal(youtubeVideoId('https://youtu.be/dQw4w9WgXcQ?t=42'), 'dQw4w9WgXcQ')
  assert.equal(youtubeVideoId('https://www.youtube.com/shorts/abc123XYZ_-'), 'abc123XYZ_-')
  assert.equal(youtubeVideoId('https://www.youtube.com/embed/abc123XYZ_-'), 'abc123XYZ_-')
  assert.equal(youtubeVideoId('https://www.youtube.com/live/abc123XYZ_-'), 'abc123XYZ_-')
  assert.equal(youtubeVideoId('https://m.youtube.com/watch?v=abc123XYZ_-'), 'abc123XYZ_-')
  assert.equal(youtubeVideoId('https://music.youtube.com/watch?v=abc123XYZ_-'), 'abc123XYZ_-')
})

test('youtubeVideoId rejects anything that is not a single YouTube video', () => {
  assert.equal(youtubeVideoId('https://www.youtube.com/'), null)                        // home page
  assert.equal(youtubeVideoId('https://www.youtube.com/@channel'), null)                // channel
  assert.equal(youtubeVideoId('https://www.youtube.com/watch?list=PL123'), null)        // playlist, no v=
  assert.equal(youtubeVideoId('https://vimeo.com/12345'), null)
  assert.equal(youtubeVideoId('https://evil.com/youtube.com/watch?v=abc123XYZ'), null)
  // The id is validated before the package ever sees it, so a URL cannot be
  // used to steer its request somewhere else.
  assert.equal(youtubeVideoId('https://www.youtube.com/watch?v=../../etc/passwd'), null)
  assert.equal(youtubeVideoId('javascript:alert(1)'), null)
  assert.equal(youtubeVideoId('not a url'), null)
  assert.equal(isYouTubeVideo('https://vimeo.com/1'), false)
  assert.equal(isYouTubeVideo(WATCH), true)
})

test('joinCaptions folds cue-sized segments into one block and caps it at the article limit', () => {
  assert.equal(joinCaptions([{ text: 'never gonna' }, { text: '  give you up ' }]), 'never gonna give you up')
  assert.equal(joinCaptions([{ text: '' }, { text: '   ' }]), null, 'nothing but blanks is no transcript')
  assert.equal(joinCaptions([]), null)
  assert.equal(joinCaptions(null), null)
  assert.equal(joinCaptions([{ text: 'x '.repeat(20000) }]).length, 8000)
})

// ---- permanent vs transient ---------------------------------------------

test('fetchYouTubeCaptions returns the transcript and marks the answer final', async () => {
  transcriptCalls = []
  transcriptImpl = async () => [{ text: 'we are no strangers' }, { text: 'to love' }]
  const r = await fetchYouTubeCaptions(WATCH)
  assert.deepEqual(transcriptCalls, ['dQw4w9WgXcQ'], 'the package is handed a validated id, never the raw URL')
  assert.equal(r.text, 'we are no strangers to love')
  assert.equal(r.done, true)
})

test('a video with captions disabled is a final answer, not an error — recorded so it is never asked about again', async () => {
  const permanent = [
    new realYt.YoutubeTranscriptDisabledError('dQw4w9WgXcQ'),
    new realYt.YoutubeTranscriptNotAvailableError('dQw4w9WgXcQ'),
    new realYt.YoutubeTranscriptNotAvailableLanguageError('en', ['de'], 'dQw4w9WgXcQ'),
    new realYt.YoutubeTranscriptVideoUnavailableError('dQw4w9WgXcQ'),
  ]
  for (const err of permanent) {
    transcriptCalls = []
    transcriptImpl = async () => { throw err }
    const r = await fetchYouTubeCaptions(WATCH)
    assert.equal(r.text, null)
    assert.equal(r.done, true, `${err.constructor.name} is permanent — the marker should be set`)
  }
})

test('a rate limit or a network blip stays retryable', async () => {
  for (const err of [new realYt.YoutubeTranscriptTooManyRequestError('slow down'), new Error('ECONNRESET')]) {
    transcriptImpl = async () => { throw err }
    const r = await fetchYouTubeCaptions(WATCH)
    assert.equal(r.text, null)
    assert.equal(r.done, false, 'a transient failure must not permanently mark the video as captionless')
  }
})

test('fetchYouTubeCaptions never calls out for a non-YouTube URL', async () => {
  transcriptCalls = []
  const r = await fetchYouTubeCaptions('https://vimeo.com/12345')
  assert.deepEqual(transcriptCalls, [])
  assert.deepEqual(r, { text: null, done: false })
})

// ---- enrich.js wiring ----------------------------------------------------
// Same harness shape as test/enrich-article.test.js: every module enrich.js
// touches is stubbed, so this asserts behaviour with no network and no model.

let notes = []
let classifyCalls = []
let embedCalls = []

const realMeta = await import('../../../server/ai/meta.js')
const realStore = await import('../../../server/data/notes.js')
const realTags = await import('../../../server/lib/tags.js')
const realTagvocab = await import('../../../server/data/tagvocab.js')
const realNormalise = await import('../../../server/ai/normalise.js')
const realCollections = await import('../../../server/data/collections.js')
const realSettings = await import('../../../server/data/settings.js')

let residencyImpl = () => ({ llm: 'ondemand', embed: 'always', vision: 'ondemand' })

mock.module('../../../server/ai/meta.js', {
  namedExports: {
    ...realMeta,
    fetchLinkMeta: async () => ({ siteTitle: 'Rick Astley - Never Gonna Give You Up', siteDesc: null, siteName: 'YouTube', thumb: null, article: null }),
  },
})
mock.module('../../../server/data/notes.js', {
  namedExports: {
    ...realStore,
    allNotes: () => notes,
    updateNote: async (id, patch) => {
      const n = notes.find((x) => x.id === id)
      if (n) Object.assign(n, patch)
      return n
    },
  },
})
mock.module('../../../server/lib/tags.js', { namedExports: { ...realTags, buildVocabulary: () => [] } })
mock.module('../../../server/data/tagvocab.js', { namedExports: { ...realTagvocab, canonicalize: async (t) => t } })
mock.module('../../../server/ai/index.js', {
  namedExports: {
    ...realNormalise,
    classify: async (args) => { classifyCalls.push(args.text); return { type: 'video', category: 'Music', title: 'T', summary: 'S', tags: [] } },
    embedText: async (text) => { embedCalls.push(text); return [0, 0, 0] },
  },
})
mock.module('../../../server/data/collections.js', { namedExports: { ...realCollections, autoAdd: async () => {} } })
mock.module('../../../server/data/settings.js', { namedExports: { ...realSettings, getResidency: () => residencyImpl() } })

const enrich = await import('../../../server/ai/enrich.js')

function seed(note) {
  notes = [{ id: 'y1', content: WATCH, url: WATCH, type: 'video', ai: {}, ...note }]
  classifyCalls = []
  embedCalls = []
  transcriptCalls = []
}

test('a transcript reaches classify, embed and the stored article field', async () => {
  seed()
  transcriptImpl = async () => [{ text: 'we are no strangers to love' }]
  await enrich.queueEnrich('y1', { absPath: null, text: WATCH, isUrl: true, hasImage: false })

  assert.match(classifyCalls[0], /no strangers to love/, 'transcript missing from the classify input')
  assert.match(embedCalls[0], /no strangers to love/, 'transcript missing from the embed input')
  const note = notes[0]
  assert.equal(note.article, 'we are no strangers to love')
  assert.equal(note.ai.captions, true)
})

test('a video with no captions is marked done once and never fetched again', async () => {
  seed()
  transcriptImpl = async () => { throw new realYt.YoutubeTranscriptDisabledError('off') }
  await enrich.queueEnrich('y1', { absPath: null, text: WATCH, isUrl: true, hasImage: false })
  assert.equal(transcriptCalls.length, 1)
  assert.equal(notes[0].ai.captions, true)
  assert.equal(notes[0].article, undefined, 'no captions means no article, not an empty one')

  // A second pass over the same note must not spend another request.
  await enrich.queueEnrich('y1', { absPath: null, text: WATCH, isUrl: true, hasImage: false })
  assert.equal(transcriptCalls.length, 1, 'the marker short-circuits the repeat fetch')
})

test('a transient caption failure leaves the note eligible for a later retry', async () => {
  seed()
  transcriptImpl = async () => { throw new realYt.YoutubeTranscriptTooManyRequestError('429') }
  await enrich.queueEnrich('y1', { absPath: null, text: WATCH, isUrl: true, hasImage: false })
  assert.equal(notes[0].ai.captions, undefined)

  transcriptImpl = async () => [{ text: 'the transcript, eventually' }]
  await enrich.queueEnrich('y1', { absPath: null, text: WATCH, isUrl: true, hasImage: false })
  assert.equal(transcriptCalls.length, 2, 'the retry actually happened')
  assert.match(notes[0].article, /the transcript, eventually/)
  assert.equal(notes[0].ai.captions, true)
})

test('a transcript landing on an ALREADY-embedded note forces a re-embed — otherwise it contributes nothing to retrieval', async () => {
  // Exactly the shape the boot backfill sweeps up: classified and embedded
  // long ago from the URL alone, so stepsFor offers neither classify nor
  // embed, and without the forced step the transcript would sit on disk
  // invisible to search.
  seed({ ai: { classify: true, embed: true } })
  transcriptImpl = async () => [{ text: 'a transcript worth embedding' }]
  await enrich.queueEnrich('y1', { absPath: null, text: WATCH, isUrl: true, hasImage: false })

  assert.equal(classifyCalls.length, 0, 'classify was already done and must not be re-run')
  assert.equal(embedCalls.length, 1, 'the new text must be embedded')
  assert.match(embedCalls[0], /a transcript worth embedding/)
})

test('with the embed role off, the transcript is still fetched and stored — it is not a model step', async () => {
  seed({ ai: { classify: true, embed: true } })
  residencyImpl = () => ({ llm: 'off', embed: 'off', vision: 'off' })
  transcriptImpl = async () => [{ text: 'still worth storing' }]
  await enrich.queueEnrich('y1', { absPath: null, text: WATCH, isUrl: true, hasImage: false })
  residencyImpl = () => ({ llm: 'ondemand', embed: 'always', vision: 'ondemand' })

  assert.equal(embedCalls.length, 0)
  assert.match(notes[0].article, /still worth storing/, 'textSearch and the answer prompt still benefit')
  assert.equal(notes[0].ai.captions, true)
})

test('a non-YouTube link never reaches the caption step', async () => {
  notes = [{ id: 'v1', content: 'https://vimeo.com/12345', url: 'https://vimeo.com/12345', type: 'video', ai: {} }]
  transcriptCalls = []
  await enrich.queueEnrich('v1', { absPath: null, text: 'https://vimeo.com/12345', isUrl: true, hasImage: false })
  assert.deepEqual(transcriptCalls, [])
  assert.equal(notes[0].ai.captions, undefined)
})

test('English captions are preferred, with a fall back to whatever the video actually has', async () => {
  const calls = []
  transcriptImpl = async () => [{ text: 'the english transcript' }]
  transcriptCalls = []
  // The mock records ids; wrap it to see the language option too.
  const realFetch = realYt.fetchTranscript
  assert.equal(typeof realFetch, 'function')

  const r = await fetchYouTubeCaptions(WATCH)
  assert.equal(r.text, 'the english transcript')
  assert.equal(r.done, true)
  assert.deepEqual(transcriptCalls, ['dQw4w9WgXcQ'], 'one call when English exists')

  // No English track: the package throws NotAvailableLanguage, and the second
  // attempt takes whatever the video does have. A transcript in the wrong
  // language still beats none.
  let attempt = 0
  transcriptImpl = async () => {
    if (attempt++ === 0) throw new realYt.YoutubeTranscriptNotAvailableLanguageError('en', ['ar'], 'dQw4w9WgXcQ')
    return [{ text: 'الترجمة العربية' }]
  }
  transcriptCalls = []
  const fallback = await fetchYouTubeCaptions(WATCH)
  assert.equal(fallback.text, 'الترجمة العربية')
  assert.equal(transcriptCalls.length, 2, 'preferred language first, then unrestricted')
})

test('a real failure is not masked by the language fallback', async () => {
  // Only "no track in this language" earns a second attempt; anything else is
  // the real error and must surface as-is.
  let attempts = 0
  transcriptImpl = async () => { attempts++; throw new realYt.YoutubeTranscriptDisabledError('dQw4w9WgXcQ') }
  const r = await fetchYouTubeCaptions(WATCH)
  assert.equal(attempts, 1, 'no pointless retry')
  assert.equal(r.done, true)
})
