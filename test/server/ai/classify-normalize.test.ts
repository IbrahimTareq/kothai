// Unit tests for server/ai/normalise.ts's normaliseClassification — the pure
// post-processing classify() applies to the model's raw JSON (type
// fallback, length caps, junk-tag filtering). classify() itself does real
// model I/O so isn't unit-tested directly; this is the testable surface for
// what the model's output gets turned into before it reaches a note.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normaliseClassification, stripThinking } from '../../../server/ai/normalise.ts'

function tagsOf(n = 8, prefix = 'tag') {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`)
}

test('tags: up to 10 survive when the model returns exactly that many, none junk', () => {
  const out = normaliseClassification({ type: 'link', tags: tagsOf(10) }, '')
  assert.equal(out.tags.length, 10)
})

test('tags: a model returning MORE than 10 is capped at 10, not silently truncated further', () => {
  const out = normaliseClassification({ type: 'link', tags: tagsOf(14) }, '')
  assert.equal(out.tags.length, 10)
})

test('tags: junk filtering does not eat into the 10-tag ceiling — pre-filter headroom covers it', () => {
  // 10 real tags + 3 junk ones the model also emitted. The old max:10
  // pre-filter cap would have thrown away 3 of the REAL tags to make room
  // for junk that gets filtered out anyway, leaving only 7. max:15 headroom
  // means all 10 real ones survive the junk filter and still hit the cap.
  const withJunk = [...tagsOf(10), 'instagram', 'fyp', 'viral']
  const out = normaliseClassification({ type: 'link', tags: withJunk }, '')
  assert.equal(out.tags.length, 10)
  assert.deepEqual(out.tags, tagsOf(10))
})

test('tags: fewer than 10 real tags from the model just pass through as-is (no padding)', () => {
  const out = normaliseClassification({ type: 'link', tags: ['makkah', 'travel'] }, '')
  assert.deepEqual(out.tags, ['makkah', 'travel'])
})

test('tags: junk is still filtered, hyphenated variants included', () => {
  const out = normaliseClassification({ type: 'link', tags: ['makkah', 'social media', 'instagram'] }, '')
  assert.deepEqual(out.tags, ['makkah'])
})

test('type: an invalid/missing model type falls back to the heuristic, not silently null', () => {
  const out = normaliseClassification({ type: 'not-a-real-type' }, 'https://example.com')
  assert.equal(out.type, 'link')
})

test('type: a valid model type is trusted as-is', () => {
  const out = normaliseClassification({ type: 'video' }, 'https://x.com')
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

// Kothai saves links only. A model can still answer with a type it was once
// offered — "text" for a saved article whose page reads as prose, "image" for
// a URL that points at a picture — and that answer must never reach the note:
// the UI has no card for it.
test('a type Kothai no longer stores is overruled by the URL heuristic', () => {
  for (const type of ['text', 'code', 'image']) {
    const out = normaliseClassification({ type }, 'https://www.cnbc.com/2026/02/21/julia-holden-baby-hat-business.html')
    assert.equal(out.type, 'link', type)
  }
})

test('a bare URL to a known video host still resolves to video', () => {
  assert.equal(normaliseClassification({ type: 'text' }, 'https://youtu.be/abc123').type, 'video')
})
