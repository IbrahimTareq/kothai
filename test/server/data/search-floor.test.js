// Tests for the similarity floor and top-k on the cosine retriever.
//
// The floor is what lets Ask answer "nothing is saved on this". Cosine search
// always returns its top k however bad they are, so an out-of-library
// question used to fill the answer prompt with ten unrelated notes and the
// model dutifully described them. The threshold value itself is measured
// against the live library (see the comment on SIM_FLOOR in notes.js); these
// tests pin the BEHAVIOUR, using vectors constructed to sit either side of it.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import * as store from '../../../server/data/notes.js'

// Two orthogonal axes plus a blend, so similarity to [1,0] is exactly the
// first component of a unit vector — cosine scores that are readable by eye.
const unit = (angle) => [Math.cos(angle), Math.sin(angle)]
const QUERY = [1, 0]
const at = (sim) => unit(Math.acos(sim))

beforeEach(() => store._reset())

async function seed(sims) {
  for (const [i, sim] of sims.entries()) {
    await store.addNote({ title: `note ${i}`, content: `note ${i}`, embedding: at(sim) })
  }
}

test('candidates below the floor are dropped, so an out-of-library question retrieves nothing', async () => {
  // The measured out-of-library band: every match in the 0.32-0.44 range.
  await seed([0.43, 0.39, 0.36, 0.33])
  assert.deepEqual(store.search(QUERY), [])
})

test('candidates above the floor are kept and ranked', async () => {
  await seed([0.30, 0.55, 0.47, 0.38])
  const out = store.search(QUERY)
  assert.equal(out.length, 2, 'only the two above the floor')
  assert.ok(out[0].score > out[1].score)
  assert.ok(out.every((n) => n.score >= 0.44))
})

test('top-k defaults to 10 — enough context now that a note contributes more than a title and a URL', async () => {
  await seed(Array.from({ length: 25 }, () => 0.7))
  assert.equal(store.search(QUERY).length, 10)
  assert.equal(store.search(QUERY, 3).length, 3, 'an explicit k still wins')
})

test('the floor can be disabled for a caller that wants raw ranking', async () => {
  await seed([0.43, 0.36, 0.33])
  assert.equal(store.search(QUERY, 10, { floor: 0 }).length, 3)
})

test('hybridSearch: an out-of-library question yields an empty context from BOTH retrievers', async () => {
  // Below the floor semantically AND with no term overlap — the combination
  // that has to reach the prompt empty for the model to say nothing is saved.
  await seed([0.43, 0.36, 0.33])
  assert.deepEqual(store.hybridSearch(QUERY, 'quantum chromodynamics lattice gauge'), [])
})

test('hybridSearch: a keyword hit still surfaces a note the floor dropped', async () => {
  // The point of fusing. A rare literal token is exactly what cosine loses,
  // and the floor would otherwise bury it for good.
  await store.addNote({ title: 'irrelevant', content: 'nothing here', embedding: at(0.9) })
  await store.addNote({ title: 'Ottolenghi', content: 'a recipe by Ottolenghi', embedding: at(0.2) })
  const out = store.hybridSearch(QUERY, 'Ottolenghi')
  assert.ok(out.some((n) => n.title === 'Ottolenghi'), 'the keyword-only match must survive the floor')
})

test('hybridSearch with no query embedding degrades to keyword-only rather than throwing', async () => {
  await store.addNote({ title: 'Ottolenghi', content: 'a recipe by Ottolenghi', embedding: at(0.9) })
  const out = store.hybridSearch(null, 'Ottolenghi')
  assert.equal(out.length, 1)
})

test('hybridSearch pulls deeper than k from each retriever so fusion has something to fuse', async () => {
  // 25 equally-similar notes: cosine alone would hand fusion exactly 10 and a
  // consensus candidate ranked 11th by both could never be recovered. The
  // deeper pull is observable as the keyword list reordering the result.
  for (let i = 0; i < 25; i++) {
    await store.addNote({ title: `note ${i}`, content: i === 24 ? 'ottolenghi special' : `note ${i}`, embedding: at(0.7) })
  }
  const out = store.hybridSearch(QUERY, 'ottolenghi')
  assert.equal(out.length, 10)
  assert.equal(out[0].content, 'ottolenghi special', 'the keyword match is promoted to the top by fusion')
})
