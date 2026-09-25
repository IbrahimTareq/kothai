// Backups written by the server itself: the archive every backup is (the
// download, the copy a restore saves first, the daily one), and the daily
// schedule that keeps the newest few in data/backups.
//
// Why VACUUM INTO rather than copying data/kothai.db: the database runs in WAL
// mode, so the main file on disk is only part of the state, and copying it
// from under a running server can capture a torn combination of file and log.
// VACUUM INTO reads one consistent snapshot (committed WAL frames included)
// and writes a fresh, compacted database — no need to stop the container
// first. That is the difference between "back this up on a PaaS" being
// possible and not.
//
// Uploads ride along because the database alone was not a backup: while
// meta-* thumbnails regenerate from their source URLs, images the user pasted
// or dropped exist nowhere else. A plain tar so that `tar -xzf` — not only
// this app — can open it.
//
// Local on purpose: it is what makes "restore yesterday" possible on an install
// whose owner never set anything up, and on a PaaS it is the only copy there
// is until someone downloads one from Settings. A copy on this disk is no
// defence against losing the disk — that is what Download backup is for.
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm, stat, statfs, unlink } from 'node:fs/promises'
import { once } from 'node:events'
import { pipeline } from 'node:stream/promises'
import type { Writable } from 'node:stream'
import { createGzip } from 'node:zlib'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { DATA_DIR, UPLOAD_DIR } from './config.ts'
import { getDb } from './data/db.ts'
import * as store from './data/notes.ts'
import * as settings from './data/settings.ts'
import { isImportInProgress } from './data/import-lock.ts'
import { readTelegram } from './data/telegram.ts'
import { sendMessage } from './telegram/api.ts'

// A backup momentarily needs free space equal to the database's size, so two
// at once need double. One at a time is also simply all a single-user app can
// want, and a double-clicked download button is the likely cause of a second.
// Held here rather than by each caller, because there are three: a download,
// the copy a restore saves first, and the daily backup.
let writing = false

