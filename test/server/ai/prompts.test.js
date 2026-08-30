// Unit tests for server/ai/prompts.js — the prompt text and JSON schema both
// providers share. These are the only guarantee that a note classified
// on-device and one classified against a remote endpoint get asked the same
// question; if these drift, the two providers silently produce different tags.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  NOTE_TYPES,
  CLASSIFY_SCHEMA,
  DESCRIBE_IMAGE_PROMPT,
  classifySystemPrompt,
  classifyUserPrompt,
  answerSystemPrompt,
  answerUserPrompt,
  noteContextBody,
  formatHistory,
  retrievalQuery,
} from '../../../server/ai/prompts.js'

test('CLASSIFY_SCHEMA requires every field the normaliser reads', () => {
  assert.deepEqual(CLASSIFY_SCHEMA.required, ['type', 'category', 'title', 'summary', 'tags'])
  assert.deepEqual(CLASSIFY_SCHEMA.properties.type.enum, NOTE_TYPES)
})

test('classifySystemPrompt lists every note type', () => {
  const sys = classifySystemPrompt({ now: '2026-01-01', knownTags: [], candidateTags: [] })
  for (const t of NOTE_TYPES) assert.ok(sys.includes(t), `missing type ${t}`)
})

test('classifySystemPrompt includes the vocabulary line only when tags are supplied', () => {
  const without = classifySystemPrompt({ now: 'x', knownTags: [], candidateTags: [] })
  assert.ok(!without.includes('Prefer reusing'))
  const with_ = classifySystemPrompt({ now: 'x', knownTags: ['travel'], candidateTags: [] })
  assert.ok(with_.includes('Prefer reusing'))
  assert.ok(with_.includes('travel'))
})

test('classifySystemPrompt includes the candidate-hashtag line only when candidates are supplied', () => {
  const without = classifySystemPrompt({ now: 'x', knownTags: [], candidateTags: [] })
  assert.ok(!without.includes("item's own hashtags"))
  const with_ = classifySystemPrompt({ now: 'x', knownTags: [], candidateTags: ['makkah'] })
  assert.ok(with_.includes("item's own hashtags"))
})

test('classifyUserPrompt prefixes hints and truncates long text', () => {
  const p = classifyUserPrompt({ text: 'hello', hasImage: true, isUrl: true })
  assert.ok(p.includes('An image is attached'))
  assert.ok(p.includes('is (or contains) a URL'))
  assert.ok(p.includes('hello'))
  const long = classifyUserPrompt({ text: 'x'.repeat(5000), hasImage: false, isUrl: false })
  assert.ok(long.length < 3200, 'text should be capped at 3000 chars')
})

test('classifyUserPrompt substitutes a placeholder for empty text', () => {
  const p = classifyUserPrompt({ text: '', hasImage: true, isUrl: false })
  assert.ok(p.includes('(no text — image only)'))
})

test('answerUserPrompt numbers notes for citation and caps each one', () => {
  const notes = [
    { createdAt: '2026-01-01T00:00:00Z', type: 'link', category: 'Tech', title: 'A', content: 'body-a', url: 'https://a' },
    { createdAt: '2026-01-02T00:00:00Z', type: 'text', category: 'Work', title: 'B', content: 'body-b' },
  ]
  const p = answerUserPrompt({ question: 'what?', contextNotes: notes })
  assert.ok(p.includes('[1]'))
  assert.ok(p.includes('[2]'))
  assert.ok(p.includes('URL: https://a'))
  assert.ok(p.includes('QUESTION: what?'))
})

// ---- answer context symmetry --------------------------------------------
// The retrieval half of Ask embeds title + summary + content + siteTitle +
// siteDesc + article + thumbnail description + tags. These tests are what
// keeps the ANSWER half showing the same fields: without them a note can be
// retrieved on text the answering model never sees, which is the exact bug
// this context builder was rewritten to fix.

// A saved reel: the caption and the thumbnail description carry all the
// signal; `content` is just the URL and `title` is the LLM's short label.
const REEL = {
  createdAt: '2026-01-01T00:00:00Z',
  type: 'video',
  category: 'Food',
  title: 'Brown butter pasta',
  summary: 'A 10-minute brown butter pasta recipe.',
  content: 'https://www.instagram.com/reel/ABC/',
  url: 'https://www.instagram.com/reel/ABC/',
  siteDesc: 'chefsteps Three ingredients and ten minutes. #pasta #brownbutter',
  thumbDescription: 'A skillet of buttered pasta on a wooden board, overlay text reads BEST PASTA EVER.',
  tags: ['pasta', 'brownbutter'],
}

test('noteContextBody surfaces every field the embedding was built from', () => {
  const body = noteContextBody({ ...REEL, siteTitle: 'A site title', article: 'Autolyse is the resting period.' })
  assert.match(body, /brown butter pasta recipe/i)
  assert.match(body, /A site title/)
  assert.match(body, /Caption: chefsteps Three ingredients/)
  assert.match(body, /Article: Autolyse is the resting period\./)
  assert.match(body, /Thumbnail: A skillet of buttered pasta/)
  assert.match(body, /BEST PASTA EVER/)
  assert.match(body, /Tags: pasta, brownbutter/)
})

