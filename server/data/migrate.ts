// One-time import of the old flat-JSON store (data/*.json) into SQLite, run
// by db.js right after the schema is created. Each legacy file that's still
// present gets copied in, then renamed to `<name>.migrated` — kept, not
// deleted, so an unexpected shape or a crash mid-migration leaves evidence
// on disk instead of silently losing data.
//
// Safe to call on every boot: a file that's already been renamed away just
// fails its existsSync check and is skipped, and every row insert uses
// INSERT OR IGNORE / ON CONFLICT DO NOTHING — so if the process dies after
// inserting some rows but before the rename, the next boot's retry re-adds
// only what's missing instead of throwing on the id/tag it already has.
// (The one imperfection: a row that only makes it in on that retry lands at
// the end of the AUTOINCREMENT sequence rather than its original position,
// so a crash at exactly the wrong moment could reorder a note or two. Not
// worth more machinery for how rare and low-stakes that is.)
import path from 'node:path'
import { existsSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { DATA_DIR } from '../config.ts'
import { readJson } from './json.ts'
import type { Role, SavedSettings } from '../ai/roles.ts'
import { ROLES, resolveResidency } from '../ai/roles.ts'
import { DEFAULTS } from '../ai/presets.ts'
import { encodeEmbedding } from './embedding.ts'

// readJson returns `unknown` deliberately — a generic <T> there would have
// told this one caller that a file an old install left on disk has the shape
// we hope for. Every field below is therefore checked at the point of use;
// this is the guard those checks start from.
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

// The legacy stores keyed every row by a string id. A row without one was
// already skipped before this migration was typed.
function idOf(row: unknown): string | null {
  if (!isRecord(row)) return null
  return typeof row.id === 'string' && row.id ? row.id : null
}

async function withLegacyFile(name: string, fn: (data: unknown) => void) {
  const file = path.join(DATA_DIR, name)
  if (!existsSync(file)) return
  const data = await readJson(file, null)
  if (data !== null) fn(data)
  await rename(file, `${file}.migrated`).catch(() => {})
}

function inTransaction(db: DatabaseSync, fn: () => void) {
  db.exec('BEGIN')
  try {
    fn()
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

export async function migrateLegacyJson(db: DatabaseSync): Promise<void> {
  await migrateNotes(db)
  await migrateCollections(db)
  await migrateChats(db)
  await migrateSettings(db)
  await migrateTagVocab(db)
}

// notes.json / collections.json are arrays with the most-recently-added item
// at index 0 (the old unshift()-per-add store). Inserting back-to-front makes
// AUTOINCREMENT hand out seq ascending from oldest to newest, so notes.js's
// `ORDER BY seq DESC` read reproduces the exact original order.
async function migrateNotes(db: DatabaseSync) {
  await withLegacyFile('notes.json', notes => {
    if (!Array.isArray(notes) || !notes.length) return
    const rows: unknown[] = notes
    const ins = db.prepare('INSERT OR IGNORE INTO notes (id, data) VALUES (?, ?)')
    inTransaction(db, () => {
      for (let i = rows.length - 1; i >= 0; i--) {
        const n = rows[i]
        const id = idOf(n)
        if (id) ins.run(id, JSON.stringify(n))
      }
    })
  })
}

async function migrateCollections(db: DatabaseSync) {
  await withLegacyFile('collections.json', collections => {
    if (!Array.isArray(collections) || !collections.length) return
    const rows: unknown[] = collections
    const ins = db.prepare('INSERT OR IGNORE INTO collections (id, data) VALUES (?, ?)')
    inTransaction(db, () => {
      for (let i = rows.length - 1; i >= 0; i--) {
        const c = rows[i]
        const id = idOf(c)
        if (id) ins.run(id, JSON.stringify(c))
      }
    })
  })
}

// chats.json is MRU-ordered (most-recently-touched first), not insertion-
// ordered, so it needs an explicit seq per row rather than relying on
// AUTOINCREMENT — highest seq = front of the list, same convention chats.js
// uses for a live touch.
async function migrateChats(db: DatabaseSync) {
  await withLegacyFile('chats.json', chats => {
    if (!Array.isArray(chats) || !chats.length) return
    const rows: unknown[] = chats
    const ins = db.prepare('INSERT INTO chats (seq, id, data) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING')
    inTransaction(db, () => {
      rows.forEach((c, i) => {
        const id = idOf(c)
        if (!id) return
        ins.run(rows.length - i, id, JSON.stringify(c))
      })
    })
  })
}

async function migrateSettings(db: DatabaseSync) {
  await withLegacyFile('settings.json', saved => {
    if (!isRecord(saved)) return
    const configured = saved.configured === true
    // Rebuilt field by field rather than handed to resolveResidency whole: its
    // SavedSettings shape promises typed fields, and this object came off disk.
    // `saved.residency ? … : null` keeps the truthiness resolveResidency tests
    // to choose the legacy default — narrowing it to a record first would turn
    // a non-object residency value into the legacy branch instead of the fresh
    // one.
    const rawResidency = isRecord(saved.residency) ? saved.residency : null
    const residencyIn: Partial<Record<Role, string>> = {}
    for (const role of ROLES) {
      const v = rawResidency?.[role]
      if (typeof v === 'string') residencyIn[role] = v
    }
    const legacy: SavedSettings = { configured, residency: saved.residency ? residencyIn : null }
    const residency = resolveResidency(legacy)
    const settings = { ...DEFAULTS }
    for (const role of ROLES) {
      const v = saved[role]
      if (typeof v === 'string' && v) settings[role] = v
    }
    db.prepare(`
      INSERT INTO settings (id, llm, embed, vision, residency_llm, residency_embed, residency_vision, configured)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(
      settings.llm,
      settings.embed,
      settings.vision,
      residency.llm,
      residency.embed,
      residency.vision,
      configured ? 1 : 0,
    )
  })
}

async function migrateTagVocab(db: DatabaseSync) {
  await withLegacyFile('tag-embeddings.json', obj => {
    const entries = Object.entries(isRecord(obj) ? obj : {})
    if (!entries.length) return
    const ins = db.prepare('INSERT INTO tag_vocab (tag, embedding) VALUES (?, ?) ON CONFLICT(tag) DO NOTHING')
    inTransaction(db, () => {
      // Encoded, not stringified: tag_vocab.embedding is a BLOB column. Text
      // written here would survive (BLOB columns have no affinity) and then
      // have to be migrated straight back out again by tagvocab.load().
      for (const [tag, vec] of entries) {
        // A legacy registry holds plain number[] vectors; anything else in
        // that slot has no embedding to carry over.
        const blob = Array.isArray(vec) ? encodeEmbedding(vec) : null
        if (blob) ins.run(tag, blob)
      }
    })
  })
}
