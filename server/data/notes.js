// SQLite-backed persistence for saved notes + in-memory cosine search. Each
// note carries its embedding so semantic retrieval needs no extra service.
// Reads/writes go through an in-memory `notes` array exactly like the old
// flat-JSON version did — search/textSearch/allNotes stay synchronous and
// unchanged; only how a mutation reaches disk changed underneath them.
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { readdir, rm } from 'node:fs/promises'
import { UPLOAD_DIR } from './json.js'
import { getDb, _resetDb } from './db.js'
import { encodeEmbedding, decodeEmbedding } from './embedding.js'
import { deriveAiMarkers } from '../ai/backlog.js'
import { deriveAccountFromTitle } from '../import/instagram.js'

// re-exported so http.js / ai/meta.js keep importing it from here
export { UPLOAD_DIR }

let notes = []
let loaded = false

// ---- delta sync ---------------------------------------------------------
// Monotonic change counter + per-boot id. `_rev` lives only on the in-memory
// record (never persisted, stripped from every response) — a restart simply
// starts a new bootId and clients resync their loaded pages.
let rev = 0
const bootId = randomUUID()
let tombstones = []      // [{ id, rev }] for deletions, newest last
let tombstoneFloor = 0   // highest rev discarded from the tombstone window
let TOMBSTONE_CAP = 1000

function bump(record) {
  rev++
  if (record) record._rev = rev
}

export function revState() { return { rev, bootId } }
export function changedSince(since) {
  return notes.filter((n) => (n._rev || 0) > since).map(stripEmbedding)
}
export function deletedSince(since) {
  return tombstones.filter((t) => t.rev > since).map((t) => t.id)
}
// False when `since` predates trimmed tombstones — deletions may be missing,
// so the client must refetch instead of applying a delta.
export function deltaOk(since) { return since >= tombstoneFloor }
export function _setTombstoneCap(n) { TOMBSTONE_CAP = n }  // test-only

// Writes queued by a { persist: false } call, run as one transaction on the
// next flush() — see addNote's doc comment for why batching matters. Each
// entry is a closure over the row it writes; import.js's rollback path
// (removeMany) never has to touch these because by the time it runs, flush()
// has already drained (and either committed or discarded) the queue.
let pendingWrites = []

// ---- embedding storage --------------------------------------------------
// The vector lives in its own BLOB column, not in the note's JSON. As decimal
// text a 768-dim embedding is ~15 KB; as float32 it is 3 KB. The bigger win is
// on writes: enrichment patches one field at a time, and every one of those
// updates used to re-serialise the whole vector along with it.
//
// Re-exported because callers (and tests) reach for them via the store.
export { encodeEmbedding, decodeEmbedding }

