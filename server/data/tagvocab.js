// Canonical-tag registry: snaps a newly-generated tag to an existing
// semantically-equivalent tag using embedding similarity, so the corpus
// converges on one form (e.g. "cooking" → existing "recipes"). Unlike the pure
// tags.js, this module does embedding I/O (via ai.embedText) and owns a
// persisted store (the tag_vocab table), so it is kept separate.
//
// Forward-only: existing notes are never rewritten; their tags seed the registry
// so new tags have something to snap to. Only the enrichment (LLM) path calls
// canonicalize — manual tag edits are left as the user typed them.
import { getDb, _resetDb } from './db.js'
import { encodeEmbedding, decodeEmbedding } from './embedding.js'
import { normalizeTags } from '../lib/tags.js'
import * as ai from '../ai/index.js'

export const THRESHOLD = 0.88

let registry = new Map() // canonical tag -> embedding vector
let loaded = false

// ---- pure helpers (no I/O) ---------------------------------------------
// Cosine similarity of two equal-length vectors. Local copy (store.js has a
// private one) to keep this module self-contained.
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom ? dot / denom : 0
}

// Best-matching entry for `vec` among `entries` ([tag, vector] pairs), but only
// if its similarity is >= threshold. Returns { tag, score } or null.
export function nearestTag(vec, entries, threshold) {
  let best = null
  for (const [tag, v] of entries) {
    const score = cosine(vec, v)
    if (!best || score > best.score) best = { tag, score }
  }
  return best && best.score >= threshold ? best : null
}

// ---- registry state ----------------------------------------------------
// True while the table still has the pre-BLOB shape. Checked on the DECLARED
// type rather than on the rows, so an empty registry is migrated too — a table
// left as TEXT would quietly take JSON text again on the next write.
function needsBlobMigration(db) {
  const col = db.prepare('PRAGMA table_info(tag_vocab)').all().find((c) => c.name === 'embedding')
  return !!col && col.type.toUpperCase() !== 'BLOB'
}

// SQLite cannot change a column's type in place, so the table is rebuilt from
// the registry already in memory — which also drops any row that failed to
// parse above. Wrapped in a transaction: if any step fails, the ROLLBACK
// leaves the original table exactly as it was and the next boot retries.
//
// Rebuilding (rather than adding a column) is safe here specifically because
// this table is derived: rebuildFromNotes can regenerate every entry from note
// tags. It would not be an acceptable move on the notes table.
function rebuildTableAsBlob(db) {
  console.log(`[tagvocab] moving ${registry.size} tag embeddings into a blob column…`)
  db.exec('BEGIN')
  try {
    db.exec('DROP TABLE IF EXISTS tag_vocab_blob')
    db.exec('CREATE TABLE tag_vocab_blob (tag TEXT PRIMARY KEY, embedding BLOB NOT NULL)')
    const ins = db.prepare('INSERT INTO tag_vocab_blob (tag, embedding) VALUES (?, ?)')
    for (const [tag, vec] of registry) {
      const blob = encodeEmbedding(vec)
      if (blob) ins.run(tag, blob)
    }
    db.exec('DROP TABLE tag_vocab')
    db.exec('ALTER TABLE tag_vocab_blob RENAME TO tag_vocab')
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    console.warn('[tagvocab] embedding migration deferred:', e.message)
  }
}

// Load the persisted registry into memory. Returns whether it was already
// seeded (server uses this to decide whether to seed from notes on first
// boot) — an empty-but-already-tried registry re-attempting the seed is
// harmless (rebuildFromNotes over already-covered tags is a no-op), so this
// doesn't need to track "ran before" any more precisely than "has entries".
export async function load() {
  if (loaded) return registry.size > 0
  const db = await getDb()
  const rows = db.prepare('SELECT tag, embedding FROM tag_vocab').all()
  // Tolerant of either encoding on a row-by-row basis, so a half-migrated
  // table (say, a legacy-JSON import that landed after the schema change)
  // still loads and is then rewritten wholesale below.
  let sawText = false
  registry = new Map()
  for (const row of rows) {
    if (typeof row.embedding === 'string') {
      sawText = true
      try {
        registry.set(row.tag, decodeEmbedding(encodeEmbedding(JSON.parse(row.embedding))))
      } catch {
        // Derived data: losing one entry costs a single re-embed the next time
        // that tag comes up, whereas throwing here would fail the boot.
        console.warn(`[tagvocab] dropping unreadable embedding for "${row.tag}"`)
      }
      continue
    }
    const vec = decodeEmbedding(row.embedding)
    if (vec) registry.set(row.tag, vec)
  }
  if (sawText || needsBlobMigration(db)) rebuildTableAsBlob(db)
  loaded = true
  return registry.size > 0
}

