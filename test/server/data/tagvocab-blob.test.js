// The tag registry stores its vectors the same way notes do: a Float32 BLOB,
// not JSON text.
//
// This table is the larger half of the problem the note change solved. On a
// real 1,686-note install it held 2,663 tag vectors as decimal text — 41.5 MB
// of a 51.5 MB database, against 6.2 MB for every note put together.
//
// The registry is derived data (rebuildFromNotes regenerates it from note
// tags), which is what makes rebuilding the table on migration an acceptable
// risk rather than a scary one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as tagvocab from '../../../server/data/tagvocab.js'
import { encodeEmbedding } from '../../../server/data/embedding.js'
import { getDb } from '../../../server/data/db.js'

const fakeEmbed = async (tag) => (tag === 'recipes' ? [1, 0, 0, 0] : [0, 1, 0, 0])

const columnType = (db) =>
  db.prepare('PRAGMA table_info(tag_vocab)').all().find((c) => c.name === 'embedding').type

const rowFor = (db, tag) => db.prepare('SELECT embedding FROM tag_vocab WHERE tag = ?').get(tag).embedding

// Recreate the pre-migration table shape: TEXT column, JSON-encoded vectors.
function seedLegacy(db, entries) {
  db.exec('DROP TABLE IF EXISTS tag_vocab')
  db.exec('CREATE TABLE tag_vocab (tag TEXT PRIMARY KEY, embedding TEXT NOT NULL)')
  const ins = db.prepare('INSERT INTO tag_vocab (tag, embedding) VALUES (?, ?)')
  for (const [tag, vec] of entries) ins.run(tag, JSON.stringify(vec))
}

// ---- writing ------------------------------------------------------------

test('a newly registered tag is persisted as a blob, 4 bytes per dimension', async () => {
  tagvocab._reset()
  await tagvocab.canonicalize(['recipes'], { embed: fakeEmbed })
  const db = await getDb()
  assert.equal(rowFor(db, 'recipes').byteLength, 16, '4 dims × 4 bytes')
})

test('a fresh database declares the column BLOB, not TEXT', async () => {
  tagvocab._reset()
  assert.equal(columnType(await getDb()), 'BLOB')
})

test('rebuildFromNotes persists blobs too', async () => {
  tagvocab._reset()
  await tagvocab.rebuildFromNotes([{ tags: ['recipes'] }], { embed: fakeEmbed })
  assert.equal(rowFor(await getDb(), 'recipes').byteLength, 16)
})

// ---- reading ------------------------------------------------------------

test('load rehydrates blobs into vectors the similarity code can use', async () => {
  tagvocab._reset({ loaded: false })
  const db = await getDb()
  db.prepare('INSERT INTO tag_vocab (tag, embedding) VALUES (?, ?)').run('recipes', encodeEmbedding([1, 0, 0, 0]))
  await tagvocab.load()
  assert.equal(tagvocab.size(), 1)
  // Snapping a near-duplicate is the whole reason the vectors are stored.
  const out = await tagvocab.canonicalize(['cooking'], { embed: async () => [0.97, 0.24, 0, 0] })
  assert.deepEqual(out, ['recipes'])
})

// ---- migrating an existing install --------------------------------------

test('legacy JSON-text rows are converted to blobs on load, and the column is rebuilt as BLOB', async () => {
  tagvocab._reset({ loaded: false })
  const db = await getDb()
  seedLegacy(db, [['recipes', [1, 0, 0, 0]], ['travel', [0, 1, 0, 0]]])
  assert.equal(columnType(db), 'TEXT', 'precondition: the old shape')

  await tagvocab.load()

  assert.equal(columnType(db), 'BLOB', 'the declared type is rebuilt, not just the values')
  assert.equal(rowFor(db, 'recipes').byteLength, 16)
  assert.equal(rowFor(db, 'travel').byteLength, 16)
  assert.equal(tagvocab.size(), 2, 'no entry lost')
})

test('the migrated registry still snaps correctly — the vectors survived the round trip', async () => {
  tagvocab._reset({ loaded: false })
  seedLegacy(await getDb(), [['recipes', [1, 0, 0, 0]]])
  await tagvocab.load()
  const out = await tagvocab.canonicalize(['cooking'], { embed: async () => [0.97, 0.24, 0, 0] })
  assert.deepEqual(out, ['recipes'])
})

test('migration is idempotent — a second load rewrites nothing', async () => {
  tagvocab._reset({ loaded: false })
  const db = await getDb()
  seedLegacy(db, [['recipes', [1, 0, 0, 0]]])
  await tagvocab.load()
  const first = rowFor(db, 'recipes')

  tagvocab._reset({ loaded: false, keepDb: true })
  await tagvocab.load()
  assert.equal(columnType(db), 'BLOB')
  assert.deepEqual([...rowFor(db, 'recipes')], [...first])
})

test('a corrupt legacy row is dropped with a warning rather than failing the boot', async () => {
  // The registry is derived: losing one entry costs a single re-embed later,
  // whereas throwing here would take the whole server down on start.
  tagvocab._reset({ loaded: false })
  const db = await getDb()
  seedLegacy(db, [['recipes', [1, 0, 0, 0]]])
  db.prepare('INSERT INTO tag_vocab (tag, embedding) VALUES (?, ?)').run('broken', 'not json at all')

  await tagvocab.load()

  assert.equal(tagvocab.size(), 1, 'the good entry survived')
  assert.equal(columnType(db), 'BLOB')
  assert.equal(db.prepare('SELECT count(*) n FROM tag_vocab').get().n, 1)
})

test('an empty legacy table migrates its schema without incident', async () => {
  tagvocab._reset({ loaded: false })
  const db = await getDb()
  seedLegacy(db, [])
  await tagvocab.load()
  assert.equal(columnType(db), 'BLOB')
  assert.equal(tagvocab.size(), 0)
})