// SQLite has no bind parameter for VACUUM INTO's target — it takes a string
// literal. The filename itself is server-generated, so the only caller-shaped
// part of this path is DATA_DIR, from the operator's own environment; doubling
// quotes keeps a directory name containing one from breaking the statement.
const sqlLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`

// One ustar header for a plain file — the only entry kind a backup holds, and
// the only one lib/tar.ts will extract.
function tarHeader(name: string, size: number, mtimeMs: number): Buffer {
  const h = Buffer.alloc(512)
  h.write(name, 0, 100)
  h.write('0000644\0', 100)
  h.write('0000000\0', 108)
  h.write('0000000\0', 116)
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124)
  h.write(
    `${Math.floor(mtimeMs / 1000)
      .toString(8)
      .padStart(11, '0')}\0`,
    136,
  )
  h.write('0', 156)
  h.write('ustar\u000000', 257)
  h.fill(' ', 148, 156)
  const sum = h.reduce((a, b) => a + b, 0)
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  return h
}

async function* tarEntries(files: { name: string; abs: string }[]): AsyncGenerator<Buffer> {
  for (const { name, abs } of files) {
    const { size, mtimeMs } = await stat(abs)
    yield tarHeader(name, size, mtimeMs)
    // The header has already promised `size` bytes, so exactly that many are
    // read; a file that shrank meanwhile would otherwise shift every entry
    // after it and leave an archive that unpacks as garbage.
    let sent = 0
    if (size) {
      for await (const chunk of createReadStream(abs, { end: size - 1 })) {
        sent += chunk.length
        yield chunk
      }
    }
    if (sent !== size) throw new Error(`${name} changed while it was being backed up.`)
    yield Buffer.alloc((512 - (size % 512)) % 512)
  }
  yield Buffer.alloc(1024)
}

// Dot-files skipped: a .DS_Store that Finder left in data/uploads is not the
// user's, and lib/tar.ts refuses the whole archive over a name like it.
async function uploadFiles(): Promise<{ name: string; abs: string }[]> {
  const entries = await readdir(UPLOAD_DIR, { withFileTypes: true }).catch(() => [])
  return entries
    .filter(e => e.isFile() && !e.name.startsWith('.'))
    .map(e => ({ name: `uploads/${e.name}`, abs: path.join(UPLOAD_DIR, e.name) }))
}

// The whole library into `out`, as a .tar.gz. `onSnapshot` runs once the
// database copy exists and before a byte is written — the last moment a
// failure can still be answered with a status code instead of a cut-off
// download.
export async function writeBackup(out: Writable, onSnapshot: () => void = () => {}): Promise<void> {
  if (writing) throw Object.assign(new Error('A backup is already being prepared.'), { code: 'backup_in_progress' })
  writing = true
  try {
    await write(out, onSnapshot)
  } finally {
    writing = false
  }
}

async function write(out: Writable, onSnapshot: () => void): Promise<void> {
  // Batched writes ({ persist: false }) sit in memory until someone flushes
  // them. Committing first is what stops a backup from quietly omitting
  // recent notes; it is safe here only because the one caller with a
  // rollback path — import — is refused before this runs (or, for a
  // restore's copy, holds the import lock itself).
  await store.flush()

  // Under DATA_DIR because VACUUM INTO's target has to be on the same
  // filesystem as the database, and because that is the directory the operator
  // has already sized for it. A UUID name cannot collide — VACUUM INTO refuses
  // to overwrite an existing file.
  const snapshot = path.join(DATA_DIR, `backup-${randomUUID()}.db`)
  try {
    const db = await getDb()
    db.exec(`VACUUM INTO ${sqlLiteral(snapshot)}`)
    onSnapshot()
    // Streamed rather than buffered: this is the whole library, and reading it
    // into memory to send it would defeat running on a small box.
    const files = [{ name: 'kothai.db', abs: snapshot }, ...(await uploadFiles())]
    await pipeline(tarEntries(files), createGzip(), out)
  } finally {
    await unlink(snapshot).catch(() => {}) // absent if VACUUM INTO never got that far
  }
}

// ---- kept on disk -------------------------------------------------------------

type Kind = 'daily' | 'before-restore'
// A daily backup is named like a download, so a file copied off the volume is
// recognisably the same thing.
const PREFIX: Record<Kind, string> = { daily: 'kothai-backup', 'before-restore': 'before-restore' }
// Each copy is the whole library, so every one kept costs its full size. Seven
// days is time to notice a problem before the last good copy rotates out; a
// restore's copy only has to outlast finding out the restore was a mistake.
const KEEP: Record<Kind, number> = { daily: 7, 'before-restore': 3 }
const DAY = 24 * 60 * 60 * 1000
// What a backup must leave free. SQLite fails a write it has no room for, and
// the live database shares this disk.
const HEADROOM = 256 * 1024 * 1024

const BACKUP_DIR = path.join(DATA_DIR, 'backups')
// Also what the download route trusts: a name has to match this to be served.
const NAME = /^(kothai-backup|before-restore)-[0-9T-]+Z\.tar\.gz$/

interface BackupFile {
  name: string
  kind: Kind
  at: string
  size: number
}

// Why the last daily backup did not happen, until one does. In memory: after a
// restart the next hourly check simply tries again, and says so if it fails.
let failure: { at: string; error: string } | null = null

export async function listBackups(): Promise<{ files: BackupFile[]; failure: typeof failure }> {
  const names = await readdir(BACKUP_DIR).catch(() => [])
  const files = await Promise.all(
    names
      .filter(name => NAME.test(name))
      .map(async (name): Promise<BackupFile | null> => {
        // Gone between the listing and the stat when pruning ran meanwhile.
        const info = await stat(path.join(BACKUP_DIR, name)).catch(() => null)
        if (!info) return null
        const kind: Kind = name.startsWith(PREFIX['before-restore']) ? 'before-restore' : 'daily'
        return { name, kind, at: new Date(info.mtimeMs).toISOString(), size: info.size }
      }),
  )
  return {
    files: files.filter(f => f !== null).sort((a, b) => b.at.localeCompare(a.at)),
    failure,
  }
}

// A backup is about the database and every upload; the VACUUM INTO copy
// needs the database's size again while it exists.
async function checkSpace(): Promise<void> {
  const size = (file: string) =>
    stat(file)
      .then(s => s.size)
      .catch(() => 0)
  const uploads = await readdir(UPLOAD_DIR).catch(() => [])
  const uploadBytes = (await Promise.all(uploads.map(n => size(path.join(UPLOAD_DIR, n))))).reduce((a, b) => a + b, 0)
  const db = (await size(path.join(DATA_DIR, 'kothai.db'))) + (await size(path.join(DATA_DIR, 'kothai.db-wal')))
  const needed = 2 * db + uploadBytes + HEADROOM
  const { bavail, bsize } = await statfs(DATA_DIR)
  const free = bavail * bsize
  if (free < needed) {
    const mb = (n: number) => `${Math.ceil(n / 1024 ** 2)} MB`
    throw new Error(`Not enough disk space for a backup: it needs about ${mb(needed)}, and ${mb(free)} is free.`)
  }
}

// Writes a backup into data/backups and answers its path from DATA_DIR. It is
// written under a .partial name and renamed once complete, so a crash midway
// leaves nothing that could be mistaken for a backup, or restored as one.
export async function saveBackup(kind: Kind): Promise<string> {
  await mkdir(BACKUP_DIR, { recursive: true })
  await checkSpace()
  const name = `${PREFIX[kind]}-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`
  const partial = path.join(BACKUP_DIR, `${name}.partial`)
  const out = createWriteStream(partial)
  // Open before anything can fail: removing the file while the stream is
  // still opening it would leave it re-created, empty, behind the removal.
  await once(out, 'open')
  try {
    await writeBackup(out)
    await rename(partial, path.join(BACKUP_DIR, name))
  } catch (err) {
    out.destroy()
    await rm(partial, { force: true })
    throw err
  }
  const { files } = await listBackups()
  const stale = files.filter(f => f.kind === kind).slice(KEEP[kind])
  await Promise.all(stale.map(f => unlink(path.join(BACKUP_DIR, f.name)).catch(() => {})))
  return `backups/${name}`
}

// What server/index.ts calls every hour. Hourly rather than a 24-hour timer
// because the clock is read off the newest file: a restart, or a day the
// server was off, costs at most an hour of lateness instead of a day.
export async function backupIfDue(): Promise<void> {
  // An import holds unflushed notes that a backup's flush would half-commit;
  // the next hourly check will find it finished.
  if (!settings.backupsOn() || isImportInProgress()) return
  // Only one backup is ever written at a time, so with none running a
  // .partial file can only be one a crash interrupted.
  if (!writing) {
    const names = await readdir(BACKUP_DIR).catch(() => [])
    await Promise.all(names.filter(n => n.endsWith('.partial')).map(n => rm(path.join(BACKUP_DIR, n), { force: true })))
  }
  const newest = (await listBackups()).files.find(f => f.kind === 'daily')
  if (newest && Date.now() - Date.parse(newest.at) < DAY) return
  try {
    await saveBackup('daily')
    failure = null
  } catch (err) {
    // A download or a restore's copy is being written; next hour, then.
    if ((err as { code?: string }).code === 'backup_in_progress') return
    console.error('[backups] daily backup failed:', err)
    const first = !failure
    failure = { at: new Date().toISOString(), error: err instanceof Error ? err.message : String(err) }
    // Once per run of failures: the check repeats hourly, and so would this.
    if (first) await report(`Kothai couldn't make today's backup. ${failure.error} It will keep trying every hour.`)
  }
}

// To the Telegram chat the owner paired, when there is one. The container log
// is the only other place a failure shows, and nobody reads that daily.
async function report(text: string): Promise<void> {
  const config = readTelegram()
  if (config?.botToken && config.boundChatId !== null) await sendMessage(config.botToken, config.boundChatId, text)
}