test('noteContextBody drops duplicates rather than spending budget repeating them', () => {
  const body = noteContextBody({
    title: 'Same Thing',
    siteTitle: 'Same Thing',          // equals title
    summary: 'Same Thing',            // equals title
    content: 'https://x.test/a',
    url: 'https://x.test/a',          // content IS the url for a saved link
    tags: [],
  })
  assert.equal(body.match(/Same Thing/g), null, 'text already in the header line is not repeated')
  assert.equal(body.match(/https:\/\/x\.test\/a/g)?.length ?? 0, 0, 'the url is printed once, by answerUserPrompt, not twice')
})

test('answerUserPrompt shows a reel its caption and thumbnail description, not just title + URL', () => {
  const p = answerUserPrompt({ question: 'what pasta did I save?', contextNotes: [REEL] })
  assert.match(p, /Caption: chefsteps Three ingredients/)
  assert.match(p, /Thumbnail: .*BEST PASTA EVER/)
  assert.match(p, /URL: https:\/\/www\.instagram\.com\/reel\/ABC\//)
})

test('answerUserPrompt keeps the whole context inside the LLM ctx budget, trimming every note rather than dropping the tail', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    createdAt: '2026-01-01T00:00:00Z',
    type: 'video',
    category: 'Food',
    title: `Note ${i}`,
    siteDesc: 'x'.repeat(5000),
    content: 'https://x.test/' + i,
    url: 'https://x.test/' + i,
    tags: [],
  }))
  const p = answerUserPrompt({ question: 'q', contextNotes: many })
  // 12000 chars of bodies + 30 short header/URL lines, comfortably inside an
  // 8192-token context once the answer's own room is accounted for.
  assert.ok(p.length < 16000, `context grew to ${p.length} chars`)
  for (let i = 0; i < 30; i++) {
    assert.ok(p.includes(`[${i + 1}] `), `note ${i + 1} must still be present, not dropped`)
  }
})

test('answerUserPrompt never lets a long body push the header or URL out of a note block', () => {
  const p = answerUserPrompt({
    question: 'q',
    contextNotes: [{ ...REEL, siteDesc: 'y'.repeat(9000) }],
  })
  assert.match(p, /\[1\] \(video, Food, saved .*\) Brown butter pasta/)
  assert.match(p, /URL: https:\/\/www\.instagram\.com\/reel\/ABC\//)
})

test('answerUserPrompt handles an empty note set', () => {
  const p = answerUserPrompt({ question: 'q', contextNotes: [] })
  assert.ok(p.includes('(no saved notes yet)'))
})

test('answerSystemPrompt demands bracket citations', () => {
  assert.ok(answerSystemPrompt().includes('[2]'))
})

test('DESCRIBE_IMAGE_PROMPT is a non-empty instruction', () => {
  assert.ok(DESCRIBE_IMAGE_PROMPT.length > 20)
})

// ---- chat history --------------------------------------------------------
// Ask persists chats but used to hand the answer model only the current
// question, so every follow-up was answered cold. These cover both halves of
// the fix: the history block in the prompt, and the retrieval query a
// subject-less follow-up is actually searched with.

const HISTORY = [
  { role: 'user', text: 'what pasta recipes have I saved?' },
  { role: 'ai', text: 'You saved a brown butter pasta reel from chefsteps [1].' },
]

test('formatHistory labels each turn and keeps only the recent tail', () => {
  const long = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'ai' : 'user', text: `turn ${i}` }))
  const out = formatHistory(long)
  assert.equal(out.split('\n').length, 6, 'three exchanges — six messages')
  assert.match(out, /turn 19$/)
  assert.doesNotMatch(out, /turn 13/)
  assert.match(formatHistory(HISTORY), /^You: what pasta recipes have I saved\?/)
  assert.match(formatHistory(HISTORY), /Assistant: You saved a brown butter pasta reel/)
})

test('formatHistory clips a very long turn rather than letting it crowd out the notes', () => {
  const out = formatHistory([{ role: 'ai', text: 'x'.repeat(5000) }])
  assert.ok(out.length < 600, `history turn grew to ${out.length} chars`)
})

test('answerUserPrompt includes the conversation only when there is one, and before the notes', () => {
  const withHistory = answerUserPrompt({ question: 'what else did they make?', contextNotes: [REEL], history: HISTORY })
  assert.match(withHistory, /EARLIER IN THIS CONVERSATION:/)
  assert.ok(
    withHistory.indexOf('EARLIER IN THIS CONVERSATION') < withHistory.indexOf('SAVED NOTES'),
    'the model should know what "they" refers to before it starts reading evidence',
  )

  const without = answerUserPrompt({ question: 'q', contextNotes: [REEL] })
  assert.doesNotMatch(without, /EARLIER IN THIS CONVERSATION/)
})

test('retrievalQuery prepends the previous user turn so a subject-less follow-up retrieves something', () => {
  const q = retrievalQuery('what else did they make?', HISTORY)
  assert.match(q, /what pasta recipes have I saved\?/)
  assert.match(q, /what else did they make\?/)
})

test('retrievalQuery never folds in the assistant\'s own answer', () => {
  // A generated answer can be several hundred words about the wrong thing;
  // embedding it drags retrieval along with it.
  const q = retrievalQuery('what else?', HISTORY)
  assert.doesNotMatch(q, /chefsteps/)
})

test('retrievalQuery returns the question unchanged for the first turn of a chat', () => {
  assert.equal(retrievalQuery('what pasta did I save?'), 'what pasta did I save?')
  assert.equal(retrievalQuery('q', []), 'q')
  assert.equal(retrievalQuery('q', [{ role: 'ai', text: 'only an answer' }]), 'q')
})
