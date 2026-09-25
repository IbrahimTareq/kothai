// /api/drive — connecting Google Drive from Settings, listing what it holds,
// and restoring straight from it: the new-machine case, where the backup is on
// Drive rather than on the device in hand.
//
// A real listening server, a real on-disk library, and test/helpers/google.ts
// standing in for Google.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { jsonBody, listenOnLoopback, records, text } from '../../helpers/http.ts'
import { fakeGoogle } from '../../helpers/google.ts'

const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'kothai-drive-route-test-'))
process.env.KOTHAI_DATA_DIR = DATA_DIR
process.env.KOTHAI_GOOGLE_CLIENT_ID = 'client.apps.googleusercontent.com'
process.env.KOTHAI_GOOGLE_CLIENT_SECRET = 'client-secret'

const store = await import('../../../server/data/notes.ts')
const collections = await import('../../../server/data/collections.ts')
const chats = await import('../../../server/data/chats.ts')
const settings = await import('../../../server/data/settings.ts')
const backups = await import('../../../server/backups.ts')
const drive = await import('../../../server/drive.ts')
const { createServer } = await import('../../../server/router.ts')
await store.load()
await collections.load()
await chats.load()
await settings.load()

const google = fakeGoogle()
const server = createServer()
const BASE = `http://127.0.0.1:${await listenOnLoopback(server)}`
after(() => {
  server.close()
  google.restore()
  rmSync(DATA_DIR, { recursive: true, force: true })
})

const status = async () => jsonBody(await fetch(`${BASE}/api/drive`))
const post = (p: string, body: unknown = {}, type = 'application/json') =>
  fetch(`${BASE}${p}`, { method: 'POST', headers: { 'Content-Type': type }, body: JSON.stringify(body) })
const contents = () => store.allNotes().map(n => n.content)

async function connect() {
  const res = await post('/api/drive/connect')
  assert.equal(res.status, 200)
  const deadline = Date.now() + 2000
  while (!(await status()).connected && Date.now() < deadline) await new Promise(r => setTimeout(r, 5))
  return res
}

// A library backed up to Drive, then replaced locally by something else.
async function libraryOnDrive() {
  await store.clearAll()
  await store.addNote({ content: 'https://on-drive.example' })
  await backups.backupIfDue()
  await drive.syncToDrive()
  await store.clearAll()
  await store.addNote({ content: 'https://on-this-machine.example' })
  const [backup] = records((await status()).backups)
  return text(backup.id)
}

test('before connecting, Settings is told Drive is set up but not connected', async () => {
  const body = await status()
  assert.equal(body.configured, true)
  assert.equal(body.connected, false)
  assert.deepEqual(body.backups, [])
})

test('connecting answers the code to enter, then reports the account once Google approves', async () => {
  const res = await connect()
  const pending = await jsonBody(res)
  assert.equal(pending.userCode, 'ABCD-EFGH')
  assert.equal(pending.verificationUrl, 'https://www.google.com/device')

  const body = await status()
  assert.equal(body.connected, true)
  assert.equal(body.email, 'owner@example.com')
})

test('the status lists the backups on Drive', async () => {
  await libraryOnDrive()
  const listed = records((await status()).backups)
  assert.equal(listed.length, 1)
  assert.match(text(listed[0].name), /^kothai-backup-.+\.tar\.gz$/)
})

test('a Drive backup restores the library in place of this one', async () => {
  const id = await libraryOnDrive()
  const res = await post('/api/drive/restore', { id })
  assert.equal(res.status, 200)
  assert.deepEqual(contents(), ['https://on-drive.example'])
  assert.match(text((await jsonBody(res)).savedAs), /^backups\/before-restore-/)
})

test('an id that is not a backup in the folder is refused, and the library is untouched', async () => {
  await libraryOnDrive()
  const res = await post('/api/drive/restore', { id: 'file-999' })
  assert.equal(res.status, 400)
  assert.deepEqual(contents(), ['https://on-this-machine.example'])
})

test('a cross-site form cannot trigger a Drive restore: the body must be JSON', async () => {
  const id = await libraryOnDrive()
  const res = await post('/api/drive/restore', { id }, 'text/plain')
  assert.equal(res.status, 415)
  assert.deepEqual(contents(), ['https://on-this-machine.example'])
})

test('disconnecting forgets the account', async () => {
  const res = await fetch(`${BASE}/api/drive`, { method: 'DELETE' })
  assert.equal(res.status, 200)
  assert.equal((await jsonBody(res)).connected, false)
  assert.equal((await status()).connected, false)
})
