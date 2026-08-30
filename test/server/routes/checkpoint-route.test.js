// POST /api/checkpoint — make data/kothai.db self-contained on disk.
//
// This exists for snapshot-based backup tools, ONCE (basecamp/once) first among
// them: they archive the whole data directory from outside the process and have
// no way to ask the app to settle first. Two things make a raw snapshot lossy,
// and neither is visible to the tool taking it:
//
//   1. Batched writes ({ persist: false }, used by the background enrichment
//      sweeps in ai/enrich.js) sit in an in-memory queue, so they are in no
//      file at all until someone flushes.
//   2. WAL mode means committed data can live in kothai.db-wal rather than
//      kothai.db, so the main file alone is an old version of the database.
//
// Unlike GET /api/backup this writes no second copy — it settles the live files
// in place, so a snapshot costs no extra disk. The assertion that matters
// throughout is that **kothai.db on its own** is complete afterwards.
//
// Deliberately runs against a REAL file-backed database in a temp directory,
// not the in-memory one store._reset() installs: every property under test here
// (WAL contents, what the main file holds) exists only on disk. An in-memory
// database would make all of these pass without proving anything.
import { test, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, copyFileSync, statSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'kothai-checkpoint-test-'))
process.env.STASH_DATA_DIR = DATA_DIR

let importRunning = false
mock.module('../../../server/routes/import.js', {
  namedExports: { isImportInProgress: () => importRunning, handleImport: async () => {} },
})

const store = await import('../../../server/data/notes.js')
const { createServer } = await import('../../../server/router.js')

await store.load()

const server = createServer()
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`
after(() => {
  server.close()
  rmSync(DATA_DIR, { recursive: true, force: true })
})

const checkpoint = () =>
  fetch(`${BASE}/api/checkpoint`, { method: 'POST', headers: { 'Content-Type': 'application/json' } })

// Copy ONLY kothai.db, leaving -wal and -shm behind, and open the copy. This is
// the whole point: if the checkpoint worked, the main file stands alone.
function contentsOfMainFileAlone(label) {
  const copy = path.join(DATA_DIR, `alone-${label}.db`)
  copyFileSync(path.join(DATA_DIR, 'kothai.db'), copy)
  const db = new DatabaseSync(copy, { readOnly: true })
  return db.prepare('SELECT data FROM notes').all().map((r) => JSON.parse(r.data).content)
}

test('a batched write reaches kothai.db itself, not just the in-memory queue', async () => {
  await store.addNote({ type: 'text', content: 'queued-not-yet-written' }, { persist: false })

  const res = await checkpoint()
  assert.equal(res.status, 200)
  assert.equal((await res.json()).ok, true)

  assert.ok(contentsOfMainFileAlone('batched').includes('queued-not-yet-written'))
})

test('the WAL is truncated, so kothai.db is not a stale copy of the database', async () => {
  await store.addNote({ type: 'text', content: 'committed-normally' })

  await (await checkpoint()).json()

  // TRUNCATE zeroes the log rather than merely folding it in. A non-empty -wal
  // after this would mean a snapshot still needs all three files to be correct.
  const wal = path.join(DATA_DIR, 'kothai.db-wal')
  if (existsSync(wal)) assert.equal(statSync(wal).size, 0, 'kothai.db-wal should be empty')

  assert.ok(contentsOfMainFileAlone('wal').includes('committed-normally'))
})

test('it refuses while an import is running rather than committing half of one', async () => {
  // import.js holds a batch of notes in memory and writes them as one
  // transaction at the end. flush() here would commit whatever half of that
  // batch has been queued so far, and the import's own rollback path could no
  // longer undo it — so a scheduled backup landing mid-import would corrupt the
  // library rather than merely capture it awkwardly. Same guard as /api/backup.
  importRunning = true
  try {
    const res = await checkpoint()
    assert.equal(res.status, 409)
    assert.equal((await res.json()).code, 'import_in_progress')
  } finally {
    importRunning = false
  }
})

test('it can run repeatedly — a backup hook fires on every scheduled backup', async () => {
  await store.addNote({ type: 'text', content: 'second-run' }, { persist: false })
  assert.equal((await (await checkpoint()).json()).ok, true)

  const contents = contentsOfMainFileAlone('repeat')
  // Everything from the earlier checkpoints is still there, plus this one's.
  assert.ok(contents.includes('queued-not-yet-written'))
  assert.ok(contents.includes('committed-normally'))
  assert.ok(contents.includes('second-run'))
})
