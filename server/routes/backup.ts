// GET /api/backup — the whole library as a .tar.gz download, and POST
// /api/restore (below), which takes the same file back. The archive itself,
// and why it is built the way it is, lives in server/backups.ts.
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { createGunzip } from 'node:zlib'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { DATA_DIR, UPLOAD_DIR } from '../config.ts'
import { getDb } from '../data/db.ts'
import * as store from '../data/notes.ts'
import * as collections from '../data/collections.ts'
import * as chats from '../data/chats.ts'
import * as tagvocab from '../data/tagvocab.ts'
import * as settings from '../data/settings.ts'
import * as enrich from '../ai/enrich.ts'
import { isImportInProgress, IMPORT_BUSY, runExclusiveImport } from '../data/import-lock.ts'
import { saveBackup, writeBackup } from '../backups.ts'
import { extractTar } from '../lib/tar.ts'
import { json } from '../lib/http.ts'

export async function handleBackup(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  // An import holds a batch of notes in memory and writes them at the end (see
  // import.ts). A snapshot taken mid-import captures a library that is neither
  // the before nor the after, and the flush in writeBackup would make that
  // worse by committing half of it.
  if (isImportInProgress()) {
    return json(res, 409, IMPORT_BUSY)
  }
  try {
    // No Content-Length: the archive is compressed as it streams, so its size
    // is not known until the last byte.
    await writeBackup(res, () =>
      res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="kothai-backup-${new Date().toISOString().slice(0, 10)}.tar.gz"`,
        'Cache-Control': 'no-store',
      }),
    )
  } catch (err) {
    const code = (err as { code?: string }).code
    // Refused before a byte was written: another backup holds the disk.
    if (code === 'backup_in_progress') return json(res, 409, { error: (err as Error).message, code })
    console.error('[backup] failed:', err)
    // Once the headers are out the client is already reading the archive; the
    // only honest signal left is to break the connection so the download
    // fails loudly instead of arriving silently truncated.
    if (res.headersSent) res.destroy()
    else json(res, 500, { error: 'Could not prepare the backup.', code: 'backup_failed' })
  }
}

// ---- restore ----------------------------------------------------------------
// POST /api/restore — the library replaced by a backup's while the server keeps
// running, so a restore needs no shell and no container restart (on a PaaS
// there is neither). Content only: notes, spaces, chats and uploads come from
// the backup; model settings stay this install's, because they describe this
// machine — which weights are on disk, which endpoint is set — not the library.

const GZIP_MAGIC = Buffer.from([0x1f, 0x8b])
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0')

export async function handleRestore(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // CSRF, checked here and not only by the password gate: with no password set
  // nothing else stands between another site and this route, and text/plain is
  // a body any page can POST cross-origin with no preflight. octet-stream is
  // not CORS-safelisted, so a cross-origin sender is stopped at the preflight.
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/octet-stream')) {
    return json(res, 415, { error: 'Send the backup as application/octet-stream.', code: 'content_type_required' })
  }
  // The import lock, because a restore is the largest import there is: an
  // import, wipe, backup or checkpoint landing mid-swap would each act on a
  // library that is neither the old one nor the new.
  const ran = await runExclusiveImport(() => restore(req, res))
  if (!ran) json(res, 409, IMPORT_BUSY)
}

async function restore(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Under DATA_DIR so the staged uploads can be renamed into place, which only
  // works within one filesystem.
  const staging = path.join(DATA_DIR, `restore-${randomUUID()}`)
  await mkdir(staging)
  // Answered only after the staging is gone, and so the import lock with it: a
  // reply sent first let the client's next request find both still held.
  let answer: [number, unknown]
  try {
    answer = await restoreFrom(req, staging)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  json(res, ...answer)
}

async function restoreFrom(req: IncomingMessage, staging: string): Promise<[number, unknown]> {
  const stagedDb = path.join(staging, 'kothai.db')
  let uploads: string | null
  try {
    uploads = await stage(req, staging)
    checkDatabase(stagedDb)
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Could not read that backup.'
    return [400, { error, code: 'bad_backup' }]
  }
  // The library being replaced, kept as an ordinary backup: restoring the
  // wrong file is undone by restoring this one.
  const savedAs = await saveBackup('before-restore')
  const restored = await swapIn(stagedDb, uploads)
  return [200, { restored, savedAs }]
}

// Unpacks the upload into `staging` and answers where its uploads went, or null
// for a backup that carries none. The first bytes decide the format: gzip is a
// backup from GET /api/backup; SQLite's own header is a bare database, which is
// what that route returned before it carried uploads — people have those.
async function stage(req: IncomingMessage, staging: string): Promise<string | null> {
  const chunks = req[Symbol.asyncIterator]()
  let head = Buffer.alloc(0)
  while (head.length < SQLITE_MAGIC.length) {
    const next = await chunks.next()
    if (next.done) break
    head = Buffer.concat([head, next.value])
  }
  const body = Readable.from(
    (async function* () {
      yield head
      for (let next = await chunks.next(); !next.done; next = await chunks.next()) yield next.value
    })(),
  )
  if (head.subarray(0, GZIP_MAGIC.length).equals(GZIP_MAGIC)) {
    const gunzip = createGunzip()
    const [names] = await Promise.all([extractTar(gunzip, staging), pipeline(body, gunzip)])
    if (!names.includes('kothai.db')) throw new Error('This backup holds no database.')
    // A library with no uploads still replaces the uploads directory — empty.
    const uploads = path.join(staging, 'uploads')
    await mkdir(uploads, { recursive: true })
    return uploads
  }
  if (head.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) {
    await pipeline(body, createWriteStream(path.join(staging, 'kothai.db')))
    return null
  }
  throw new Error('This is not a Kothai backup — choose a file from Download backup.')
}

// Before anything is replaced: a backup that cannot be read must fail while the
// library is still whole, not halfway through the swap.
function checkDatabase(file: string): void {
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(file, { readOnly: true })
    const intact = db.prepare('PRAGMA integrity_check').get()?.integrity_check === 'ok'
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map(r => r.name),
    )
    if (intact && ['notes', 'collections', 'chats', 'settings'].every(t => tables.has(t))) return
  } catch {
    // not a database at all — answered below, the same as a damaged one
  } finally {
    db?.close()
  }
  throw new Error("The backup's database is damaged, or is not a Kothai library.")
}

async function swapIn(stagedDb: string, stagedUploads: string | null) {
  // Uploads first, by rename: instant, and undoable if the database half fails.
  const setAside = path.join(DATA_DIR, `uploads-replaced-${randomUUID()}`)
  if (stagedUploads) {
    await rename(UPLOAD_DIR, setAside)
    await rename(stagedUploads, UPLOAD_DIR)
  }
  let vectorsMatch: boolean
  try {
    // Anything still queued belongs to the library about to be replaced; it
    // is committed first so the saved copy above and this swap agree on it.
    await store.flush()
    vectorsMatch = copyLibrary(await getDb(), stagedDb)
  } catch (err) {
    if (stagedUploads) {
      await rename(UPLOAD_DIR, stagedUploads)
      await rename(setAside, UPLOAD_DIR)
    }
    throw err
  }
  if (stagedUploads) await rm(setAside, { recursive: true, force: true })

  // Every store cached the library it loaded at boot.
  await store.load({ reload: true })
  await collections.load({ reload: true })
  await chats.load({ reload: true })
  // Not restored: the tag registry is derived from note tags (see tagvocab.ts),
  // and rebuilding it with this install's model is what keeps it comparable.
  await tagvocab.clearAll()
  if (!vectorsMatch) {
    // Marked stale rather than re-embedded here. queueRecipeReembed already
    // knows whether that can run now (not with the embed role off) and, if not,
    // leaves the marker for a later boot to act on.
    await settings.save({ embedRecipe: null })
    enrich.queueRecipeReembed()
  }
  if (settings.getResidency().embed !== 'off') {
    enrich.queueJob(() => tagvocab.rebuildFromNotes(store.allNotes()))
  }
  return { notes: store.count(), collections: collections.all().length, chats: chats.all().length }
}

// One transaction: the library is wholly the backup's or wholly what it was.
// seq is copied, not renumbered, because it is what orders every list.
function copyLibrary(db: DatabaseSync, file: string): boolean {
  db.prepare('ATTACH DATABASE ? AS restored').run(file)
  try {
    db.exec('BEGIN')
    try {
      db.exec(`
        DELETE FROM main.notes;
        DELETE FROM main.collections;
        DELETE FROM main.chats;
        INSERT INTO main.notes (seq, id, data, embedding) SELECT seq, id, data, embedding FROM restored.notes;
        INSERT INTO main.collections (seq, id, data) SELECT seq, id, data FROM restored.collections;
        INSERT INTO main.chats (seq, id, data) SELECT seq, id, data FROM restored.chats;
      `)
      const row = db.prepare('SELECT embed, remote_embed, embed_recipe, embed_provider FROM restored.settings').get()
      db.exec('COMMIT')
      return sameVectors(row)
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  } finally {
    db.exec('DETACH DATABASE restored')
  }
}

// Whether the backup's vectors were built the way this install builds them.
// Any difference counts: vectors from two models sit in different spaces, and
// a library holding both answers every query badly (see enrich.ts). A backup
// from an install never configured has no row, and counts as different.
function sameVectors(row: Record<string, SQLOutputValue> | undefined): boolean {
  return (
    row?.embed === settings.get().embed &&
    (row.remote_embed || '') === settings.getRemote().embed &&
    (row.embed_recipe || null) === settings.getEmbedRecipe() &&
    (row.embed_provider || null) === settings.getEmbedProvider()
  )
}
