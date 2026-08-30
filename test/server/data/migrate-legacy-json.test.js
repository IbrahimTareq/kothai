// Tests for server/data/migrate.js — importing the old flat-JSON store
// (data/*.json) into SQLite the first time data/kothai.db is created.
// STASH_DATA_DIR is pointed at a scratch temp dir BEFORE any server module
// is imported (config.js resolves it once, at import time), so this exercises
// the real DATA_DIR/readJson path rather than a stubbed one.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { decodeEmbedding } from '../../../server/data/embedding.js'

const scratch = mkdtempSync(path.join(tmpdir(), 'kothai-migrate-'))
process.env.STASH_DATA_DIR = scratch

const { DATA_DIR } = await import('../../../server/data/json.js')
const { migrateLegacyJson } = await import('../../../server/data/migrate.js')
assert.equal(DATA_DIR, scratch) // sanity: env var actually took

const SCHEMA = `
CREATE TABLE notes (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
CREATE TABLE collections (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
CREATE TABLE chats (seq INTEGER NOT NULL, id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1), llm TEXT NOT NULL, embed TEXT NOT NULL, vision TEXT NOT NULL,
  residency_llm TEXT NOT NULL, residency_embed TEXT NOT NULL, residency_vision TEXT NOT NULL,
  configured INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE tag_vocab (tag TEXT PRIMARY KEY, embedding BLOB NOT NULL);
`

function write(name, data) {
  writeFileSync(path.join(scratch, name), JSON.stringify(data))
}

function freshDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA)
  return db
}

after(() => rmSync(scratch, { recursive: true, force: true }))

test('notes: array order (newest-first) survives the round trip via seq', async () => {
  write('notes.json', [
    { id: 'newest', createdAt: '2026-01-03T00:00:00.000Z', title: 'C' },
    { id: 'middle', createdAt: '2026-01-02T00:00:00.000Z', title: 'B' },
    { id: 'oldest', createdAt: '2026-01-01T00:00:00.000Z', title: 'A' },
  ])
  const db = freshDb()
  await migrateLegacyJson(db)
  const rows = db.prepare('SELECT data FROM notes ORDER BY seq DESC').all().map((r) => JSON.parse(r.data))
  assert.deepEqual(rows.map((r) => r.id), ['newest', 'middle', 'oldest'])
  assert.equal(rows[0].title, 'C') // full record preserved, not just id/order
  assert.equal(existsSync(path.join(scratch, 'notes.json')), false)
  assert.equal(existsSync(path.join(scratch, 'notes.json.migrated')), true)
  rmSync(path.join(scratch, 'notes.json.migrated'))
})

test('collections: array order (newest-first) survives the round trip', async () => {
  write('collections.json', [
    { id: 's-new', name: 'New', tags: [], itemIds: [], removedIds: [] },
    { id: 's-old', name: 'Old', tags: [], itemIds: [], removedIds: [] },
  ])
  const db = freshDb()
  await migrateLegacyJson(db)
  const rows = db.prepare('SELECT id FROM collections ORDER BY seq DESC').all()
  assert.deepEqual(rows.map((r) => r.id), ['s-new', 's-old'])
})

test('chats: MRU order survives via an explicit seq (not insertion order)', async () => {
  write('chats.json', [
    { id: 'front', title: 'Most recently touched', createdAt: 't', updatedAt: 't', messages: [] },
    { id: 'back', title: 'Oldest', createdAt: 't', updatedAt: 't', messages: [{ role: 'user', text: 'hi' }] },
  ])
  const db = freshDb()
  await migrateLegacyJson(db)
  const rows = db.prepare('SELECT data FROM chats ORDER BY seq DESC').all().map((r) => JSON.parse(r.data))
  assert.deepEqual(rows.map((r) => r.id), ['front', 'back'])
  assert.deepEqual(rows[1].messages, [{ role: 'user', text: 'hi' }])
})

test('settings: legacy shape maps onto the typed row', async () => {
  write('settings.json', { llm: 'CUSTOM_LLM', configured: true, residency: { llm: 'always', embed: 'off', vision: 'ondemand' } })
  const db = freshDb()
  await migrateLegacyJson(db)
  const row = db.prepare('SELECT * FROM settings WHERE id = 1').get()
  assert.equal(row.llm, 'CUSTOM_LLM')
  assert.equal(row.configured, 1)
  assert.equal(row.residency_llm, 'always')
  assert.equal(row.residency_embed, 'off')
})

test('tag_vocab: registry entries all land, order-independent', async () => {
  write('tag-embeddings.json', { cooking: [0.1, 0.2], travel: [0.3, 0.4] })
  const db = freshDb()
  await migrateLegacyJson(db)
  const rows = db.prepare('SELECT tag, embedding FROM tag_vocab ORDER BY tag').all()
  assert.deepEqual(rows.map((r) => r.tag), ['cooking', 'travel'])
  // Stored as float32 bytes now, so compare decoded and allow the precision.
  const vec = decodeEmbedding(rows[0].embedding)
  assert.equal(vec.length, 2)
  assert.ok(Math.abs(vec[0] - 0.1) < 1e-6 && Math.abs(vec[1] - 0.2) < 1e-6)
})

test('no legacy files left: a no-op, nothing thrown', async () => {
  // Every fixture the earlier tests wrote has already been renamed to
  // .migrated by this point (that's the real rename, not a stub) — so DATA_DIR
  // now has no notes.json/collections.json/etc. left, exercising the "already
  // migrated, just booting normally" path.
  const db = freshDb()
  await assert.doesNotReject(migrateLegacyJson(db))
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notes').get().n, 0)
})

test('a crash-interrupted migration is safe to retry: already-inserted ids are skipped, not duplicated', async () => {
  write('notes.json', [{ id: 'dup', createdAt: 't', title: 'A' }])
  const db = freshDb()
  db.prepare('INSERT INTO notes (id, data) VALUES (?, ?)').run('dup', JSON.stringify({ id: 'dup', title: 'A' }))
  // notes.json still exists (as if the process died before the rename) — a
  // retry must not throw on the id it already has.
  await assert.doesNotReject(migrateLegacyJson(db))
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notes').get().n, 1)
})
