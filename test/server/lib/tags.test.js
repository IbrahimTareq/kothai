// Unit tests for server/lib/tags.js — the pure tag normalization + vocabulary module.
// No filesystem or model access: every function is a pure transform.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTag, normalizeTags, buildVocabulary, extractHashtags, withAccountTag } from '../../../server/lib/tags.js'

test('normalizeTag: lowercases, trims, collapses whitespace to single hyphen', () => {
  assert.equal(normalizeTag('  Machine   Learning '), 'machine-learning')
  assert.equal(normalizeTag('JavaScript'), 'javascript')
  assert.equal(normalizeTag('a - b'), 'a-b') // no repeated hyphens
})

test('normalizeTag: trims stray hyphens and handles junk/non-strings', () => {
  assert.equal(normalizeTag('-tag-'), 'tag')
  assert.equal(normalizeTag('   '), '')
  assert.equal(normalizeTag(null), '')
  assert.equal(normalizeTag(42), '42')
})

test('normalizeTags: dedups (order-preserving), drops empties, respects max', () => {
  assert.deepEqual(normalizeTags(['AI', 'ai', ' ', 'ML']), ['ai', 'ml'])
  assert.deepEqual(normalizeTags(['a', 'b', 'c'], { max: 2 }), ['a', 'b'])
  assert.deepEqual(normalizeTags(null), [])
})

test('buildVocabulary: counts normalized tags, orders by frequency then name', () => {
  const notes = [
    { tags: ['Recipe', 'dinner'] },
    { tags: ['recipe', 'ML'] },
    { tags: ['ml'] },
    { tags: null },
  ]
  // recipe:2, ml:2, dinner:1 → freq desc, then alpha for ties
  assert.deepEqual(buildVocabulary(notes), ['ml', 'recipe', 'dinner'])
})

test('buildVocabulary: respects limit and returns [] for empty corpus', () => {
  const notes = [{ tags: ['a', 'b', 'c'] }]
  assert.deepEqual(buildVocabulary(notes, { limit: 2 }), ['a', 'b'])
  assert.deepEqual(buildVocabulary([]), [])
})

test('extractHashtags: pulls #tags out of prose, normalized and deduped, order-preserving', () => {
  assert.deepEqual(
    extractHashtags('someuser\n\nA calm scene\n#Peace #makkah #peace'),
    ['peace', 'makkah'], // dedup: #Peace and #peace normalize to the same tag
  )
})

test('extractHashtags: unicode hashtags (Arabic, accented Latin) are not silently dropped', () => {
  assert.deepEqual(extractHashtags('caption #مكة #café'), ['مكة', 'café'])
})

test('extractHashtags: no hashtags, or non-string input, returns []', () => {
  assert.deepEqual(extractHashtags('just plain text, no tags here'), [])
  assert.deepEqual(extractHashtags(null), [])
  assert.deepEqual(extractHashtags(undefined), [])
})

test('extractHashtags: a bare "#" or trailing punctuation does not produce an empty/junk tag', () => {
  assert.deepEqual(extractHashtags('look at this # #makkah!'), ['makkah'])
})

test('withAccountTag: prepends a normalized @handle tag when account is set', () => {
  assert.deepEqual(withAccountTag(['cooking', 'travel'], 'ChefSteps'), ['@chefsteps', 'cooking', 'travel'])
})

test('withAccountTag: no-op when account is falsy', () => {
  assert.deepEqual(withAccountTag(['cooking'], null), ['cooking'])
  assert.deepEqual(withAccountTag(['cooking'], undefined), ['cooking'])
  assert.deepEqual(withAccountTag(['cooking'], ''), ['cooking'])
})

test('withAccountTag: does not duplicate if the tag is already present', () => {
  assert.deepEqual(withAccountTag(['@chefsteps', 'cooking'], 'ChefSteps'), ['@chefsteps', 'cooking'])
})

test('withAccountTag: preserves dots/underscores in usernames, only lowercases', () => {
  assert.deepEqual(withAccountTag([], 'Chef.Steps_HQ'), ['@chef.steps_hq'])
})
