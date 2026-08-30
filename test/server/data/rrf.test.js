// Unit tests for reciprocal-rank fusion — the pure function that merges the
// cosine and keyword result lists Ask retrieves with.
//
// The property worth protecting is that fusion uses only ORDER. The two
// retrievers produce scores on incompatible scales (a cosine similarity in a
// narrow band around 0.3-0.8 versus "fraction of query terms present"), so
// any behaviour that leaks a raw score into the ranking is a bug that will
// resurface the next time the embedding model changes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reciprocalRankFusion } from '../../../server/data/notes.js'

const ids = (out) => out.map((n) => n.id)

test('a note both retrievers rank well beats a note only one of them ranks first', () => {
  const dense = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const sparse = [{ id: 'd' }, { id: 'b' }, { id: 'e' }]
  // b is 2nd on both lists; a and d are 1st on one list and absent from the
  // other. Consensus wins — that is the whole point of fusing.
  assert.equal(ids(reciprocalRankFusion([dense, sparse]))[0], 'b')
})

test('a note only one retriever found still surfaces — one strong signal is enough', () => {
  const dense = [{ id: 'a' }]
  const sparse = [{ id: 'z' }]
  const out = ids(reciprocalRankFusion([dense, sparse]))
  assert.deepEqual(out.sort(), ['a', 'z'])
})

test('ranking depends only on position, never on the incoming scores', () => {
  // Same order, wildly different score scales on each side. If a raw score
  // leaked into the ranking, these two calls would disagree.
  const withScores = reciprocalRankFusion([
    [{ id: 'a', score: 0.81 }, { id: 'b', score: 0.79 }],
    [{ id: 'b', score: 1 }, { id: 'c', score: 0.33 }],
  ])
  const withoutScores = reciprocalRankFusion([
    [{ id: 'a' }, { id: 'b' }],
    [{ id: 'b' }, { id: 'c' }],
  ])
  assert.deepEqual(ids(withScores), ids(withoutScores))
})

test('the output score is the fused rank score, and it orders the result', () => {
  const out = reciprocalRankFusion([[{ id: 'a' }, { id: 'b' }], [{ id: 'a' }]])
  assert.equal(out[0].id, 'a')
  // 1/(60+1) + 1/(60+1) for a; 1/(60+2) for b.
  assert.ok(Math.abs(out[0].score - 2 / 61) < 1e-12)
  assert.ok(Math.abs(out[1].score - 1 / 62) < 1e-12)
  assert.ok(out[0].score > out[1].score)
})

test('duplicated notes are merged once, keeping the first list\'s copy of the fields', () => {
  const out = reciprocalRankFusion([
    [{ id: 'a', title: 'from dense' }],
    [{ id: 'a', title: 'from sparse' }],
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].title, 'from dense')
})

test('empty lists are absorbed — an empty retriever degrades fusion to the other one', () => {
  assert.deepEqual(reciprocalRankFusion([[], []]), [])
  assert.deepEqual(ids(reciprocalRankFusion([[], [{ id: 'x' }, { id: 'y' }]])), ['x', 'y'])
  assert.deepEqual(ids(reciprocalRankFusion([])), [])
})

test('a smaller K sharpens the advantage of a first-place rank; the default damps it', () => {
  const lists = [[{ id: 'top' }], [{ id: 'mid' }, { id: 'mid2' }, { id: 'mid3' }]]
  // At K=60 the gap between rank 1 and rank 3 is tiny; at K=1 it is large.
  const damped = reciprocalRankFusion(lists)
  const sharp = reciprocalRankFusion(lists, { k: 1 })
  const gap = (out) => out[0].score / out[out.length - 1].score
  assert.ok(gap(sharp) > gap(damped))
})

test('order is preserved for a single list — fusing one retriever is a no-op on ranking', () => {
  const one = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  assert.deepEqual(ids(reciprocalRankFusion([one])), ['a', 'b', 'c'])
})
