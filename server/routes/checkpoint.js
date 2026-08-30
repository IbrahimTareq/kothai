// POST /api/checkpoint — settle the live database files in place.
//
// For snapshot-based backup tools that archive the data directory from outside
// the process (ONCE's pre-backup hook is the reason this exists). They cannot
// ask the app to settle first, and two things would otherwise make their
// snapshot quietly lossy:
//
//   - Batched writes ({ persist: false }, used by the enrichment sweeps in
//     ai/enrich.js) are queued in memory and exist in no file until flushed.
//   - WAL mode leaves committed data in kothai.db-wal, so kothai.db by itself
//     is an older version of the database.
//
// The sibling of GET /api/backup, for the other kind of backup tool: that one
// hands you a consistent copy and costs a second copy's worth of disk; this one
// costs nothing extra but only settles what is already there.
import { getDb } from '../data/db.js'
import * as store from '../data/notes.js'
import { isImportInProgress } from './import.js'
import { json } from '../lib/http.js'

export async function handleCheckpoint(res) {
  // import.js holds a batch of notes in memory and commits them as one
  // transaction at the end, with a rollback path if that fails. Flushing
  // underneath it would commit whatever half of the batch is queued so far and
  // put those rows beyond that rollback — so a scheduled backup firing
  // mid-import would damage the library rather than just capture it mid-flight.
  // Same refusal, for the same reason, as GET /api/backup.
  if (isImportInProgress()) {
    return json(res, 409, { error: 'An import is running — wait for it to finish, then try again.', code: 'import_in_progress' })
  }
  await store.flush()
  const db = await getDb()
  // TRUNCATE rather than PASSIVE: PASSIVE folds the log into the main file but
  // leaves the -wal sitting there at full size, so a tool that copies only
  // kothai.db still gets a stale database. TRUNCATE zeroes it, which is what
  // makes "the main file stands alone" true.
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  json(res, 200, { ok: true })
}
