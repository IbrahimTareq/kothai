// GET /api/backup — an online backup of the live database.
//
// Why VACUUM INTO rather than telling people to copy data/kothai.db: the
// database runs in WAL mode, so the main file on disk is only part of the
// state, and copying it from under a running server can capture a torn
// combination of file and log. VACUUM INTO reads one consistent snapshot
// (committed WAL frames included) and writes a fresh, compacted database — no
// need to stop the container first. That is the difference between "back this
// up on a PaaS" being possible and not.
//
// NOT a complete backup on its own: data/uploads/ lives outside the database,
// and while meta-* thumbnails regenerate from their source URLs, images the
// user pasted or dropped do not exist anywhere else. See docs/self-hosting.md.
import { createReadStream } from 'node:fs'
import { stat, unlink } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { DATA_DIR } from '../config.js'
import { getDb } from '../data/db.js'
import * as store from '../data/notes.js'
import { isImportInProgress } from './import.js'
import { json } from '../lib/http.js'

// A backup momentarily needs free space equal to the database's size, so two
// at once need double. One at a time is also simply all a single-user app can
// want, and a double-clicked download button is the likely cause of a second.
let backupInProgress = false

// SQLite has no bind parameter for VACUUM INTO's target — it takes a string
// literal. The filename itself is server-generated, so the only caller-shaped
// part of this path is DATA_DIR, from the operator's own environment; doubling
// quotes keeps a directory name containing one from breaking the statement.
const sqlLiteral = (value) => `'${value.replace(/'/g, "''")}'`

export async function handleBackup(req, res) {
  // An import holds a batch of notes in memory and writes them at the end (see
  // import.js). A snapshot taken mid-import captures a library that is neither
  // the before nor the after, and the flush below would make that worse by
  // committing half of it.
  if (isImportInProgress()) {
    return json(res, 409, { error: 'An import is running — wait for it to finish, then try again.', code: 'import_in_progress' })
  }
  if (backupInProgress) {
    return json(res, 409, { error: 'A backup is already being prepared.', code: 'backup_in_progress' })
  }
  backupInProgress = true

  // Under DATA_DIR because VACUUM INTO's target has to be on the same
  // filesystem as the database, and because that is the directory the operator
  // has already sized for it. A UUID name cannot collide — VACUUM INTO refuses
  // to overwrite an existing file.
  const snapshot = path.join(DATA_DIR, `backup-${randomUUID()}.db`)
  try {
    // Batched writes ({ persist: false }) sit in memory until someone flushes
    // them. Committing first is what stops a backup from quietly omitting
    // recent notes; it is safe here only because the one caller with a
    // rollback path — import — is refused above.
    await store.flush()

    const db = await getDb()
    db.exec(`VACUUM INTO ${sqlLiteral(snapshot)}`)
    const { size } = await stat(snapshot)

    res.writeHead(200, {
      'Content-Type': 'application/vnd.sqlite3',
      'Content-Length': size,
      'Content-Disposition': `attachment; filename="kothai-backup-${new Date().toISOString().slice(0, 10)}.db"`,
      'Cache-Control': 'no-store',
    })
    // Streamed rather than buffered: this file is the whole database, and
    // reading it into memory to send it would defeat running on a small box.
    await pipeline(createReadStream(snapshot), res)
  } catch (err) {
    console.error('[backup] failed:', err)
    // Once the headers are out the client is already reading a length-prefixed
    // body; the only honest signal left is to break the connection so the
    // download fails loudly instead of arriving silently truncated.
    if (res.headersSent) res.destroy()
    else json(res, 500, { error: 'Could not prepare the backup.', code: 'backup_failed' })
  } finally {
    // Released before the cleanup await, not after: the request is finished
    // once the body is sent, and deleting the temp file is bookkeeping. Holding
    // the guard across it would reject a legitimate next request for as long as
    // the unlink takes.
    backupInProgress = false
    await unlink(snapshot).catch(() => {}) // absent if VACUUM INTO never got that far
  }
}
