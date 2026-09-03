import { normalizeTags } from '../lib/tags.js'
import * as store from '../data/notes.js'
import * as collections from '../data/collections.js'
import { json, readBody } from '../lib/http.js'
import { sanitizeCanvas } from '../lib/canvas.js'

// ---- collections (Spaces) ----------------------------------------------
export function handleCollections(res) {
  json(res, 200, { collections: collections.all() })
}

export async function handleCreateCollection(req, res) {
  const body = await readBody(req)
  const name = String(body.name || '').trim()
  if (!name) return json(res, 400, { error: 'name required' })
  const c = await collections.create({ name: name.slice(0, 120), tags: normalizeTags(body.tags, { max: 40 }) }, store.allNotes())
  json(res, 200, { collection: c })
}

export async function handleUpdateCollection(req, res, id) {
  const body = await readBody(req)
  const patch = {}
  if (typeof body.name === 'string') {
    const name = body.name.trim()
    if (!name) return json(res, 400, { error: 'name cannot be empty' })
    patch.name = name.slice(0, 120)
  }
  if (Array.isArray(body.tags)) patch.tags = normalizeTags(body.tags, { max: 40 })
  if (body.canvas === null) patch.canvas = null
  else if (body.canvas !== undefined) {
    const doc = sanitizeCanvas(body.canvas)
    if (!doc) return json(res, 400, { error: 'invalid canvas' })
    patch.canvas = doc
  }
  if (!Object.keys(patch).length) return json(res, 400, { error: 'nothing to update' })
  const c = await collections.update(id, patch, store.allNotes())
  if (!c) return json(res, 404, { error: 'collection not found' })
  json(res, 200, { collection: c })
}

export async function handleAddItem(req, res, id) {
  const body = await readBody(req)
  const itemId = String(body.itemId || '')
  if (!itemId) return json(res, 400, { error: 'itemId required' })
  if (!store.allNotes().some((n) => n.id === itemId)) return json(res, 404, { error: 'item not found' })
  const c = await collections.addItem(id, itemId)
  if (!c) return json(res, 404, { error: 'collection not found' })
  json(res, 200, { collection: c })
}

export async function handleRemoveItem(res, id, itemId) {
  const c = await collections.removeItem(id, itemId)
  if (!c) return json(res, 404, { error: 'collection not found' })
  json(res, 200, { collection: c })
}

export async function handleDeleteCollection(res, id) {
  const ok = await collections.remove(id)
  return json(res, ok ? 200 : 404, { ok })
}
