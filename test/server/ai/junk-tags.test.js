// Unit tests for server/ai/qvac.js's isJunkTag — the platform/engagement-word
// filter classify() applies to model-generated tags. Exported specifically so
// this regex-adjacent logic has a testable surface without needing real
// model I/O (classify() itself isn't unit-tested for that reason).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isJunkTag } from '../../../server/ai/normalise.js'
import { normalizeTag } from '../../../server/lib/tags.js'

test('isJunkTag: matches a junk word already in its compressed (no-hyphen) form', () => {
  assert.equal(isJunkTag('socialmedia'), true)
  assert.equal(isJunkTag('foryoupage'), true)
  assert.equal(isJunkTag('instagram'), true)
})

test('isJunkTag: matches the SAME junk concept after normalizeTag hyphenates it', () => {
  // Real bug: the model said "social media" (two words) rather than
  // "socialmedia" — normalizeTag turns that into "social-media", which a
  // bare JUNK_TAGS.has() lookup never matched, letting it through as a tag.
  assert.equal(isJunkTag(normalizeTag('social media')), true)
  assert.equal(isJunkTag(normalizeTag('for you page')), true)
  assert.equal(isJunkTag(normalizeTag('Explore Page')), true)
  assert.equal(isJunkTag(normalizeTag('Packing Orders')), true)
})

test('isJunkTag: a real topic word is never treated as junk', () => {
  assert.equal(isJunkTag('mosque'), false)
  assert.equal(isJunkTag('travel'), false)
  assert.equal(isJunkTag(normalizeTag('social justice')), false) // contains "social" but is not the junk concept
})
