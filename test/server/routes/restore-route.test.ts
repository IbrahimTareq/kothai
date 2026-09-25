// POST /api/restore — put a backup from GET /api/backup back in place of the
// library, while the server keeps running.
//
// Driven through a real listening server against a real on-disk database, in
// WAL mode like production: the restore attaches the uploaded database and
// copies from it, and the stores must end up serving what it held. Every
// backup used here is one the backup route itself produced.
import { test, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { jsonBody, listenOnLoopback, text } from '../../helpers/http.ts'

// Before anything imports config.ts, which freezes its paths at import time.
const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'kothai-restore-test-'))
process.env.KOTHAI_DATA_DIR = DATA_DIR
const UPLOADS = path.join(DATA_DIR, 'uploads')
// Unpacked archives go here rather than into DATA_DIR, whose listing the
// tests read to catch anything the restore left behind.
const SCRATCH = mkdtempSync(path.join(os.tmpdir(), 'kothai-restore-scratch-'))

// A restore replaces the whole library, so it takes the import lock; mocked so
// "an import is running" can be driven without running one.
let importRunning = false
const realLock = await import('../../../server/data/import-lock.ts')
mock.module('../../../server/data/import-lock.ts', {
  namedExports: {
    ...realLock,
    isImportInProgress: () => importRunning,
    runExclusiveImport: <T>(fn: () => Promise<T>) =>
      importRunning ? Promise.resolve(null) : realLock.runExclusiveImport(fn),
  },
})

// Re-embedding is the AI layer's work; what a restore owes it is the request.
// queueJob is stubbed so the tag-vocabulary rebuild never reaches for a model.
let reembedRequests = 0
const realEnrich = await import('../../../server/ai/enrich.ts')
mock.module('../../../server/ai/enrich.ts', {
  namedExports: {
    ...realEnrich,
    queueRecipeReembed: () => {
      reembedRequests++
      return true
    },
    queueJob: async () => {},
  },
})

const store = await import('../../../server/data/notes.ts')
const collections = await import('../../../server/data/collections.ts')
const chats = await import('../../../server/data/chats.ts')
const settings = await import('../../../server/data/settings.ts')
const { getDb } = await import('../../../server/data/db.ts')
const { createServer } = await import('../../../server/router.ts')

await store.load()
await collections.load()
await chats.load()
await settings.load()

const server = createServer()
const BASE = `http://127.0.0.1:${await listenOnLoopback(server)}`
after(() => {
  server.close()
  rmSync(DATA_DIR, { recursive: true, force: true })
  rmSync(SCRATCH, { recursive: true, force: true })
})

async function emptyLibrary() {
  await store.clearAll()
  await collections.clearAll()
  await chats.clearAll()
  rmSync(UPLOADS, { recursive: true, force: true })
  mkdirSync(UPLOADS)
}

async function takeBackup(): Promise<Buffer> {
  const res = await fetch(`${BASE}/api/backup`)
  assert.equal(res.status, 200)
  return Buffer.from(await res.arrayBuffer())
}

const restore = (body: Buffer, type = 'application/octet-stream') =>
  fetch(`${BASE}/api/restore`, { method: 'POST', headers: { 'Content-Type': type }, body })

const contents = () => store.allNotes().map(n => n.content)

// Unpack an archive with the system tar, as someone with only the file would.
function unpack(archive: Buffer): string {
  const dir = mkdtempSync(path.join(SCRATCH, 'unpack-'))
  writeFileSync(path.join(dir, 'in.tar.gz'), archive)
  execFileSync('tar', ['-xzf', path.join(dir, 'in.tar.gz'), '-C', dir])
  return dir
}

// Nothing the restore staged or set aside may outlive it.
const leftovers = () => readdirSync(DATA_DIR).filter(f => /^(restore-|uploads-)/.test(f))

