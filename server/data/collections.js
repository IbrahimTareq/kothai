// User "Spaces" = collections of saved items. A collection groups item ids and
// may carry a smart tag rule: any item whose tags intersect the rule is
// auto-added — at import time and when backfilling. Membership lives here, not
// on notes, so the notes table and its embed path stay untouched. This module
// holds NO dependency on the note store: callers pass note data in (tags for
// autoAdd, the full note list for backfill), which keeps the boundary clean
// and the logic trivially testable.
import { randomUUID } from 'node:crypto'
import { getDb, _resetDb } from './db.js'
import { normalizeTag } from '../lib/tags.js'
import * as notesStore from './notes.js'

let collections = []
let loaded = false

export async function load() {
  if (loaded) return
  const db = await getDb()
  collections = db.prepare('SELECT data FROM collections ORDER BY seq DESC').all().map((r) => JSON.parse(r.data))
  loaded = true
}

function insertRow(db, c) {
  db.prepare('INSERT INTO collections (id, data) VALUES (?, ?)').run(c.id, JSON.stringify(c))
}

function updateRow(db, c) {
  db.prepare('UPDATE collections SET data = ? WHERE id = ?').run(JSON.stringify(c), c.id)
}

async function deleteRow(id) {
  (await getDb()).prepare('DELETE FROM collections WHERE id = ?').run(id)
}

// test-only: clean in-memory slate against a fresh in-memory database.
export function _reset() {
  _resetDb()
  collections = []
  loaded = true
}

// Normalize tags for case-insensitive matching / storage.
function norm(tags) {
  return (tags || []).map(normalizeTag).filter(Boolean)
}

// Does an item with `noteTags` satisfy a `ruleTags` rule (match ANY)?
export function matchesRule(noteTags, ruleTags) {
  if (!ruleTags || ruleTags.length === 0) return false
  const rule = new Set(norm(ruleTags))
  return norm(noteTags).some((t) => rule.has(t))
}

function find(id) {
  return collections.find((c) => c.id === id)
}

function withCount(c) {
  return { ...c, count: c.itemIds.length }
}

// Tile previews for the Spaces list — the first few member notes, newest
// membership first (itemIds order), embeddings already stripped by allNotes().
const COVER_COUNT = 3
function withCovers(c) {
  const byId = new Map(notesStore.allNotes().map((n) => [n.id, n]))
  const covers = c.itemIds.map((id) => byId.get(id)).filter(Boolean).slice(0, COVER_COUNT)
  return { ...withCount(c), covers }
}

// Erase every space — see notes.clearAll(). Membership lives entirely in
// these rows, so there's nothing to clean up on the notes side.
export async function clearAll() {
  const removed = collections.length
  collections = []
  ;(await getDb()).prepare('DELETE FROM collections').run()
  return removed
}

export function all() {
  return collections.map(withCovers)
}

export function get(id) {
  const c = find(id)
  return c ? withCount(c) : null
}

// Prepend an id (dedup) and clear any prior manual removal.
function attach(c, itemId) {
  if (!c.itemIds.includes(itemId)) c.itemIds.unshift(itemId)
  c.removedIds = c.removedIds.filter((x) => x !== itemId)
}

// Drop the canvas card for an item that left the space, plus any line that
// touched it. A canvas never carries a card for a non-member. Returns whether
// the doc changed.
function pruneCanvas(c, itemId) {
  if (!c.canvas) return false
  const gone = new Set(c.canvas.nodes.filter((n) => n.type === 'item' && n.itemId === itemId).map((n) => n.id))
  if (!gone.size) return false
  c.canvas = {
    nodes: c.canvas.nodes.filter((n) => !gone.has(n.id)),
    edges: c.canvas.edges.filter((e) => !gone.has(e.fromNode) && !gone.has(e.toNode)),
  }
  return true
}

// Add all current tag-matching notes to a smart collection (in-memory; caller
// persists). Respects removedIds. `notes` is an array of at least { id, tags }.
export function backfill(c, notes) {
  for (const n of notes) {
    if (c.removedIds.includes(n.id)) continue
    if (matchesRule(n.tags, c.tags)) attach(c, n.id)
  }
}

