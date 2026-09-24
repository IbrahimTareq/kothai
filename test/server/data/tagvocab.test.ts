// Unit tests for server/data/tagvocab.ts — the canonical-tag embedding registry.
// The pure helper nearestTag needs no I/O (cosine moved to embedding.ts, and is
// covered there). The embedding-coupled paths
// (canonicalize, rebuildFromNotes) are driven with an injected fake embedder and
// _reset() so no model or disk is touched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as tagvocab from '../../../server/data/tagvocab.ts'

test('nearestTag: returns best entry when ≥ threshold, else null', () => {
  const entries: [string, number[]][] = [
    ['recipes', [1, 0, 0]],
    ['travel', [0, 1, 0]],
  ]
  const near = tagvocab.nearestTag([0.97, 0.24, 0], entries, 0.88)
  // nearestTag answers null below the threshold, so the match has to be pinned
  // before it is read — the two cases below are the null half of the contract.
  assert.ok(near, 'cosine ≈ 0.971 is above the 0.88 threshold, so this must match')
  assert.equal(near.tag, 'recipes')
  assert.ok(near.score >= 0.88)
  assert.equal(tagvocab.nearestTag([0.2, 0.9, 0.4], entries, 0.99), null) // best below threshold
  assert.equal(tagvocab.nearestTag([1, 0, 0], [], 0.88), null) // empty registry
})

// Deterministic fake embedder: known tags get fixed vectors, unknown → [0,0,1].
// cosine(recipes, cooking) ≈ 0.971 (snaps at 0.88); travel is orthogonal.
const VECS: Record<string, number[]> = {
  recipes: [1, 0, 0],
  cooking: [0.97, 0.24, 0],
  travel: [0, 1, 0],
}
const fakeEmbed = async (tag: string) => VECS[tag] || [0, 0, 1]

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
  const counting = async (t: string) => {
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

// Every tag is new on a fresh library, so a classified note paid one embedding
// round trip per tag, one after another: three to six per note on the demo's
// seed, all ahead of its thumbnail in the one-at-a-time queue.
test("canonicalize: embeds a note's new tags at once, not one round trip after another", async () => {
  tagvocab._reset()
  let inFlight = 0
  let most = 0
  const slow = async (t: string) => {
    most = Math.max(most, ++inFlight)
    await new Promise(r => setImmediate(r))
    inFlight--
    return VECS[t] || [0, 0, 1]
  }
  await tagvocab.canonicalize(['recipes', 'travel', 'baking'], { embed: slow })
  assert.equal(most, 3)
})

// Embedding up front must not change what snaps to what: a tag registered
// earlier in the list is still a target for a later one in the same list.
test('canonicalize: a near-duplicate later in the same list snaps to the earlier tag', async () => {
  tagvocab._reset()
  let calls = 0
  const counting = async (t: string) => {
    calls++
    return VECS[t] || [0, 0, 1]
  }
  assert.deepEqual(await tagvocab.canonicalize(['recipes', 'cooking', 'recipes'], { embed: counting }), ['recipes'])
  assert.equal(tagvocab.size(), 1)
  assert.equal(calls, 2, 'a repeated tag is embedded once')
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
