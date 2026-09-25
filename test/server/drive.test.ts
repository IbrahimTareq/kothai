// server/drive.ts — copying the daily backup to the owner's Google Drive.
//
// Driven against test/helpers/google.ts, a fake Google at the fetch boundary,
// so the device flow and the Drive calls are the real requests drive.ts builds.
// The local daily backup is written for real by server/backups.ts: what goes
// to Drive is that file, byte for byte.
import { test, after, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fakeGoogle } from '../helpers/google.ts'

const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'kothai-drive-test-'))
process.env.KOTHAI_DATA_DIR = DATA_DIR
process.env.KOTHAI_GOOGLE_CLIENT_ID = 'client.apps.googleusercontent.com'
process.env.KOTHAI_GOOGLE_CLIENT_SECRET = 'client-secret'
const BACKUPS = path.join(DATA_DIR, 'backups')
const TOKEN_FILE = path.join(DATA_DIR, 'google-drive.json')

const sent: string[] = []
const realTelegramApi = await import('../../server/telegram/api.ts')
mock.module('../../server/telegram/api.ts', {
  namedExports: {
    ...realTelegramApi,
    sendMessage: async (_token: string, _chatId: number, text: string) => {
      sent.push(text)
    },
  },
})

const store = await import('../../server/data/notes.ts')
const settings = await import('../../server/data/settings.ts')
const { writeTelegram } = await import('../../server/data/telegram.ts')
const backups = await import('../../server/backups.ts')
const drive = await import('../../server/drive.ts')

await store.load()
await settings.load()

const google = fakeGoogle()
after(() => {
  google.restore()
  rmSync(DATA_DIR, { recursive: true, force: true })
})

const DAY = 24 * 60 * 60 * 1000

// Waits out the background poll that finishes a connection.
async function settle(until: () => boolean) {
  const deadline = Date.now() + 2000
  while (!until() && Date.now() < deadline) await new Promise(r => setTimeout(r, 5))
}

async function connected() {
  google.approval = 'approved'
  await drive.connectDrive()
  await settle(() => drive.driveStatus().connected)
  assert.equal(drive.driveStatus().connected, true, 'precondition: connected')
}

// A fresh daily backup on disk, older ones aged out of the way first.
async function newDailyBackup() {
  const { files } = await backups.listBackups()
  for (const f of files) {
    const when = new Date(Date.now() - 2 * DAY)
    utimesSync(path.join(BACKUPS, f.name), when, when)
  }
  await backups.backupIfDue()
  const newest = (await backups.listBackups()).files[0]
  assert.equal(newest.kind, 'daily')
  return newest
}

const onDrive = () => [...google.files.values()].filter(f => f.mimeType !== 'application/vnd.google-apps.folder')

beforeEach(async () => {
  await drive.disconnectDrive()
  rmSync(BACKUPS, { recursive: true, force: true })
  google.files.clear()
  google.revoked.length = 0
  google.uploads = 0
  google.refreshRevoked = false
  google.uploadFails = false
  sent.length = 0
})

test('connecting hands back a code to enter at google.com/device, and asks only for drive.file', async () => {
  google.approval = 'pending'
  const pending = await drive.connectDrive()
  assert.deepEqual(pending, { userCode: 'ABCD-EFGH', verificationUrl: 'https://www.google.com/device' })
  assert.equal(drive.driveStatus().connected, false)
  assert.deepEqual(drive.driveStatus().pending, pending)
})

test('once approved it is connected as the Google account that approved it', async () => {
  google.approval = 'pending'
  await drive.connectDrive()
  google.approval = 'approved'
  await settle(() => drive.driveStatus().connected)

  const status = drive.driveStatus()
  assert.equal(status.connected, true)
  assert.equal(status.email, 'owner@example.com')
  assert.equal(status.pending, null)
})

test('the refresh token is kept in its own file, readable by the owner only — never in the database', async () => {
  // A backup carries the whole database, and this token opens the Drive.
  await connected()
  assert.match(readFileSync(TOKEN_FILE, 'utf8'), /refresh-token/)
  assert.equal(statSync(TOKEN_FILE).mode & 0o777, 0o600)
})

