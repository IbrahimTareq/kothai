// Embeddings are stored in their own Float32 BLOB column rather than inside
// the note's JSON `data` blob.
//
// Why: a 1024-dim embedding serialised as JSON is ~20 KB of decimal text
// ("-0.023456789012345678" per component); the same vector as float32 is 4 KB,
// and it no longer has to be re-serialised every time any OTHER field of the
// note changes. Enrichment patches one field at a time, so that second effect
// is the larger one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as store from '../../../server/data/notes.js'
import { encodeEmbedding, decodeEmbedding } from '../../../server/data/notes.js'
import { getDb } from '../../../server/data/db.js'
import { deriveAiMarkers } from '../../../server/ai/backlog.js'

const vec = (n) => Array.from({ length: n }, (_, i) => Math.sin(i) )
// float32 keeps ~7 significant digits; cosine similarity does not care, but
// the tests should not pretend the round trip is exact.
const closeTo = (a, b, eps = 1e-6) => Math.abs(a - b) < eps

// ---- the codec ----------------------------------------------------------

test('encode/decode round-trips a vector within float32 precision', () => {
  const original = vec(8)
  const back = decodeEmbedding(encodeEmbedding(original))
  assert.equal(back.length, 8)
  for (let i = 0; i < original.length; i++) {
    assert.ok(closeTo(back[i], original[i]), `component ${i}: ${back[i]} vs ${original[i]}`)
  }
})

test('encode produces exactly 4 bytes per dimension — the whole point of the change', () => {
  assert.equal(encodeEmbedding(vec(1024)).byteLength, 4096)
})

test('encode returns null for the absent cases, so the column holds NULL rather than an empty blob', () => {
  assert.equal(encodeEmbedding(null), null)
  assert.equal(encodeEmbedding(undefined), null)
  assert.equal(encodeEmbedding([]), null)
})

test('decode returns null for NULL and empty blobs', () => {
  assert.equal(decodeEmbedding(null), null)
  assert.equal(decodeEmbedding(undefined), null)
  assert.equal(decodeEmbedding(new Uint8Array(0)), null)
})

test('decode copies rather than viewing, so a blob at a non-multiple-of-4 offset still decodes', () => {
  // node:sqlite hands back a Uint8Array that may be a view into a larger
  // buffer at an arbitrary offset. Constructing a Float32Array directly over
  // an unaligned offset throws, so the decoder has to copy.
  const bytes = new Uint8Array(encodeEmbedding([1, 2, 3, 4]))
  const backing = new Uint8Array(bytes.byteLength + 1)
  backing.set(bytes, 1)
  const unaligned = backing.subarray(1)
  assert.equal(unaligned.byteOffset, 1)
  assert.deepEqual([...decodeEmbedding(unaligned)], [1, 2, 3, 4])
})

// ---- persistence --------------------------------------------------------

test('a saved note keeps its embedding in the BLOB column and out of the JSON', async () => {
  store._reset()
  const { id } = await store.addNote({ type: 'text', content: 'hello', embedding: vec(16) })
  const db = await getDb()
  const row = db.prepare('SELECT data, embedding FROM notes WHERE id = ?').get(id)
  assert.equal(row.embedding.byteLength, 64, '16 dims × 4 bytes')
  assert.ok(!('embedding' in JSON.parse(row.data)), 'the JSON must no longer carry the vector')
  assert.equal(JSON.parse(row.data).content, 'hello', 'every other field still round-trips')
})

test('an embedding added later by enrichment lands in the BLOB column too', async () => {
  store._reset()
  const { id } = await store.addNote({ type: 'text', content: 'hi' })
  const db = await getDb()
  assert.equal(db.prepare('SELECT embedding FROM notes WHERE id = ?').get(id).embedding, null)
  await store.updateNote(id, { embedding: vec(16) })
  assert.equal(db.prepare('SELECT embedding FROM notes WHERE id = ?').get(id).embedding.byteLength, 64)
})

test('a reload rehydrates embeddings from the blob and search can use them', async () => {
  store._reset({ loaded: false })
  const db = await getDb()
  const target = vec(16)
  db.prepare('INSERT INTO notes (id, data, embedding) VALUES (?, ?, ?)')
    .run('n1', JSON.stringify({ id: 'n1', type: 'text', content: 'a' }), encodeEmbedding(target))
  await store.load()
  const hits = store.search(target, 1)
  assert.equal(hits.length, 1, 'the rehydrated vector is searchable')
  assert.ok(hits[0].score > 0.999, 'and scores ~1 against itself')
  assert.ok(!('embedding' in hits[0]), 'still stripped from the response')
})

// ---- migrating the existing database ------------------------------------

