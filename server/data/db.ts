// Shared SQLite connection for every store module (notes, collections, chats,
// settings, tag_vocab) — one file, data/kothai.db, replacing the five flat
// JSON files an earlier version of this app wrote. node:sqlite's DatabaseSync
// is fully synchronous (no network round-trip, it's an embedded engine), so
// every store keeps doing plain sync reads/writes against it; only the
// connection's first open is async (it has to ensure data/ exists first and
// run the one-time legacy-JSON import).
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DATA_DIR } from '../config.ts'
import { ensureDataDir } from './json.ts'
import { migrateLegacyJson } from './migrate.ts'

const DB_FILE = path.join(DATA_DIR, 'kothai.db')

// Column notes:
// - notes/collections use an AUTOINCREMENT `seq` as the real primary key
//   (id is just UNIQUE) purely so insertion order is free: ORDER BY seq DESC
//   reproduces the old array's unshift()-newest-first order without any
//   extra bookkeeping.
// - chats needs the same "float to front" behavior on every touch, not just
//   creation (a chat moves to the front when you ask it a new question), so
//   its `seq` is a plain column the store bumps by hand on every touch —
//   AUTOINCREMENT only ever moves forward on INSERT, never on UPDATE.
// - tag_vocab.embedding is a BLOB for the same reason as notes.embedding. It
//   was the larger of the two by far: on a real 1,686-note install this table
//   held 2,663 vectors as JSON text, 41.5 MB of a 51.5 MB database. Databases
//   created before the change declare it TEXT; tagvocab.ts rebuilds the table
//   on first load (the registry is derived from note tags, so a rebuild risks
//   nothing that cannot be regenerated).
// - notes.embedding is the one field deliberately NOT in the JSON blob. A
//   1024-dim vector costs ~20 KB as decimal text and 4 KB as float32, and
//   because enrichment patches one field at a time the JSON was being
//   rewritten — vector and all — on every unrelated update. It is nullable
//   because a note has no embedding until the embed step runs.
// - Every OTHER field keeps its full record as one JSON `data` column rather
//   than one SQL column per field: notes in particular pick up fields over
//   time from links/meta.ts and ai/enrich.ts (siteTitle, thumb, pending, ai
//   markers, …), and a fixed column set would silently drop anything future
//   code adds. settings and tag_vocab are the exception — both have a small,
//   truly fixed shape, so real columns are simpler there.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL,
  data TEXT NOT NULL,
  embedding BLOB
);
CREATE TABLE IF NOT EXISTS collections (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chats (
  seq INTEGER NOT NULL,
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  llm TEXT NOT NULL,
  embed TEXT NOT NULL,
  vision TEXT NOT NULL,
  residency_llm TEXT NOT NULL,
  residency_embed TEXT NOT NULL,
  residency_vision TEXT NOT NULL,
  configured INTEGER NOT NULL DEFAULT 0,
  remote_llm TEXT,
  remote_embed TEXT,
  remote_vision TEXT,
  embed_recipe TEXT,
  embed_provider TEXT,
  backups INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS tag_vocab (
  tag TEXT PRIMARY KEY,
  embedding BLOB NOT NULL
);
`

// SQLite itself is typed per value, not per column, and node:sqlite hands back
// every row as Record<string, SQLOutputValue> — so a store module reading a
// row learns nothing from the connection about what it holds. These mirror the
// CREATE TABLE above, column for column, and are the one declaration of that
// shape the stores can be checked against as they move to TypeScript.

export interface NoteRow {
  seq: number
  id: string
  data: string
  // Raw float32 bytes as they come off disk — data/embedding.ts's
  // decodeEmbedding is what turns these into the Float32Array the rest of the
  // server compares. NOT the wider Float32Array | number[] union in
  // server/types.ts: that union describes a vector in memory, which may have
  // arrived as JSON straight from a provider. A row only ever holds bytes.
  embedding: Uint8Array | null
}

export interface CollectionRow {
  seq: number
  id: string
  data: string
}

export interface ChatRow {
  // Plain column, bumped by hand on every touch — see the column notes above
  // for why this one is not AUTOINCREMENT.
  seq: number
  id: string
  data: string
}

export interface SettingsRow {
  // CHECK (id = 1): the table holds one row and only ever one.
  id: number
  llm: string
  embed: string
  vision: string
  residency_llm: string
  residency_embed: string
  residency_vision: string
  // SQLite has no boolean type; 0 or 1.
  configured: number
  // Nullable because every one of these arrived via ensureColumns below, after
  // the table's first release — an install that predates a column reads NULL,
  // and each call site there explains what that NULL means.
  remote_llm: string | null
  remote_embed: string | null
  remote_vision: string | null
  embed_recipe: string | null
  embed_provider: string | null
  // Daily backups to data/backups (server/backups.ts), 0 or 1. On by default.
  backups: number
}

export interface TagVocabRow {
  tag: string
  // NOT NULL: a tag is only ever written together with the vector it was
  // registered from.
  embedding: Uint8Array
}

let db: DatabaseSync | null = null
let opening: Promise<DatabaseSync> | null = null

function createSchema(target: DatabaseSync) {
  target.exec(SCHEMA)
}

// Additive column migration. CREATE TABLE IF NOT EXISTS does nothing to a
// table that already exists, so any column added to a fixed-shape table
// (settings, tag_vocab) after its first release needs this. Idempotent and
// safe to run every boot, like migrateLegacyJson below it.
//
// Additive only — new columns must be nullable or carry a DEFAULT, since
// existing rows cannot supply a value. Exported for tests.
export function ensureColumns(target: DatabaseSync, table: string, columns: Record<string, string>): void {
  const have = new Set(
    target
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map(c => c.name),
  )
  for (const [name, decl] of Object.entries(columns)) {
    if (!have.has(name)) target.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`)
  }
}

