// Unit tests for server/data/tagvocab.js — the canonical-tag embedding registry.
// Pure helpers (cosine, nearestTag) need no I/O. The embedding-coupled paths
// (canonicalize, rebuildFromNotes) are driven with an injected fake embedder and
// _reset() so no model or disk is touched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as tagvocab from '../../../server/data/tagvocab.js'

test('cosine: identical → 1, orthogonal → 0, mismatched length → 0', () => {
  assert.ok(Math.abs(tagvocab.cosine([1, 0, 0], [1, 0, 0]) - 1) < 1e-9)
  assert.equal(tagvocab.cosine([1, 0, 0], [0, 1, 0]), 0)
  assert.equal(tagvocab.cosine([1, 2, 3], [1, 2]), 0)
  assert.equal(tagvocab.cosine(null, [1]), 0)
})

test('nearestTag: returns best entry when ≥ threshold, else null', () => {
  const entries = [
    ['recipes', [1, 0, 0]],
    ['travel', [0, 1, 0]],
  ]
  const near = tagvocab.nearestTag([0.97, 0.24, 0], entries, 0.88)
  assert.equal(near.tag, 'recipes')
  assert.ok(near.score >= 0.88)
  assert.equal(tagvocab.nearestTag([0.2, 0.9, 0.4], entries, 0.99), null) // best below threshold
  assert.equal(tagvocab.nearestTag([1, 0, 0], [], 0.88), null) // empty registry
})

// Deterministic fake embedder: known tags get fixed vectors, unknown → [0,0,1].
// cosine(recipes, cooking) ≈ 0.971 (snaps at 0.88); travel is orthogonal.
const VECS = {
  recipes: [1, 0, 0],
  cooking: [0.97, 0.24, 0],
  travel: [0, 1, 0],
}
const fakeEmbed = async (tag) => VECS[tag] || [0, 0, 1]

test('canonicalize: snaps a near-duplicate to the existing tag', async () => {
  tagvocab._reset()
  await tagvocab.canonicalize(['recipes'], { embed: fakeEmbed }) // registers recipes
  const out = await tagvocab.canonicalize(['cooking'], { embed: fakeEmbed })
  assert.deepEqual(out, ['recipes'])
})

test('canonicalize: below threshold registers as new (unchanged)', async () => {
  tagvocab._reset()
  await tagvocab.canonicalize(['recipes'], { embed: fakeEmbed })
  const out = await tagvocab.canonicalize(['travel'], { embed: fakeEmbed })
  assert.deepEqual(out, ['travel'])
  assert.equal(tagvocab.size(), 2)
})

test('canonicalize: exact match does not re-embed', async () => {
  tagvocab._reset()
  let calls = 0
  const counting = async (t) => {
    calls++
    return VECS[t] || [0, 0, 1]
  }
  await tagvocab.canonicalize(['recipes'], { embed: counting })
  await tagvocab.canonicalize(['recipes'], { embed: counting })
  assert.equal(calls, 1)
})

test('canonicalize: dedups when two inputs collapse to one canonical', async () => {
  tagvocab._reset()
  await tagvocab.canonicalize(['recipes'], { embed: fakeEmbed })
  const out = await tagvocab.canonicalize(['cooking', 'recipes'], { embed: fakeEmbed })
  assert.deepEqual(out, ['recipes'])
})

test('canonicalize: embed failure returns input unchanged', async () => {
  tagvocab._reset()
  const throwing = async () => {
    throw new Error('embedding model not loaded')
  }
  const out = await tagvocab.canonicalize(['newtag'], { embed: throwing })
  assert.deepEqual(out, ['newtag'])
})

test('canonicalize: empty / non-array input', async () => {
  tagvocab._reset()
  assert.deepEqual(await tagvocab.canonicalize([], { embed: fakeEmbed }), [])
  assert.deepEqual(await tagvocab.canonicalize(null, { embed: fakeEmbed }), [])
})

test('rebuildFromNotes: seeds registry so later tags snap to existing ones', async () => {
  tagvocab._reset()
  const notes = [{ tags: ['Recipes'] }, { tags: ['travel'] }, { tags: null }]
  await tagvocab.rebuildFromNotes(notes, { embed: fakeEmbed })
  assert.equal(tagvocab.size(), 2) // recipes, travel (normalized, distinct)
  const out = await tagvocab.canonicalize(['cooking'], { embed: fakeEmbed })
  assert.deepEqual(out, ['recipes']) // snapped to the seeded tag
})