test('a denied request is said so, and leaves Drive disconnected', async () => {
  google.approval = 'denied'
  await drive.connectDrive()
  await settle(() => drive.driveStatus().error !== null)
  assert.equal(drive.driveStatus().connected, false)
  assert.match(drive.driveStatus().error ?? '', /denied/i)
})

test('the newest daily backup is copied into a Kothai Backups folder, byte for byte', async () => {
  await connected()
  const local = await newDailyBackup()
  await drive.syncToDrive()

  const folder = [...google.files.values()].find(f => f.mimeType === 'application/vnd.google-apps.folder')
  assert.equal(folder?.name, 'Kothai Backups')
  const [copy] = onDrive()
  assert.equal(copy.name, local.name)
  assert.deepEqual(copy.parents, [folder?.id])
  assert.deepEqual(copy.bytes, readFileSync(path.join(BACKUPS, local.name)))
})

test('a backup already on Drive is not uploaded again on the next hourly check', async () => {
  await connected()
  await newDailyBackup()
  await drive.syncToDrive()
  await drive.syncToDrive()
  assert.equal(google.uploads, 1)
})

test('the newest seven are kept on Drive, and older ones deleted there', async () => {
  await connected()
  for (let i = 0; i < 8; i++) {
    await newDailyBackup()
    await drive.syncToDrive()
    // Local retention is seven too; names differ by the millisecond only.
    await new Promise(r => setTimeout(r, 2))
  }
  assert.equal(google.uploads, 8)
  assert.equal(onDrive().length, 7)
})

test('a failed upload is reported once, and cleared by the next success', async () => {
  writeTelegram({ botToken: '123:abc', boundChatId: 42 })
  await connected()
  await newDailyBackup()
  google.uploadFails = true
  await drive.syncToDrive()
  await drive.syncToDrive()
  assert.ok(drive.driveStatus().failure)
  assert.equal(sent.length, 1)
  assert.match(sent[0], /Google Drive/)

  google.uploadFails = false
  await drive.syncToDrive()
  assert.equal(drive.driveStatus().failure, null)
})

test('access Google revoked is reported as a reason to reconnect, not a crash', async () => {
  await connected()
  await newDailyBackup()
  google.refreshRevoked = true
  await drive.syncToDrive()
  assert.match(drive.driveStatus().failure?.error ?? '', /reconnect/i)
})

test('disconnecting revokes the token and forgets it, and leaves the backups on Drive', async () => {
  await connected()
  await newDailyBackup()
  await drive.syncToDrive()
  await drive.disconnectDrive()

  assert.deepEqual(google.revoked, ['refresh-token'])
  assert.equal(existsSync(TOKEN_FILE), false)
  assert.equal(drive.driveStatus().connected, false)
  assert.equal(onDrive().length, 1)
})

test('reconnecting — say on a new machine — finds the same folder and its backups', async () => {
  await connected()
  await newDailyBackup()
  await drive.syncToDrive()
  await drive.disconnectDrive()
  await connected()

  const listed = await drive.listDriveBackups()
  assert.equal(listed.length, 1)
  const folders = [...google.files.values()].filter(f => f.mimeType === 'application/vnd.google-apps.folder')
  assert.equal(folders.length, 1, 'no second folder')
})

test('a Drive backup opens as the same bytes, for a restore to read', async () => {
  await connected()
  const local = await newDailyBackup()
  await drive.syncToDrive()
  const [listed] = await drive.listDriveBackups()

  const chunks: Buffer[] = []
  for await (const chunk of await drive.openDriveBackup(listed.id)) chunks.push(chunk)
  assert.deepEqual(Buffer.concat(chunks), readFileSync(path.join(BACKUPS, local.name)))
})

test('only a file in the Kothai Backups folder can be opened', async () => {
  await connected()
  await assert.rejects(drive.openDriveBackup('file-999'), /no backup/i)
})

test('with nothing connected, the hourly check does nothing', async () => {
  await newDailyBackup()
  await drive.syncToDrive()
  assert.equal(google.uploads, 0)
  assert.equal(drive.driveStatus().failure, null)
})
