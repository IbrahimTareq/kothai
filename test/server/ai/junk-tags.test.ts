// Unit tests for server/ai/normalise.ts's isJunkTag — the platform/engagement-word
// filter classify() applies to model-generated tags. Exported specifically so
// this regex-adjacent logic has a testable surface without needing real
// model I/O (classify() itself isn't unit-tested for that reason).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isJunkTag } from '../../../server/ai/normalise.ts'
import { normalizeTag } from '../../../server/data/tags.ts'

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

test('isJunkTag: frame-description words and echoed prompt labels are junk', () => {
  // Real library, 1,885 notes: the top tags included "setting" (206),
  // "man" (200), "white" (193), "wooden" (152), "activity" (99), "object" (73).
  // They came from the thumbnail vision description, which classify reads
  // alongside the caption — and whose "Setting: / People: / Objects: /
  // Activity:" headings (DESCRIBE_THUMB_PROMPT asks for exactly those) the
  // model copied straight into tags. None says what a save is about.
  for (const t of [
    'setting',
    'activity',
    'object',
    'person',
    'text',
    'background',
    'man',
    'woman',
    'white',
    'wooden',
  ]) {
    assert.equal(isJunkTag(t), true, t)
  }
})

test('isJunkTag: filler a model invents from a bare URL is junk', () => {
  // Real library: Instagram and TikTok saves classified before their caption
  // arrived carried "platform" (50 notes), "user" (14), "unknown" and
  // "comments" — the model describing a link, not what the save is about.
  for (const t of ['platform', 'user', 'unknown', 'comments']) {
    assert.equal(isJunkTag(t), true, t)
  }
})

test('isJunkTag: topic words that sit next to the frame words are kept', () => {
  for (const t of ['home', 'interior', 'woodworking', 'calligraphy', 'mens-health']) {
    assert.equal(isJunkTag(t), false, t)
  }
})