// One transaction for the whole library. Runs once: afterwards the JSON no
// longer carries a vector, so the legacy branch in load() finds nothing.
// Deliberately non-fatal — a database that cannot be migrated should still
// boot and serve, with the vectors read from JSON as before and the migration
// retried on the next start.
function migrateEmbeddings(db, records) {
  console.log(`[notes] moving ${records.length} embeddings into the blob column…`)
  db.exec('BEGIN')
  try {
    for (const record of records) {
      // Converted in memory as well, so the running process and the row agree
      // on the type from this point on.
      record.embedding = decodeEmbedding(encodeEmbedding(record.embedding))
      updateRow(db, record)
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    console.warn('[notes] embedding migration deferred:', e.message)
  }
}

export async function load() {
  if (loaded) return
  const db = await getDb()
  const rows = db.prepare('SELECT data, embedding FROM notes ORDER BY seq DESC').all()
  // Rows written before the embedding column existed still carry the vector
  // inside `data`; they are collected here and rewritten once, below.
  const legacy = []
  notes = rows.map((r) => {
    const note = JSON.parse(r.data)
    const embedding = decodeEmbedding(r.embedding)
    if (embedding) note.embedding = embedding
    else if (note.embedding?.length) legacy.push(note)
    return note
  })
  // Migrate pre-residency notes: infer which AI steps already ran so the
  // enrichment backlog counts only genuinely missing work.
  for (const n of notes) {
    n.ai = deriveAiMarkers(n)
    // Migrate notes imported before `account` was a first-class field: the
    // poster username only ever landed inside the title string.
    if (!n.account) n.account = deriveAccountFromTitle(n.title)
  }
  if (legacy.length) migrateEmbeddings(db, legacy)
  loaded = true
}

// `_rev` is an in-memory-only bookkeeping field for delta sync — strip it
// before it reaches disk so a restart's fresh bootId is the only source of
// truth for "what rev is this record at", not a stale persisted number.
// `embedding` is dropped alongside `_rev` because it has its own column now —
// leaving it here would store every vector twice and undo the whole point.
function rowJson(record) {
  const { _rev, embedding, ...rest } = record
  return JSON.stringify(rest)
}

function insertRow(db, record) {
  db.prepare('INSERT INTO notes (id, data, embedding) VALUES (?, ?, ?)')
    .run(record.id, rowJson(record), encodeEmbedding(record.embedding))
}

// `writeEmbedding` false leaves the BLOB column out of the statement entirely.
// The vector is ~3 KB against ~1 KB for every other field of a note combined,
// and enrichment patches one field at a time — so for the common update this
// is the difference between writing a page and writing four.
function updateRow(db, record, writeEmbedding = true) {
  if (!writeEmbedding) {
    db.prepare('UPDATE notes SET data = ? WHERE id = ?').run(rowJson(record), record.id)
    return
  }
  db.prepare('UPDATE notes SET data = ?, embedding = ? WHERE id = ?')
    .run(rowJson(record), encodeEmbedding(record.embedding), record.id)
}

// Pass { persist: false } to batch a run of adds and call flush() once at the
// end — a bulk import (hundreds/thousands of items) would otherwise cost one
// disk write per item. flush() wraps the whole queued batch in a single
// transaction, so it's both one write AND atomic (all rows land or none do).
export async function addNote(note, { persist: doPersist = true } = {}) {
  const record = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    type: 'text',
    category: 'General',
    title: '',
    summary: '',
    tags: [],
    content: '',
    url: null,
    image: null,
    embedding: null,
    ...note,
  }
  notes.unshift(record)
  bump(record)
  if (doPersist) insertRow(await getDb(), record)
  else pendingWrites.push((db) => insertRow(db, record))
  return stripEmbedding(record)
}

// Patch an existing note in place (used by background image enrichment).
// Pass { persist: false } to batch a run of updates and call flush() once at
// the end — the settings re-embed does this so it writes once instead of
// once per note.
export async function updateNote(id, patch, { persist: doPersist = true } = {}) {
  const note = notes.find((n) => n.id === id)
  if (!note) return null
  Object.assign(note, patch)
  bump(note)
  // Only rewrite the vector when this patch is actually about the vector.
  // Captured now rather than read at flush time, so a queued batch of mixed
  // updates keeps each one's answer.
  const writeEmbedding = 'embedding' in patch
  if (doPersist) updateRow(await getDb(), note, writeEmbedding)
  else pendingWrites.push((db) => updateRow(db, note, writeEmbedding))
  return stripEmbedding(note)
}