test('notes, spaces and chats come back as they were when the backup was taken', async () => {
  await emptyLibrary()
  const note = await store.addNote({ content: 'https://kept.example' })
  const space = await collections.create({ name: 'Reading' })
  await collections.addItem(space.id, note.id)
  await chats.appendExchange(null, { role: 'user', text: 'what did I save?' }, { role: 'ai', text: 'one link' })
  const backup = await takeBackup()

  await emptyLibrary()
  await store.addNote({ content: 'https://later.example' })

  const res = await restore(backup)
  assert.equal(res.status, 200)
  assert.deepEqual(contents(), ['https://kept.example'])
  assert.deepEqual(
    collections.all().map(c => [c.name, c.itemIds]),
    [['Reading', [note.id]]],
  )
  assert.deepEqual(
    chats.all().map(c => c.title),
    ['what did I save?'],
  )
})

test("uploaded files are swapped for the backup's, and nothing staged is left behind", async () => {
  await emptyLibrary()
  writeFileSync(path.join(UPLOADS, 'kept.png'), 'kept')
  const backup = await takeBackup()
  rmSync(path.join(UPLOADS, 'kept.png'))
  writeFileSync(path.join(UPLOADS, 'later.png'), 'later')

  assert.equal((await restore(backup)).status, 200)
  assert.deepEqual(readdirSync(UPLOADS), ['kept.png'])
  assert.equal(readFileSync(path.join(UPLOADS, 'kept.png'), 'utf8'), 'kept')
  assert.deepEqual(leftovers(), [])
})

test("this install's model settings are kept — they describe this machine, not the library", async () => {
  await emptyLibrary()
  await settings.save({ llm: 'llm-when-backed-up' })
  const backup = await takeBackup()
  await settings.save({ llm: 'llm-on-this-machine' })

  assert.equal((await restore(backup)).status, 200)
  const row = (await getDb()).prepare('SELECT llm FROM settings').get()
  assert.equal(row?.llm, 'llm-on-this-machine')
})

test('the library being replaced is saved first, as a backup that can itself be restored', async () => {
  await emptyLibrary()
  await store.addNote({ content: 'https://from-backup.example' })
  const backup = await takeBackup()
  await emptyLibrary()
  await store.addNote({ content: 'https://about-to-be-replaced.example' })

  const res = await restore(backup)
  assert.equal(res.status, 200)
  const savedAs = text((await jsonBody(res)).savedAs)
  assert.match(savedAs, /^backups\/before-restore-.+\.tar\.gz$/)

  const dir = unpack(readFileSync(path.join(DATA_DIR, savedAs)))
  const db = new DatabaseSync(path.join(dir, 'kothai.db'), { readOnly: true })
  const saved = db.prepare('SELECT data FROM notes').all()
  assert.deepEqual(
    saved.map(r => JSON.parse(String(r.data)).content),
    ['https://about-to-be-replaced.example'],
  )
})

test('an older database-only backup (.db) restores, and leaves the uploads on disk alone', async () => {
  await emptyLibrary()
  await store.addNote({ content: 'https://in-old-backup.example' })
  const oldBackup = readFileSync(path.join(unpack(await takeBackup()), 'kothai.db'))
  await emptyLibrary()
  writeFileSync(path.join(UPLOADS, 'current.png'), 'current')

  assert.equal((await restore(oldBackup)).status, 200)
  assert.deepEqual(contents(), ['https://in-old-backup.example'])
  assert.deepEqual(readdirSync(UPLOADS), ['current.png'])
})

test('a file that is not a backup is refused, and the library is untouched', async () => {
  await emptyLibrary()
  await store.addNote({ content: 'https://still-here.example' })

  const res = await restore(Buffer.from('this is not a backup'))
  assert.equal(res.status, 400)
  assert.deepEqual(contents(), ['https://still-here.example'])
  assert.deepEqual(leftovers(), [])
})

