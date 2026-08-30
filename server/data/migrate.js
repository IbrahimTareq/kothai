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
import { DATA_DIR, readJson } from './json.js'
import { ROLES, resolveResidency } from '../ai/roles.js'
import { DEFAULTS } from '../ai/presets.js'
import { encodeEmbedding } from './embedding.js'

async function withLegacyFile(name, fn) {
  const file = path.join(DATA_DIR, name)
  if (!existsSync(file)) return
  const data = await readJson(file, null)
  if (data !== null) fn(data)
  await rename(file, file + '.migrated').catch(() => {})
}

function inTransaction(db, fn) {
  db.exec('BEGIN')
  try {
    fn()
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

export async function migrateLegacyJson(db) {
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
async function migrateNotes(db) {
  await withLegacyFile('notes.json', (notes) => {
    if (!Array.isArray(notes) || !notes.length) return
    const ins = db.prepare('INSERT OR IGNORE INTO notes (id, data) VALUES (?, ?)')
    inTransaction(db, () => {
      for (let i = notes.length - 1; i >= 0; i--) {
        const n = notes[i]
        if (n?.id) ins.run(n.id, JSON.stringify(n))
      }
    })
  })
}

async function migrateCollections(db) {
  await withLegacyFile('collections.json', (collections) => {
    if (!Array.isArray(collections) || !collections.length) return
    const ins = db.prepare('INSERT OR IGNORE INTO collections (id, data) VALUES (?, ?)')
    inTransaction(db, () => {
      for (let i = collections.length - 1; i >= 0; i--) {
        const c = collections[i]
        if (c?.id) ins.run(c.id, JSON.stringify(c))
      }
    })
  })
}

// chats.json is MRU-ordered (most-recently-touched first), not insertion-
// ordered, so it needs an explicit seq per row rather than relying on
// AUTOINCREMENT — highest seq = front of the list, same convention chats.js
// uses for a live touch.
async function migrateChats(db) {
  await withLegacyFile('chats.json', (chats) => {
    if (!Array.isArray(chats) || !chats.length) return
    const ins = db.prepare('INSERT INTO chats (seq, id, data) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING')
    inTransaction(db, () => {
      chats.forEach((c, i) => {
        if (!c?.id) return
        ins.run(chats.length - i, c.id, JSON.stringify(c))
      })
    })
  })
}

async function migrateSettings(db) {
  await withLegacyFile('settings.json', (saved) => {
    const configured = saved.configured === true
    const residency = resolveResidency(saved)
    const settings = { ...DEFAULTS }
    for (const role of ROLES) if (saved[role]) settings[role] = saved[role]
    db.prepare(`
      INSERT INTO settings (id, llm, embed, vision, residency_llm, residency_embed, residency_vision, configured)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(settings.llm, settings.embed, settings.vision, residency.llm, residency.embed, residency.vision, configured ? 1 : 0)
  })
}

async function migrateTagVocab(db) {
  await withLegacyFile('tag-embeddings.json', (obj) => {
    const entries = Object.entries(obj || {})
    if (!entries.length) return
    const ins = db.prepare('INSERT INTO tag_vocab (tag, embedding) VALUES (?, ?) ON CONFLICT(tag) DO NOTHING')
    inTransaction(db, () => {
      // Encoded, not stringified: tag_vocab.embedding is a BLOB column. Text
      // written here would survive (BLOB columns have no affinity) and then
      // have to be migrated straight back out again by tagvocab.load().
      for (const [tag, vec] of entries) {
        const blob = encodeEmbedding(vec)
        if (blob) ins.run(tag, blob)
      }
    })
  })
}
