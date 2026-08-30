// Unit tests for server/ai/qvac.js's normaliseClassification — the pure
// post-processing classify() applies to the model's raw JSON (type
// fallback, length caps, junk-tag filtering). classify() itself does real
// model I/O so isn't unit-tested directly; this is the testable surface for
// what the model's output gets turned into before it reaches a note.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normaliseClassification, stripThinking } from '../../../server/ai/normalise.js'

function tagsOf(n = 8, prefix = 'tag') {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`)
}

test('tags: up to 10 survive when the model returns exactly that many, none junk', () => {
  const out = normaliseClassification({ type: 'link', tags: tagsOf(10) }, {})
  assert.equal(out.tags.length, 10)
})

test('tags: a model returning MORE than 10 is capped at 10, not silently truncated further', () => {
  const out = normaliseClassification({ type: 'link', tags: tagsOf(14) }, {})
  assert.equal(out.tags.length, 10)
})

test('tags: junk filtering does not eat into the 10-tag ceiling — pre-filter headroom covers it', () => {
  // 10 real tags + 3 junk ones the model also emitted. The old max:10
  // pre-filter cap would have thrown away 3 of the REAL tags to make room
  // for junk that gets filtered out anyway, leaving only 7. max:15 headroom
  // means all 10 real ones survive the junk filter and still hit the cap.
  const withJunk = [...tagsOf(10), 'instagram', 'fyp', 'viral']
  const out = normaliseClassification({ type: 'link', tags: withJunk }, {})
  assert.equal(out.tags.length, 10)
  assert.deepEqual(out.tags, tagsOf(10))
})

test('tags: fewer than 10 real tags from the model just pass through as-is (no padding)', () => {
  const out = normaliseClassification({ type: 'link', tags: ['makkah', 'travel'] }, {})
  assert.deepEqual(out.tags, ['makkah', 'travel'])
})

test('tags: junk is still filtered, hyphenated variants included', () => {
  const out = normaliseClassification({ type: 'link', tags: ['makkah', 'social media', 'instagram'] }, {})
  assert.deepEqual(out.tags, ['makkah'])
})

test('type: an invalid/missing model type falls back to the heuristic, not silently null', () => {
  const out = normaliseClassification({ type: 'not-a-real-type' }, { hasImage: true, isUrl: false, text: '' })
  assert.equal(out.type, 'image')
})

test('type: a valid model type is trusted as-is', () => {
  const out = normaliseClassification({ type: 'video' }, { hasImage: false, isUrl: true, text: 'https://x.com' })
  assert.equal(out.type, 'video')
})

// ---- reasoning-model output ----------------------------------------------
// Qwen3-VL and friends emit a <think> block before their answer. It used to
// land verbatim in the note's description, its embedding input, and the text
// shown to the user.
test('stripThinking removes a closed think block and keeps the answer', () => {
  assert.equal(
    stripThinking('<think>Step 1: read the image. Step 2: describe.</think>\n\nA skillet on a board.'),
    'A skillet on a board.',
  )
  assert.equal(stripThinking('<THINK>upper case</THINK> answer'), 'answer')
})

test('stripThinking drops an unterminated block entirely — there is no answer in it', () => {
  // A model that runs out of tokens mid-thought never closes the tag; keeping
  // the remainder would leak the whole chain of thought.
  assert.equal(stripThinking('<think>reasoning that never fini'), '')
  assert.equal(stripThinking('preamble <think>and then reasoning'), 'preamble')
})

test('stripThinking leaves ordinary output alone', () => {
  assert.equal(stripThinking('A skillet on a wooden board.'), 'A skillet on a wooden board.')
  assert.equal(stripThinking(''), '')
  assert.equal(stripThinking(null), '')
})

// A bare-URL save is a link as a matter of fact, not of judgement. The model
// reads the fetched page and sometimes answers "text" for one, which used to
// stand — stranding a saved article as a plain note, with the page title, the
// thumbnail and the article stage all fetched but unused.
test('a model "text" verdict on a bare URL is overruled by the heuristic', () => {
  const url = 'https://www.cnbc.com/2026/02/21/julia-holden-baby-hat-business.html'
  const out = normaliseClassification({ type: 'text', title: 'Julia Holden' }, { hasImage: false, isUrl: true, text: url })
  assert.equal(out.type, 'link')
})

test('the override also fires when isUrl was not passed but the text is one', () => {
  const out = normaliseClassification({ type: 'code' }, { hasImage: false, isUrl: false, text: 'https://example.com/a.html' })
  assert.equal(out.type, 'link')
})

test('a bare URL to a known video host still resolves to video', () => {
  const out = normaliseClassification({ type: 'text' }, { hasImage: false, isUrl: true, text: 'https://youtu.be/abc123' })
  assert.equal(out.type, 'video')
})

test('an "image" verdict on a URL is left alone — the heuristic would call it a link', () => {
  const out = normaliseClassification({ type: 'image' }, { hasImage: false, isUrl: true, text: 'https://cdn.example.com/cat.png' })
  assert.equal(out.type, 'image')
})

test('a "text" verdict on real prose is untouched', () => {
  const out = normaliseClassification({ type: 'text' }, { hasImage: false, isUrl: false, text: 'Remember to call the plumber' })
  assert.equal(out.type, 'text')
})