// Create a collection. `notes` (optional) backfills a smart rule at creation.
export async function create({ name, tags = [] }, notes = []) {
  const c = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    name,
    tags: norm(tags),
    itemIds: [],
    removedIds: [],
  }
  collections.unshift(c)
  if (c.tags.length) backfill(c, notes)
  insertRow(await getDb(), c)
  return withCovers(c)
}

// Rename, edit the smart rule and/or replace the canvas. Editing tags re-runs
// backfill (additive — never removes items that no longer match). Returns
// null if not found.
export async function update(id, patch, notes = []) {
  const c = find(id)
  if (!c) return null
  if (typeof patch.name === 'string') c.name = patch.name
  if (Array.isArray(patch.tags)) {
    c.tags = norm(patch.tags)
    if (c.tags.length) backfill(c, notes)
  }
  // The route has already sanitized `canvas`; null clears the board.
  if ('canvas' in patch) {
    if (patch.canvas === null) delete c.canvas
    else c.canvas = patch.canvas
  }
  updateRow(await getDb(), c)
  return withCovers(c)
}

export async function remove(id) {
  const before = collections.length
  collections = collections.filter((c) => c.id !== id)
  const changed = collections.length !== before
  if (changed) await deleteRow(id)
  return changed
}

// Manual add.
export async function addItem(id, itemId) {
  const c = find(id)
  if (!c) return null
  attach(c, itemId)
  updateRow(await getDb(), c)
  return withCovers(c)
}

// Batched addItem: attach every id, then write the row ONCE.
//
// Bulk import files thousands of memberships at a time, and per-call addItem
// makes that quadratic twice over. `itemIds` is a JSON blob inside the row, so
// a per-membership updateRow re-serialises the whole (growing) array on every
// add — 1,675 memberships rewrote 54.7MB of JSON across 1,675 separate
// commits, measured at 152ms on a WAL database against 1ms batched. Worse,
// addItem returns withCovers(), which copies EVERY note in the store and
// builds a Map over the copy: another 255ms of work for the same 1,675 calls,
// and the importer discards the return value entirely.
//
// Semantics are identical to calling addItem in a loop — attach() dedups and
// clears removedIds the same way, and unshift order is preserved — so this is
// purely the same work done once.
export async function addItems(id, itemIds) {
  const c = find(id)
  if (!c) return null
  let changed = false
  for (const itemId of itemIds) {
    const before = c.itemIds.length + c.removedIds.length
    attach(c, itemId)
    if (c.itemIds.length + c.removedIds.length !== before) changed = true
  }
  // A no-op re-import (every id already filed) must not cost a row write.
  if (changed) updateRow(await getDb(), c)
  return withCovers(c)
}

// Manual remove — sticks (auto-add won't re-add it).
export async function removeItem(id, itemId) {
  const c = find(id)
  if (!c) return null
  c.itemIds = c.itemIds.filter((x) => x !== itemId)
  if (!c.removedIds.includes(itemId)) c.removedIds.push(itemId)
  pruneCanvas(c, itemId)
  updateRow(await getDb(), c)
  return withCovers(c)
}

// Fired when an item is imported/classified. Adds it to every smart collection
// whose rule its tags satisfy (unless previously hand-removed).
export async function autoAdd(itemId, itemTags) {
  const touched = []
  for (const c of collections) {
    if (!c.tags.length) continue
    if (c.removedIds.includes(itemId)) continue
    if (c.itemIds.includes(itemId)) continue
    if (matchesRule(itemTags, c.tags)) {
      c.itemIds.unshift(itemId)
      touched.push(c)
    }
  }
  if (touched.length) {
    const db = await getDb()
    for (const c of touched) updateRow(db, c)
  }
}

// When a note is deleted, purge its id from every collection.
export async function deleteItemEverywhere(itemId) {
  const touched = []
  for (const c of collections) {
    const bi = c.itemIds.length
    const br = c.removedIds.length
    c.itemIds = c.itemIds.filter((x) => x !== itemId)
    c.removedIds = c.removedIds.filter((x) => x !== itemId)
    const pruned = pruneCanvas(c, itemId)
    if (pruned || c.itemIds.length !== bi || c.removedIds.length !== br) touched.push(c)
  }
  if (touched.length) {
    const db = await getDb()
    for (const c of touched) updateRow(db, c)
  }
}