test('a legacy row with the vector inside its JSON is migrated into the blob column on load', async () => {
  store._reset({ loaded: false })
  const db = await getDb()
  const legacy = vec(16)
  db.prepare('INSERT INTO notes (id, data) VALUES (?, ?)')
    .run('old', JSON.stringify({ id: 'old', type: 'text', content: 'a', embedding: legacy }))
  await store.load()

  const row = db.prepare('SELECT data, embedding FROM notes WHERE id = ?').get('old')
  assert.equal(row.embedding.byteLength, 64, 'moved into the blob')
  assert.ok(!('embedding' in JSON.parse(row.data)), 'and out of the JSON')
  // The in-memory copy has to be usable immediately, not only after a restart.
  assert.ok(store.search(legacy, 1)[0].score > 0.999)
})

test('migration is idempotent — a second load rewrites nothing', async () => {
  store._reset({ loaded: false })
  const db = await getDb()
  db.prepare('INSERT INTO notes (id, data) VALUES (?, ?)')
    .run('old', JSON.stringify({ id: 'old', type: 'text', content: 'a', embedding: vec(16) }))
  await store.load()
  const first = db.prepare('SELECT data, embedding FROM notes WHERE id = ?').get('old')

  store._reset({ loaded: false, keepDb: true })
  await store.load()
  const second = db.prepare('SELECT data, embedding FROM notes WHERE id = ?').get('old')
  assert.equal(second.data, first.data)
  assert.deepEqual([...second.embedding], [...first.embedding])
})

test('a legacy row with no embedding at all is left alone', async () => {
  store._reset({ loaded: false })
  const db = await getDb()
  db.prepare('INSERT INTO notes (id, data) VALUES (?, ?)').run('bare', JSON.stringify({ id: 'bare', type: 'text', content: 'a' }))
  await store.load()
  const row = db.prepare('SELECT embedding FROM notes WHERE id = ?').get('bare')
  assert.equal(row.embedding, null)
})

// ---- the type change's blast radius -------------------------------------

test('deriveAiMarkers still recognises a Float32Array embedding as "embed already ran"', async () => {
  // The regression this change invites: backlog.js decided embedding had run
  // with Array.isArray(), which a Float32Array fails. Left unfixed, every note
  // would re-enter the enrichment backlog on every boot and be re-embedded
  // forever.
  const markers = deriveAiMarkers({ embedding: decodeEmbedding(encodeEmbedding(vec(8))) })
  assert.equal(markers.embed, true)
})

test('search skips notes with no embedding without throwing', async () => {
  store._reset()
  await store.addNote({ type: 'text', content: 'no vector here' })
  await store.addNote({ type: 'text', content: 'has one', embedding: vec(16) })
  const hits = store.search(vec(16), 5)
  assert.equal(hits.length, 1)
})

// ---- write amplification ------------------------------------------------
// The size win on disk is the smaller half. Enrichment patches a note one
// field at a time (title, then summary, then tags…), and each of those used to
// re-serialise the vector along with everything else. The vector is ~3 KB
// against ~1 KB for all the other fields put together, so not touching it is
// most of the saving.

test('an update that does not name the embedding leaves the blob column untouched', async () => {
  store._reset()
  const { id } = await store.addNote({ type: 'text', content: 'a', embedding: vec(16) })
  const db = await getDb()
  // A sentinel that differs from the in-memory vector makes the rewrite
  // observable: if the UPDATE still listed `embedding`, this would be
  // clobbered by the in-memory value.
  db.prepare('UPDATE notes SET embedding = ? WHERE id = ?').run(encodeEmbedding([9, 9, 9, 9]), id)

  await store.updateNote(id, { summary: 'changed' })

  const row = db.prepare('SELECT data, embedding FROM notes WHERE id = ?').get(id)
  assert.deepEqual([...decodeEmbedding(row.embedding)], [9, 9, 9, 9], 'column not rewritten')
  assert.equal(JSON.parse(row.data).summary, 'changed', 'the rest of the row still updated')
})

test('an update that does name the embedding writes it', async () => {
  store._reset()
  const { id } = await store.addNote({ type: 'text', content: 'a' })
  await store.updateNote(id, { embedding: vec(8) })
  const db = await getDb()
  assert.equal(db.prepare('SELECT embedding FROM notes WHERE id = ?').get(id).embedding.byteLength, 32)
})

test('the same rule holds for batched { persist: false } writes', async () => {
  // The settings re-embed batches thousands of updates; the flag has to travel
  // with each queued closure rather than being read at flush time.
  store._reset()
  const { id } = await store.addNote({ type: 'text', content: 'a', embedding: vec(16) })
  const db = await getDb()
  db.prepare('UPDATE notes SET embedding = ? WHERE id = ?').run(encodeEmbedding([9, 9, 9, 9]), id)
  await store.updateNote(id, { summary: 'batched' }, { persist: false })
  await store.flush()
  assert.deepEqual([...decodeEmbedding(db.prepare('SELECT embedding FROM notes WHERE id = ?').get(id).embedding)], [9, 9, 9, 9])
})
