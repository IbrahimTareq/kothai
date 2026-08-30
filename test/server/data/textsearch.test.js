// Unit tests for notes.textSearch — the keyword fallback used by Ask when the
// embedding model is off. The note list is passed explicitly (no disk).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { textSearch, queryTerms } from '../../../server/data/notes.js'

const NOTES = [
  { id: 'a', title: 'Sourdough starter guide', summary: 'baking bread at home', content: '', tags: ['baking', 'bread'], embedding: [1] },
  { id: 'b', title: 'React hooks', summary: '', content: 'useEffect cleanup patterns', tags: ['react'], embedding: null },
  { id: 'c', title: 'Trip to Kyoto', summary: 'travel notes', content: 'temples and food', tags: ['travel', 'japan'] },
]

test('matches across title, tags, summary and content', () => {
  assert.equal(textSearch('bread baking', 6, NOTES)[0].id, 'a')
  assert.equal(textSearch('useeffect', 6, NOTES)[0].id, 'b')
  assert.equal(textSearch('kyoto temples', 6, NOTES)[0].id, 'c')
})

test('ranks by fraction of query terms hit', () => {
  const out = textSearch('bread travel', 6, NOTES)
  assert.equal(out.length, 2)
  assert.equal(out[0].score, out[1].score) // one term each
})

test('empty and no-match queries return []', () => {
  assert.deepEqual(textSearch('', 6, NOTES), [])
  assert.deepEqual(textSearch('quantum chromodynamics', 6, NOTES), [])
})

test('respects k and strips embeddings', () => {
  // Two terms each for notes a and c, so both clear the two-hit bar a query
  // this long has to meet (see the term-selection tests below).
  const out = textSearch('bread baking kyoto travel', 1, NOTES)
  assert.equal(out.length, 1)
  assert.ok(out.every((n) => !('embedding' in n)))
  assert.equal(textSearch('bread baking kyoto travel', 6, NOTES).length, 2)
})

test('link/video notes are findable via siteTitle/siteDesc when title/content are just heuristic placeholders', () => {
  const linkNotes = [
    { id: 'd', title: 'https://example.com/foo', content: 'https://example.com/foo', tags: [], siteTitle: 'Understanding Quantum Entanglement', siteDesc: 'A beginner-friendly explainer on entangled particles' },
  ]
  assert.equal(textSearch('entanglement', 6, linkNotes)[0].id, 'd')
  assert.equal(textSearch('quantum', 6, linkNotes)[0].id, 'd')
})

test('link notes are findable by article body text alone', () => {
  const withArticle = [
    {
      id: 'e',
      title: 'https://example.com/bread',
      content: 'https://example.com/bread',
      tags: [],
      siteTitle: 'A Baking Post',
      siteDesc: 'Some thoughts on baking',
      article: 'Autolyse is the resting period after flour and water are first combined.',
    },
  ]
  // "autolyse" appears only in the article body — not in title, siteTitle or
  // siteDesc — so this fails unless article joined the haystack.
  assert.equal(textSearch('autolyse', 6, withArticle)[0].id, 'e')
})

test('video notes are findable by their thumbnail vision description alone', () => {
  const reel = [
    {
      id: 'f',
      title: 'Brown butter pasta',
      content: 'https://www.instagram.com/reel/ABC/',
      url: 'https://www.instagram.com/reel/ABC/',
      tags: [],
      siteDesc: 'chefsteps Three ingredients and ten minutes.',
      thumbDescription: 'A skillet on a wooden board, overlay text reads BEST PASTA EVER.',
    },
  ]
  // "skillet" and "overlay" appear only in the thumbnail description — the
  // single richest retrieval key a video note has, and one that was thrown
  // away entirely before it was persisted.
  assert.equal(textSearch('skillet', 6, reel)[0].id, 'f')
  assert.equal(textSearch('wooden board', 6, reel)[0].id, 'f')
})

// ---- query term selection ------------------------------------------------
// Scoring is "fraction of query terms present", which treats every term as
// equally informative. That was harmless while this was only the fallback for
// a disabled embedding model; once it became half of hybrid retrieval, an
// unanswerable question came back with a full page of confident-looking noise
// matched on the word "the". Measured on the live library before this:
// "the" appeared in 71% of notes and "and" in 79%, while every genuinely
// discriminating term sat below 1%.

test('stopwords are dropped, so a question\'s scaffolding cannot match the whole library', () => {
  const notes = [{ id: 'a', title: 'The quick brown fox and the dog', content: '', tags: [] }]
  // Every term here is scaffolding: nothing is actually being asked about.
  assert.deepEqual(textSearch('what did I save about the and', 6, notes), [])
  // The same note is still found by its content words.
  assert.equal(textSearch('brown fox', 6, notes)[0].id, 'a')
})

test('a term present in most of the library is dropped whatever language it is in', () => {
  // No stopword list can cover every language the captions are in, so the
  // frequency cutoff is what actually generalises.
  const notes = Array.from({ length: 20 }, (_, i) => ({ id: `n${i}`, title: `الصور ${i}`, content: '', tags: [] }))
  notes[0].title = 'الصور ramadan'
  assert.equal(textSearch('الصور ramadan', 6, notes)[0].id, 'n0')
  // 'الصور' is in 100% of them, so only 'ramadan' does any work.
  assert.equal(textSearch('الصور ramadan', 6, notes).length, 1)
})

test('terms match at a word start, so a rare query word cannot hide inside a longer one', () => {
  const notes = [{ id: 'a', title: 'underground wonderful thunder', content: '', tags: [] }]
  // "derg" inside "underground" was how an out-of-library question kept
  // finding matches for its most discriminating word.
  assert.deepEqual(textSearch('derg', 6, notes), [])
  // Stem and plural matches, which make this retriever useful, still work.
  const plural = [{ id: 'b', title: 'game controllers', content: '', tags: [] }]
  assert.equal(textSearch('controller', 6, plural)[0].id, 'b')
})

test('a long query must hit at least two terms; a short one still needs only one', () => {
  const notes = [{ id: 'a', title: 'lattice screen in a living room', content: '', tags: [] }, { id: 'b', title: 'unrelated', content: '', tags: [] }]
  // Five content terms, one incidental match — a coincidence, not an answer.
  assert.deepEqual(textSearch('quantum chromodynamics lattice gauge theory', 6, notes), [])
  // Two terms asked as a conjunction would be a phrase search nobody wanted.
  assert.equal(textSearch('lattice pattern', 6, notes)[0].id, 'a')
  assert.equal(textSearch('lattice', 6, notes)[0].id, 'a')
})

test('queryTerms keeps content words and drops a query that has none', () => {
  // A query made entirely of stopwords is asking about nothing; best-effort
  // noise is a worse answer than no answer.
  assert.deepEqual(queryTerms('the and of what'), [])
  assert.deepEqual(queryTerms('brown butter'), ['brown', 'butter'])
  assert.deepEqual(queryTerms('what did I save about pasta'), ['pasta'])
  assert.deepEqual(queryTerms(''), [])
})

test('a term that is merely common IN THIS LIBRARY still counts when nothing else does', () => {
  // Unlike a stopword, it is genuinely what was asked about — dropping every
  // term of a question about the library's dominant subject would make that
  // question unanswerable.
  const allPasta = Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, title: `pasta ${i}`, content: '', tags: [] }))
  assert.equal(textSearch('pasta', 6, allPasta).length, 6)
})
