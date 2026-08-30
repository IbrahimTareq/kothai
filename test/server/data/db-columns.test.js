// Unit tests for the additive-column migration helper. db.js has only ever
// run CREATE TABLE IF NOT EXISTS, which silently does nothing to an existing
// table — so adding a column to an install that already has data needs this.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { ensureColumns } from '../../../server/data/db.js'

function db() {
  const d = new DatabaseSync(':memory:')
  d.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT NOT NULL)')
  return d
}

test('adds a column that is missing', () => {
  const d = db()
  ensureColumns(d, 't', { b: 'TEXT' })
  assert.ok(d.prepare('PRAGMA table_info(t)').all().some((c) => c.name === 'b'))
})

test('is idempotent — running twice does not throw', () => {
  const d = db()
  ensureColumns(d, 't', { b: 'TEXT' })
  ensureColumns(d, 't', { b: 'TEXT' })
  assert.equal(d.prepare('PRAGMA table_info(t)').all().filter((c) => c.name === 'b').length, 1)
})

test('leaves existing rows intact, with NULL in the new column', () => {
  const d = db()
  d.prepare('INSERT INTO t (a) VALUES (?)').run('keep me')
  ensureColumns(d, 't', { b: 'TEXT' })
  const row = d.prepare('SELECT * FROM t').get()
  assert.equal(row.a, 'keep me')
  assert.equal(row.b, null)
})

test('adds several columns in one call and skips the ones already present', () => {
  const d = db()
  ensureColumns(d, 't', { b: 'TEXT' })
  ensureColumns(d, 't', { b: 'TEXT', c: 'TEXT', d: 'INTEGER' })
  const names = d.prepare('PRAGMA table_info(t)').all().map((c) => c.name)
  assert.deepEqual(names, ['id', 'a', 'b', 'c', 'd'])
})