function persistTag(db, tag, vec) {
  const blob = encodeEmbedding(vec)
  // An empty vector means the embedder returned nothing useful; skip the row
  // rather than violate NOT NULL. The tag simply re-embeds next time.
  if (!blob) return
  db.prepare(`
    INSERT INTO tag_vocab (tag, embedding) VALUES (?, ?)
    ON CONFLICT(tag) DO UPDATE SET embedding = excluded.embedding
  `).run(tag, blob)
}

// test-only: clean in-memory slate against a fresh in-memory database.
export function _reset({ loaded: isLoaded = true, keepDb = false } = {}) {
  if (!keepDb) _resetDb()
  registry = new Map()
  loaded = isLoaded
}

// Erase the learned tag registry — see notes.clearAll(). Nothing is lost
// permanently: the registry is derived from note tags, so it re-seeds from
// whatever notes exist on the next boot (and after a wipe, that's none).
export async function clearAll() {
  const removed = registry.size
  registry = new Map()
  ;(await getDb()).prepare('DELETE FROM tag_vocab').run()
  return removed
}

export function size() {
  return registry.size
}

// Seed the registry from the distinct normalized tags across all notes, embedding
// each once. Only meaningful on first boot (registry empty); does NOT modify
// note data. Throws if an embed fails (e.g. model not ready) — since nothing
// is written until the loop finishes, that leaves the registry (and disk)
// untouched, so the caller can retry clean on the next boot.
export async function rebuildFromNotes(notes, { embed = ai.embedText } = {}) {
  const seen = new Set()
  const fresh = []
  for (const n of Array.isArray(notes) ? notes : []) {
    for (const tag of normalizeTags(n?.tags)) {
      if (seen.has(tag) || registry.has(tag)) continue
      seen.add(tag)
      const vec = await embed(tag)
      registry.set(tag, vec)
      fresh.push([tag, vec])
    }
  }
  if (!fresh.length) return
  const db = await getDb()
  db.exec('BEGIN')
  try {
    for (const [tag, vec] of fresh) persistTag(db, tag, vec)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

// Snap each already-normalized generated tag to an existing equivalent, or
// register it as new. Returns the canonicalized, de-duped list. On any embed
// failure the original input is returned unchanged (tags are never dropped).
// `embed` is injectable so the snap logic is unit-testable with a fake embedder;
// production callers use the default ai.embedText.
export async function canonicalize(tags, { embed = ai.embedText } = {}) {
  if (!Array.isArray(tags) || tags.length === 0) return Array.isArray(tags) ? tags : []
  const out = []
  const seen = new Set()
  try {
    // A tag registered earlier in this loop becomes a snap target for later tags
    // in the same list, so near-synonyms within one note collapse together. The
    // winner is therefore order-dependent (whichever the LLM emitted first) — fine
    // here since either way they converge to a single canonical tag.
    for (const tag of tags) {
      let canonical = tag
      if (!registry.has(tag)) {
        const vec = await embed(tag)
        const match = nearestTag(vec, registry.entries(), THRESHOLD)
        if (match) {
          canonical = match.tag
        } else {
          registry.set(tag, vec)
          persistTag(await getDb(), tag, vec)
        }
      }
      if (!seen.has(canonical)) {
        seen.add(canonical)
        out.push(canonical)
      }
    }
  } catch {
    return tags
  }
  return out
}
