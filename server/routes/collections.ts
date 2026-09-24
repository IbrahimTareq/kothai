import { normalizeTags } from '../data/tags.ts'
import * as store from '../data/notes.ts'
import * as collections from '../data/collections.ts'
import { json, readBody } from '../lib/http.ts'
import { sanitizeCanvas } from '../lib/canvas.ts'
import { visibleTo } from './demo.ts'
import type { CollectionPatch } from '../data/collections.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'

// readBody hands back `unknown` — these bodies are whatever the client posted.
// Local rather than lifted into server/lib/: that directory is the security
// floor, and a guard there needs a test that fails without it (CLAUDE.md).
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

// ---- collections (Spaces) ----------------------------------------------
export function handleCollections(res: ServerResponse, viewer: string | null) {
  json(res, 200, { collections: collections.all(visibleTo(viewer)) })
}

export async function handleCreateCollection(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req)
  const fields = isRecord(body) ? body : {}
  const name = String(fields.name || '').trim()
  if (!name) return json(res, 400, { error: 'name required' })
  const c = await collections.create(
    { name: name.slice(0, 120), tags: normalizeTags(fields.tags, { max: 40 }) },
    store.allNotes(),
  )
  json(res, 200, { collection: c })
}

export async function handleUpdateCollection(req: IncomingMessage, res: ServerResponse, id: string) {
  const body = await readBody(req)
  const fields = isRecord(body) ? body : {}
  const patch: CollectionPatch = {}
  if (typeof fields.name === 'string') {
    const name = fields.name.trim()
    if (!name) return json(res, 400, { error: 'name cannot be empty' })
    patch.name = name.slice(0, 120)
  }
  if (Array.isArray(fields.tags)) patch.tags = normalizeTags(fields.tags, { max: 40 })
  if (fields.canvas === null) patch.canvas = null
  else if (fields.canvas !== undefined) {
    const doc = sanitizeCanvas(fields.canvas)
    if (!doc) return json(res, 400, { error: 'invalid canvas' })
    patch.canvas = doc
  }
  if (!Object.keys(patch).length) return json(res, 400, { error: 'nothing to update' })
  const c = await collections.update(id, patch, store.allNotes())
  if (!c) return json(res, 404, { error: 'collection not found' })
  json(res, 200, { collection: c })
}

export async function handleAddItem(req: IncomingMessage, res: ServerResponse, id: string) {
  const body = await readBody(req)
  const fields = isRecord(body) ? body : {}
  const itemId = String(fields.itemId || '')
  if (!itemId) return json(res, 400, { error: 'itemId required' })
  if (!store.allNotes().some(n => n.id === itemId)) return json(res, 404, { error: 'item not found' })
  const c = await collections.addItem(id, itemId)
  if (!c) return json(res, 404, { error: 'collection not found' })
  json(res, 200, { collection: c })
}

export async function handleRemoveItem(res: ServerResponse, id: string, itemId: string) {
  const c = await collections.removeItem(id, itemId)
  if (!c) return json(res, 404, { error: 'collection not found' })
  json(res, 200, { collection: c })
}

export async function handleDeleteCollection(res: ServerResponse, id: string) {
  const ok = await collections.remove(id)
  return json(res, ok ? 200 : 404, { ok })
}