test('an archive whose database is damaged is refused before anything is replaced', async () => {
  const dir = mkdtempSync(path.join(SCRATCH, 'damaged-'))
  writeFileSync(path.join(dir, 'kothai.db'), Buffer.alloc(8192, 7))
  // Plain ustar and COPYFILE_DISABLE, or macOS tar adds a pax header and a
  // ._kothai.db entry — refused by the extractor before the database is ever
  // looked at, which would pass this test for the wrong reason.
  execFileSync('tar', ['--format=ustar', '-czf', path.join(dir, 'bad.tar.gz'), '-C', dir, 'kothai.db'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  })
  await emptyLibrary()
  await store.addNote({ content: 'https://still-here.example' })
  writeFileSync(path.join(UPLOADS, 'current.png'), 'current')

  const res = await restore(readFileSync(path.join(dir, 'bad.tar.gz')))
  assert.equal(res.status, 400)
  assert.deepEqual(contents(), ['https://still-here.example'])
  assert.deepEqual(readdirSync(UPLOADS), ['current.png'])
  assert.deepEqual(leftovers(), [])
})

test('a cross-site form cannot restore: the body must be sent as application/octet-stream', async () => {
  // Checked by the route itself, not only the password gate: without a
  // password nothing else stands between another site and this endpoint, and
  // text/plain is a type a page can POST cross-origin with no preflight.
  await emptyLibrary()
  await store.addNote({ content: 'https://kept.example' })
  const backup = await takeBackup()
  await emptyLibrary()
  await store.addNote({ content: 'https://still-here.example' })

  const res = await restore(backup, 'text/plain')
  assert.equal(res.status, 415)
  assert.deepEqual(contents(), ['https://still-here.example'])
})

test('it refuses while an import is running', async () => {
  const backup = await takeBackup()
  importRunning = true
  try {
    const res = await restore(backup)
    assert.equal(res.status, 409)
    assert.equal((await jsonBody(res)).code, 'import_in_progress')
  } finally {
    importRunning = false
  }
})

test('vectors built by a different embedding model are marked stale and a re-embed is asked for', async () => {
  // Vectors from two models live in different spaces; kept as they are, every
  // semantic search over the restored library would answer badly.
  await emptyLibrary()
  await settings.save({ embed: 'embed-when-backed-up', embedRecipe: 'recipe-1' })
  await store.addNote({ content: 'https://embedded.example', embedding: [0.1, 0.2, 0.3] })
  const backup = await takeBackup()
  await settings.save({ embed: 'embed-on-this-machine' })
  reembedRequests = 0

  assert.equal((await restore(backup)).status, 200)
  assert.equal(settings.getEmbedRecipe(), null)
  assert.equal(reembedRequests, 1)
})

test('vectors built by the same embedding setup are kept, with no re-embed', async () => {
  await emptyLibrary()
  await settings.save({ embed: 'embed-same', embedRecipe: 'recipe-1' })
  await store.addNote({ content: 'https://embedded.example', embedding: [0.1, 0.2, 0.3] })
  const backup = await takeBackup()
  await emptyLibrary()
  reembedRequests = 0

  assert.equal((await restore(backup)).status, 200)
  assert.equal(settings.getEmbedRecipe(), 'recipe-1')
  assert.equal(reembedRequests, 0)
  const row = (await getDb()).prepare('SELECT embedding FROM notes').get()
  assert.ok(row?.embedding, 'the restored note keeps its vector')
})

test('other open tabs are told to refetch rather than apply a delta to a library that was replaced', async () => {
  await emptyLibrary()
  const backup = await takeBackup()
  const { rev } = store.revState()

  assert.equal((await restore(backup)).status, 200)
  assert.equal(store.deltaOk(rev), false)
})

test('the saved copies of replaced libraries sit in backups/, not loose in the data directory', async () => {
  assert.equal(existsSync(path.join(DATA_DIR, 'backups')), true)
  assert.deepEqual(
    readdirSync(DATA_DIR).filter(f => f.endsWith('.tar.gz')),
    [],
  )
})
