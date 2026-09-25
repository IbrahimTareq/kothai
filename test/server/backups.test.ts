// server/backups.ts — the daily backup Kothai writes to data/backups on its own.
//
// backupIfDue() is what the hourly timer in server/index.ts calls, so it is
// driven directly here: the timer only decides when to ask, and every rule
// about whether to act — due, switched off, mid-import, short of disk — lives
// in the function. Free space and Telegram are the two things mocked; the
// archive is written for real and unpacked with the system tar.
import { test, after, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'kothai-backups-test-'))
process.env.KOTHAI_DATA_DIR = DATA_DIR
const BACKUPS = path.join(DATA_DIR, 'backups')
const SCRATCH = mkdtempSync(path.join(os.tmpdir(), 'kothai-backups-scratch-'))
after(() => {
  rmSync(DATA_DIR, { recursive: true, force: true })
  rmSync(SCRATCH, { recursive: true, force: true })
})

// Free space as statfs reports it. Plenty unless a test says otherwise.
let freeBytes = 100 * 1024 ** 3
const realFs = await import('node:fs/promises')
mock.module('node:fs/promises', {
  namedExports: {
    ...realFs,
    statfs: async () => ({ bavail: freeBytes / 4096, bsize: 4096 }),
  },
})

let importRunning = false
const realLock = await import('../../server/data/import-lock.ts')
mock.module('../../server/data/import-lock.ts', {
  namedExports: { ...realLock, isImportInProgress: () => importRunning },
})

const sent: { chatId: number; text: string }[] = []
const realTelegramApi = await import('../../server/telegram/api.ts')
mock.module('../../server/telegram/api.ts', {
  namedExports: {
    ...realTelegramApi,
    sendMessage: async (_token: string, chatId: number, text: string) => {
      sent.push({ chatId, text })
    },
  },
})

const store = await import('../../server/data/notes.ts')
const settings = await import('../../server/data/settings.ts')
const { writeTelegram, clearTelegram } = await import('../../server/data/telegram.ts')
const backups = await import('../../server/backups.ts')

await store.load()
await settings.load()

const DAY = 24 * 60 * 60 * 1000
const listing = () => (existsSync(BACKUPS) ? readdirSync(BACKUPS).sort() : [])
const daily = () => listing().filter(f => f.startsWith('kothai-backup-'))

// Pushes a backup's file time into the past, which is how "a day has gone by"
// reaches a function that reads the clock off the files.
function age(name: string, ms: number) {
  const when = new Date(Date.now() - ms)
  utimesSync(path.join(BACKUPS, name), when, when)
}

// A stand-in for an older backup. Retention reads names and times, never
// contents, so the bytes do not matter.
function oldBackup(name: string, msAgo: number) {
  mkdirSync(BACKUPS, { recursive: true })
  writeFileSync(path.join(BACKUPS, name), 'old')
  age(name, msAgo)
}

beforeEach(async () => {
  rmSync(BACKUPS, { recursive: true, force: true })
  freeBytes = 100 * 1024 ** 3
  importRunning = false
  sent.length = 0
  clearTelegram()
  await settings.save({ backups: true })
  // A success clears any failure an earlier test left in the module.
  await backups.backupIfDue()
  rmSync(BACKUPS, { recursive: true, force: true })
  sent.length = 0
})

test('with no backup yet, one is written to data/backups — the same archive Download backup gives', async () => {
  await store.addNote({ content: 'https://in-the-daily.example' })
  await backups.backupIfDue()

  const [name] = daily()
  assert.match(name, /^kothai-backup-.+\.tar\.gz$/)
  const dir = mkdtempSync(path.join(SCRATCH, 'unpack-'))
  execFileSync('tar', ['-xzf', path.join(BACKUPS, name), '-C', dir])
  assert.equal(existsSync(path.join(dir, 'kothai.db')), true)
})

test('it does not back up again within a day', async () => {
  await backups.backupIfDue()
  await backups.backupIfDue()
  assert.equal(daily().length, 1)
})

test('once the newest daily backup is a day old, another is written', async () => {
  await backups.backupIfDue()
  age(daily()[0], DAY + 60_000)
  await backups.backupIfDue()
  assert.equal(daily().length, 2)
})