async function open(): Promise<DatabaseSync> {
  await ensureDataDir({ uploads: true })
  db = new DatabaseSync(DB_FILE)
  db.exec('PRAGMA journal_mode = WAL')
  createSchema(db)
  // Remote model names live alongside local ones but in their own columns:
  // local keys are QVAC registry constants, remote ones are endpoint-defined
  // ids. Sharing columns would leave a local→remote→local round trip with a
  // value the other provider's validation rejects.
  ensureColumns(db, 'settings', { remote_llm: 'TEXT', remote_embed: 'TEXT', remote_vision: 'TEXT' })
  // Which embedding recipe the stored vectors were built under — see
  // prompts.ts's EMBED_RECIPE. NULL on an existing install, which is exactly
  // the mismatch that triggers the one-time re-embed.
  ensureColumns(db, 'settings', { embed_recipe: 'TEXT' })
  // Which provider produced the stored vectors. NULL on an install that
  // predates the marker — enrich.embedProviderChanged infers the answer from
  // how that install was configured rather than re-embedding on a guess.
  ensureColumns(db, 'settings', { embed_provider: 'TEXT' })
  // Daily backups, on unless switched off — including on every existing install.
  ensureColumns(db, 'settings', { backups: 'INTEGER NOT NULL DEFAULT 1' })
  // Existing databases predate the column; notes.ts moves each vector out of
  // the JSON and into it on first load (see migrateEmbeddings there).
  ensureColumns(db, 'notes', { embedding: 'BLOB' })
  // Idempotent and safe to run every boot: each legacy file this has already
  // consumed was renamed out of the way, so a repeat call just does five
  // cheap existsSync checks and one notes scan that matches nothing once
  // clean (stripThumbThinking). See migrate.ts for why it's safe to
  // re-run after an interrupted migration too.
  await migrateLegacyJson(db)
  return db
}

export async function getDb(): Promise<DatabaseSync> {
  if (db) return db
  if (!opening) opening = open()
  return opening
}

// test-only: swap to a fresh in-memory database (no disk, no legacy-JSON
// migration) so each store's own _reset() can get a clean slate without
// touching the real data/ dir. Synchronous, so it's usable from a plain
// (non-async) test helper.
export function _resetDb(): DatabaseSync {
  db = new DatabaseSync(':memory:')
  createSchema(db)
  opening = Promise.resolve(db)
  return db
}
