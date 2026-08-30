// GET /api/backup — an online backup of the live database.
//
// The point of VACUUM INTO rather than copying the file: the database runs in
// WAL mode, so kothai.db on disk is only part of the story. Copying it while
// the server runs can capture a torn state; VACUUM INTO reads one consistent
// snapshot (committed WAL frames included) and writes a compacted database,
// with no need to stop the container first. That is what makes this usable on
// a PaaS where you cannot stop-and-tar.
//
// Driven through a real listening server: the response is a binary stream, and
// the assertion that matters is that the bytes coming out open as a database.
import { test, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// Its own data directory, set before anything imports config.js (which freezes
// its resolution at import time). The route writes a temp snapshot into
// DATA_DIR, and pointing that at the developer's real ./data would litter it.
const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'kothai-backup-test-'))
process.env.STASH_DATA_DIR = DATA_DIR

// The backup refuses to run mid-import; mocked so that state can be driven
// without actually importing anything. Must be installed before router.js
// pulls the real module in.
let importRunning = false
mock.module('../../../server/routes/import.js', {
  namedExports: {
    isImportInProgress: () => importRunning,
    handleImport: async () => {},
  },
})

const store = await import('../../../server/data/notes.js')
const { createServer } = await import('../../../server/router.js')

const server = createServer()
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`
after(() => {
  server.close()
  rmSync(DATA_DIR, { recursive: true, force: true })
})

// Save the downloaded bytes and open them as a database.
async function downloadAndOpen(res) {
  const file = path.join(DATA_DIR, `downloaded-${Math.trunc(performance.now() * 1000)}.db`)
  writeFileSync(file, Buffer.from(await res.arrayBuffer()))
  return new DatabaseSync(file, { readOnly: true })
}

const leftoverTemps = () => readdirSync(DATA_DIR).filter((f) => f.startsWith('backup-'))

// Cleanup runs in the handler's finally, which lands a tick or two after the
// client has received its last byte — so "no temp file survives" is a promise
// about the end state, not about the instant the download completes.
async function waitForCleanup(timeoutMs = 2000) {
  const deadline = performance.now() + timeoutMs
  while (leftoverTemps().length && performance.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10))
  }
  return leftoverTemps()
}

// Waits for any previous backup to finish before starting another. The route
// deliberately allows only one at a time, so back-to-back requests in a test
// file would otherwise race the guard rather than test anything.
async function backup() {
  await waitForCleanup()
  return fetch(`${BASE}/api/backup`)
}

test('the response is a real SQLite database containing the live notes', async () => {
  store._reset()
  await store.addNote({ type: 'text', content: 'in the backup' })

  const res = await backup()
  assert.equal(res.status, 200)

  const db = await downloadAndOpen(res)
  const rows = db.prepare('SELECT data FROM notes').all()
  assert.equal(rows.length, 1)
  assert.equal(JSON.parse(rows[0].data).content, 'in the backup')
})

test('it is served as a dated file download, not rendered inline', async () => {
  store._reset()
  const res = await backup()
  const disposition = res.headers.get('content-disposition')
  assert.match(disposition, /^attachment;/)
  assert.match(disposition, /filename="kothai-backup-\d{4}-\d{2}-\d{2}\.db"/)
  assert.doesNotMatch(res.headers.get('content-type') || '', /text|html/)
  await res.arrayBuffer()
})

test('Content-Length matches the bytes actually sent, so the browser can show progress', async () => {
  store._reset()
  await store.addNote({ type: 'text', content: 'x' })
  const res = await backup()
  const declared = Number(res.headers.get('content-length'))
  const actual = (await res.arrayBuffer()).byteLength
  assert.equal(declared, actual)
})

test('the temp snapshot is deleted afterwards — a backup must not double disk use forever', async () => {
  store._reset()
  await store.addNote({ type: 'text', content: 'x' })
  assert.deepEqual(await waitForCleanup(), [], 'precondition: earlier tests cleaned up after themselves')
  const res = await backup()
  await res.arrayBuffer()
  assert.deepEqual(await waitForCleanup(), [], 'this backup cleaned up too')
})

test('writes queued by a batched operation are committed first, so they are in the backup', async () => {
  // addNote({ persist: false }) leaves the row in an in-memory queue. Without
  // a flush the backup would silently omit it — a backup that quietly drops
  // recent data is worse than one that fails.
  store._reset()
  await store.addNote({ type: 'text', content: 'queued not yet written' }, { persist: false })
  const res = await backup()
  const db = await downloadAndOpen(res)
  assert.equal(db.prepare('SELECT count(*) n FROM notes').get().n, 1)
})

test('it refuses while an import is running rather than snapshotting a half-written library', async () => {
  store._reset()
  importRunning = true
  try {
    const res = await backup()
    assert.equal(res.status, 409)
    assert.equal((await res.json()).code, 'import_in_progress')
  } finally {
    importRunning = false
  }
  assert.deepEqual(await waitForCleanup(), [], 'a refused backup leaves no temp file')
})

test('two backups at once are refused rather than both writing a full copy of the database', async () => {
  store._reset()
  for (let i = 0; i < 50; i++) await store.addNote({ type: 'text', content: 'x'.repeat(200) })
  await waitForCleanup()
  const [a, b] = await Promise.all([fetch(`${BASE}/api/backup`), fetch(`${BASE}/api/backup`)])
  const codes = [a.status, b.status].sort()
  await Promise.all([a.arrayBuffer(), b.arrayBuffer()])
  assert.deepEqual(codes, [200, 409], 'one wins, the other is told to retry')
})

test('a backup can be taken again immediately after one finishes', async () => {
  // The in-flight guard must be released on every path, or the endpoint works
  // exactly once per process.
  store._reset()
  assert.equal((await (await backup()).arrayBuffer()).byteLength > 0, true)
  const second = await backup()
  assert.equal(second.status, 200)
  await second.arrayBuffer()
})

test('no temp snapshot survives the whole run, including the one the concurrent test lost', async () => {
  assert.deepEqual(await waitForCleanup(), [])
})