test('the newest seven daily backups are kept, and older ones deleted', async () => {
  for (let i = 1; i <= 7; i++) oldBackup(`kothai-backup-2026-09-0${i}T03-00-00-000Z.tar.gz`, (10 - i) * DAY)
  await backups.backupIfDue()

  const kept = daily()
  assert.equal(kept.length, 7)
  assert.equal(kept.includes('kothai-backup-2026-09-01T03-00-00-000Z.tar.gz'), false, 'the oldest went')
})

test('copies saved before a restore are kept to the newest three, apart from the daily ones', async () => {
  for (let i = 1; i <= 3; i++) oldBackup(`before-restore-2026-09-0${i}T03-00-00-000Z.tar.gz`, (10 - i) * DAY)
  oldBackup('kothai-backup-2026-09-01T03-00-00-000Z.tar.gz', 2 * DAY)

  const saved = await backups.saveBackup('before-restore')
  assert.match(saved, /^backups\/before-restore-.+\.tar\.gz$/)
  const before = listing().filter(f => f.startsWith('before-restore-'))
  assert.equal(before.length, 3)
  assert.equal(before.includes('before-restore-2026-09-01T03-00-00-000Z.tar.gz'), false)
  assert.equal(daily().length, 1, 'a daily backup is not counted against them')
})

test('switched off, it writes nothing', async () => {
  await settings.save({ backups: false })
  await backups.backupIfDue()
  assert.deepEqual(listing(), [])
})

test('mid-import it waits for the next check rather than snapshot a half-written library', async () => {
  importRunning = true
  await backups.backupIfDue()
  assert.deepEqual(listing(), [])
})

test('short of disk space it writes nothing, and says why in the listing', async () => {
  // A backup that filled the disk would fail the live database's next write.
  freeBytes = 1024
  await backups.backupIfDue()
  assert.deepEqual(daily(), [])
  const { failure } = await backups.listBackups()
  assert.match(failure?.error ?? '', /disk space/)
})

test('a failure is sent to the paired Telegram chat once, not on every hourly retry', async () => {
  writeTelegram({ botToken: '123:abc', boundChatId: 42 })
  freeBytes = 1024
  await backups.backupIfDue()
  await backups.backupIfDue()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].chatId, 42)
  assert.match(sent[0].text, /backup/i)
})

test('a success clears the failure, so the next one is reported again', async () => {
  writeTelegram({ botToken: '123:abc', boundChatId: 42 })
  freeBytes = 1024
  await backups.backupIfDue()
  freeBytes = 100 * 1024 ** 3
  await backups.backupIfDue()
  assert.equal((await backups.listBackups()).failure, null)

  age(daily()[0], DAY + 60_000)
  freeBytes = 1024
  await backups.backupIfDue()
  assert.equal(sent.length, 2)
})

test('with no bot paired, a failure is still recorded and nothing throws', async () => {
  freeBytes = 1024
  await backups.backupIfDue()
  assert.ok((await backups.listBackups()).failure)
  assert.equal(sent.length, 0)
})

test('a backup cut short by a crash is never listed, and is cleared away', async () => {
  // Written under a .partial name and renamed only once complete, so a crash
  // leaves something that cannot be mistaken for a backup.
  oldBackup('kothai-backup-2026-09-01T03-00-00-000Z.tar.gz.partial', 2 * DAY)
  await backups.backupIfDue()
  assert.deepEqual(
    listing().filter(f => f.endsWith('.partial')),
    [],
  )
  assert.equal(
    (await backups.listBackups()).files.some(f => f.name.endsWith('.partial')),
    false,
  )
})

test('the listing is newest first, with each file’s kind, time and size', async () => {
  oldBackup('before-restore-2026-09-01T03-00-00-000Z.tar.gz', 2 * DAY)
  await backups.backupIfDue()
  const { files } = await backups.listBackups()
  assert.deepEqual(
    files.map(f => f.kind),
    ['daily', 'before-restore'],
  )
  assert.ok(files[0].size > 0)
  assert.ok(Date.parse(files[0].at) > Date.parse(files[1].at))
})