// Commit everything queued by a { persist: false } run as one transaction.
// Throws (and leaves nothing committed — SQLite rolls the whole transaction
// back) if any statement in the batch fails, so a caller can treat "flush
// threw" as "none of this batch reached disk" without checking row by row.
export async function flush() {
  if (!pendingWrites.length) return
  const db = await getDb()
  const ops = pendingWrites
  pendingWrites = []
  db.exec('BEGIN')
  try {
    for (const op of ops) op(db)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

// Remove several notes from memory WITHOUT touching disk — the import route's
// rollback when a batched flush() fails. Nothing here needs a DB call: a
// failed flush() already rolled its whole transaction back, so these ids
// were never actually written; this just undoes the in-memory unshift()s.
export async function removeMany(ids) {
  const idSet = new Set(ids)
  if (!idSet.size) return
  notes = notes.filter((n) => !idSet.has(n.id))
}

export async function deleteNote(id) {
  const before = notes.length
  notes = notes.filter((n) => n.id !== id)
  const changed = notes.length !== before
  if (changed) {
    (await getDb()).prepare('DELETE FROM notes WHERE id = ?').run(id)
    rev++
    tombstones.push({ id, rev })
    while (tombstones.length > TOMBSTONE_CAP) tombstoneFloor = tombstones.shift().rev
  }
  return changed
}

// Erase every note — the "danger zone" wipe in Settings. Clears the in-memory
// array, the queued-but-unflushed writes, and the table in one go. Dropping
// `pendingWrites` matters: a { persist: false } batch still in the queue would
// otherwise be written by the NEXT flush(), quietly resurrecting notes the
// user just deleted. Returns how many notes went, for the confirmation copy.
export async function clearAll() {
  const removed = notes.length
  notes = []
  pendingWrites = []
  ;(await getDb()).prepare('DELETE FROM notes').run()
  // Everything gone at once — no point tracking individual tombstones;
  // clients just resync from here.
  rev++
  tombstoneFloor = rev
  tombstones = []
  return removed
}

// Deletes the uploaded image files that pasted/dropped notes referenced. Kept
// SEPARATE from clearAll() so the store's own unit tests can wipe an
// in-memory database without ever touching the real uploads directory —
// only the wipe route calls this. Individual failures are swallowed: an
// undeletable leftover file is cosmetic, and must not fail a wipe whose
// database half already succeeded.
export async function clearUploads() {
  let removed = 0
  let entries = []
  try {
    entries = await readdir(UPLOAD_DIR)
  } catch {
    return 0 // no uploads dir yet — nothing to do
  }
  for (const name of entries) {
    try {
      await rm(path.join(UPLOAD_DIR, name), { force: true, recursive: true })
      removed++
    } catch { /* leftover file is cosmetic; never fail the wipe over it */ }
  }
  return removed
}

// One note by id, embedding stripped like every other read path. Used by the
// single-note API route that hydrates a deep-linked expanded item.
export function getNote(id) {
  const note = notes.find((n) => n.id === id)
  return note ? stripEmbedding(note) : null
}

export function allNotes() {
  return notes.map(stripEmbedding)
}

export function count() {
  return notes.length
}

// Minimum cosine similarity for a note to count as a result at all.
//
// Cosine search always returns its top k, however bad they are — so a
// question the library has nothing on ("what is the capital of Mongolia")
// used to fill the answer prompt with ten unrelated reels, and the model
// dutifully talked about them instead of saying nothing is saved on this.
// A floor is what lets an out-of-library question reach the prompt with an
// empty context, which the system prompt already knows how to handle.
//
// 0.44 is measured, not guessed. Against the live library (1,686 notes,
// EmbeddingGemma 300M Q8, query/document task prefixes) over eight in-library
// and eight out-of-library questions phrased the way a person actually types
// them — "what did I save about X?", not a bare "X":
//
//   in-library      best match  0.464 – 0.748     tenth  0.419 – 0.547
//   out-of-library  best match  0.324 – 0.439     tenth  0.300 – 0.404
//
// At 0.44 every in-library question keeps at least 7 notes (median 15) and
// every out-of-library question keeps none.
//
// The scaffolding matters and is why this number is not 0.40: measured
// against bare topic phrases the out-of-library band topped out at 0.389, but
// "what did I save about..." pulls a query toward the generic short-caption
// notes the library is full of, lifting the whole out-of-library band by
// about 0.05. Calibrating on bare topics and shipping that number let six
// unrelated notes into a question about the Derg.
//
// The margin above the out-of-library band is thin (0.439 vs 0.44), and that
// is the deliberate direction to err in. Too low and some noise reaches the
// prompt — where the empty-context instruction and the keyword side's own
// filtering still produce the right answer, as observed. Too high and a real
// question loses the evidence that would have answered it, which nothing
// downstream can recover. Recall on real questions is worth more than a
// comfortable margin against noise.
//
// Model-specific by construction — a different embedding model is a different
// scale — which is why this lives next to the recipe marker that forces a
// re-embed when the model changes.
const SIM_FLOOR = 0.44

// Top-K notes by cosine similarity to a query embedding, above the floor.
// `floor: 0` disables it, for callers that want raw ranking.
export function search(queryEmbedding, k = TOP_K, { floor = SIM_FLOOR } = {}) {
  const scored = notes
    .filter((n) => n.embedding?.length) // Float32Array off disk, plain Array fresh from the model
    .map((n) => ({ note: n, score: cosine(queryEmbedding, n.embedding) }))
    .filter((s) => s.score >= floor)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
  return scored.map((s) => ({ ...stripEmbedding(s.note), score: s.score }))
}

// ---- hybrid retrieval ----------------------------------------------------
// Cosine search and keyword search fail in opposite directions, and Ask used
// to get exactly one of them. Cosine misses a rare literal token — a product
// name, a handle, a place — because 768 dimensions of "general vibe" do not
// reserve space for it. Keyword misses every paraphrase, which is most of how
// people actually ask ("that pasta thing" against a caption that never says
// pasta). Fusing them means one strong signal is enough for a note to
// surface, and a note both agree on rises to the top.
//
// Reciprocal-rank fusion is used rather than a weighted score blend because
// the two scores are not comparable and never will be: a cosine similarity
// lives in a narrow band around 0.3-0.8 and a keyword score is "fraction of
// query terms present". Any weighting of those two numbers is a magic
// constant that has to be re-tuned whenever the embedding model changes. RRF
// throws the magnitudes away and keeps only the ORDER each retriever put
// things in, which is the part that transfers.
//
// K = 60 is the constant from the original RRF paper and the value every
// implementation has used since. It damps the difference between the top few
// ranks so that a note ranked 1st by one retriever and unranked by the other
// does not automatically beat a note ranked 3rd by both.
const RRF_K = 60

// How many notes Ask puts in front of the answer model. Six was set when the
// context was title + content + URL per note — a few dozen characters for a
// saved link. Now that a note contributes its caption, article excerpt and
// thumbnail description, ten is both more useful and still comfortably inside
// the LLM's context: prompts.js shrinks the per-note budget as k grows, so
// raising this trims each note rather than overflowing.
const TOP_K = 10

// How much deeper than the final top-k each retriever is asked to go. Fusion
// can only reorder what it is given, so pulling exactly k from each would let
// a note ranked k+1 by both retrievers — a strong consensus candidate — be
// discarded before fusion ever saw it.
const CANDIDATE_DEPTH = 3

// Pure: several ranked lists → one, ordered by summed reciprocal rank.
// Exported for tests; no store access, no I/O.
export function reciprocalRankFusion(lists, { k = RRF_K } = {}) {
  const scores = new Map()
  const byId = new Map()
  for (const list of lists) {
    list.forEach((item, i) => {
      if (!byId.has(item.id)) byId.set(item.id, item)
      scores.set(item.id, (scores.get(item.id) || 0) + 1 / (k + i + 1))
    })
  }
  return [...scores]
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => ({ ...byId.get(id), score }))
}

// What Ask actually calls when an embedding model is available. Falls back to
// keyword-only results when there is no query embedding, so a caller never
// has to branch.
export function hybridSearch(queryEmbedding, query, k = TOP_K) {
  const depth = k * CANDIDATE_DEPTH
  const lists = [queryEmbedding ? search(queryEmbedding, depth) : [], textSearch(query, depth)]
  return reciprocalRankFusion(lists).slice(0, k)
}

// English function words, stripped from a query before scoring.
//
// Scoring is "fraction of query terms present", which treats every term as
// equally informative — so "what did I save about the 1974 Ethiopian
// revolution?" matched 70% of the library on the word "the". That was
// harmless while this was only the fallback for a disabled embedding model;
// once it became half of hybrid retrieval it meant an unanswerable question
// always came back with a full page of confident-looking noise.
//
// A list rather than a full IDF model because BM25-quality scoring was
// deliberately parked. It is paired with the frequency cutoff below, which
// catches whatever the list misses — including in languages this list says
// nothing about, and the library is not all English.
const STOPWORDS = new Set([
  'about', 'after', 'all', 'also', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can',
  'did', 'do', 'does', 'find', 'for', 'from', 'get', 'had', 'has', 'have', 'how', 'if', 'in', 'into',
  'is', 'it', 'its', 'just', 'me', 'my', 'not', 'of', 'on', 'or', 'our', 'out', 'over', 'save', 'saved',
  'show', 'so', 'some', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this',
  'to', 'up', 'us', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will',
  'with', 'would', 'you', 'your',
])

// A term present in more than this share of the library carries no
// information about which note the asker wants, whatever language it is in.
// Measured on the live library: "the" 71%, "and" 79%, while every genuinely
// discriminating term sat below 1%. There is a lot of room between those, so
// the exact cutoff is not delicate.
const MAX_TERM_SHARE = 0.25

// ...but a share is meaningless on a handful of notes, where one match is
// already 25% of everything. Below this the cutoff is skipped entirely and
// the stopword list does the work on its own.
const MIN_LIBRARY_FOR_SHARE = 20

// A term matches at a WORD START, not anywhere in the string. Plain
// `includes` finds "derg" inside "underground" and "der" inside "wonderful",
// which is how an out-of-library question kept finding matches for its rarest
// and most discriminating words — the worst possible place for a false
// positive. Anchoring only the start keeps the stem and plural matches that
// make this retriever useful ("controller" still finds "controllers",
// "entangle" still finds "entangled"); anchoring the end too would lose them.
//
// Terms come from a \W+ split, so they are [A-Za-z0-9_] only and cannot carry
// a regex metacharacter — no escaping needed.
function termMatcher(term) {
  return new RegExp(`\\b${term}`)
}

// Pure: query → the terms worth scoring against `haystacks`, each paired with
// its matcher. Exported for tests. Falls back to the unfiltered terms when
// filtering removes everything, so a query made entirely of common words
// still returns its best-effort matches rather than nothing at all.
export function queryTerms(query, haystacks = []) {
  const raw = [...new Set((query || '').toLowerCase().split(/\W+/).filter((t) => t.length > 1))]
  // Stopwords are dropped unconditionally, with no fallback: a query made
  // entirely of them ("what did I save about the...") is asking about
  // nothing, and best-effort noise is a worse answer than no answer.
  const content = raw.filter((t) => !STOPWORDS.has(t))
  if (!content.length || haystacks.length < MIN_LIBRARY_FOR_SHARE) return content

  const cap = haystacks.length * MAX_TERM_SHARE
  const kept = content.filter((t) => {
    const re = termMatcher(t)
    let seen = 0
    for (const hay of haystacks) if (re.test(hay) && ++seen > cap) return false
    return true
  })
  // The frequency cutoff DOES fall back: unlike a stopword, a term that is
  // merely common in this particular library is still what was asked about,
  // and dropping every term of a query about the library's dominant subject
  // would make it unanswerable.
  return kept.length ? kept : content
}

// Keyword retrieval — half of hybrid search, and the whole of it when no
// embedding model is available (embed role off): token-overlap scoring over
// title/tags/summary/content. Same result shape as search() so Ask can use
// either. `list` is injectable for tests.
export function textSearch(query, k = TOP_K, list = notes) {
  const haystacks = list.map(haystackFor)
  const terms = queryTerms(query, haystacks)
  if (!terms.length) return []
  const matchers = terms.map(termMatcher)
  return list
    .map((n, i) => {
      const hay = haystacks[i]
      let hits = 0
      for (const re of matchers) if (re.test(hay)) hits++
      return { note: n, score: hits / terms.length }
    })
    // One term out of five matching is not evidence — it is the coincidence
    // any sufficiently long query is guaranteed to produce somewhere in a
    // library this size, and with the cosine side floored to nothing on an
    // out-of-library question it would be the ENTIRE context the answer model
    // sees. So a long query has to hit at least two of its terms.
    //
    // Short queries keep the single-hit bar, because for them a conjunction is
    // a completely different (and far stricter) question: "skincare routine"
    // asked for two hits means a note must contain BOTH words, which is a
    // phrase search nobody asked for. The ratio below lands on 1 up to three
    // terms and 2 beyond, which is where the two failure modes trade off.
    .filter((s) => s.score * terms.length >= Math.min(2, Math.ceil(terms.length / 3)))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((s) => ({ ...stripEmbedding(s.note), score: s.score }))
}

// test-only: clean in-memory slate against a fresh in-memory database,
// mirroring collections.js / tagvocab.js's own _reset() helpers.
export function _reset({ loaded: isLoaded = true, keepDb = false } = {}) {
  if (!keepDb) _resetDb()
  notes = []
  pendingWrites = []
  loaded = isLoaded
  rev = 0
  tombstones = []
  tombstoneFloor = 0
}

// The searchable text of one note, lowercased — the same field list the
// embedding is built from, so both retrievers see the same note.
function haystackFor(n) {
  return [n.title, n.summary, n.content, n.siteTitle, n.siteDesc, n.article, n.thumbDescription, (n.tags || []).join(' ')]
    .filter(Boolean).join(' ').toLowerCase()
}

function stripEmbedding(n) {
  const { embedding, _rev, ...rest } = n
  return rest
}

function cosine(a, b) {
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
