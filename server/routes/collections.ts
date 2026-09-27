import { normalizeTags } from '../data/tags.ts'
import * as store from '../data/notes.ts'
import * as collections from '../data/collections.ts'
import { json, readBody } from '../lib/http.ts'
import { sanitizeCanvas } from '../lib/canvas.ts'
import { demoLimits, visibleTo } from './demo.ts'
import type { CollectionPatch } from '../types.ts'
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

// On the demo, a visitor may change only a space they made. A shared one, or
// another visitor's, answers exactly like a missing one.
const notMine = (viewer: string | null, id: string) => !!viewer && collections.get(id)?.visitor !== viewer

// Whether `parentId` may hold space `id` (null: a space not made yet). Answers
// the error to send, or null when it may. On the demo a parent the visitor did
// not make answers like a missing space, as notMine does, so a visitor's tree
// only ever holds their own spaces. The walk up always ends at the top level:
// every stored parentId passed through here, or through a restore, which
// refuses a backup whose spaces loop (spacesNest in routes/backup.ts).
function parentError(viewer: string | null, id: string | null, parentId: unknown) {
  const bad = { code: 400, error: 'invalid parent' }
  if (typeof parentId !== 'string' || !parentId) return bad
  if (notMine(viewer, parentId)) return { code: 404, error: 'collection not found' }
  if (!collections.get(parentId)) return bad
  for (let at: string | undefined = parentId; at; at = collections.get(at)?.parentId) {
    if (at === id) return bad
  }
  return null
}

// `viewer` is the demo visitor (routes/demo.ts), null on an ordinary install.
export async function handleCreateCollection(req: IncomingMessage, res: ServerResponse, viewer: string | null) {
  const body = await readBody(req)
  const fields = isRecord(body) ? body : {}
  const name = String(fields.name || '').trim()
  if (!name) return json(res, 400, { error: 'name required' })
  const { parentId } = fields
  if (parentId !== undefined) {
    const bad = parentError(viewer, null, parentId)
    if (bad) return json(res, bad.code, { error: bad.error })
  }
  if (viewer && !demoLimits.space.take(viewer)) {
    return json(res, 429, { error: 'That’s all the demo spaces in a day. Try again tomorrow.', code: 'demo_limit' })
  }
  // A smart rule fills only from what the maker can see: the reads would hide
  // another visitor's links anyway, but they would still be stored in the space.
  const c = await collections.create(
    {
      name: name.slice(0, 120),
      tags: normalizeTags(fields.tags, { max: 40 }),
      visitor: viewer ?? undefined,
      parentId: typeof parentId === 'string' ? parentId : undefined,
    },
    store.allNotes().filter(visibleTo(viewer)),
  )
  json(res, 200, { collection: c })
}

export async function handleUpdateCollection(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  viewer: string | null,
) {
  if (notMine(viewer, id)) return json(res, 404, { error: 'collection not found' })
  const body = await readBody(req)
  const fields = isRecord(body) ? body : {}
  const patch: CollectionPatch = {}
  if (typeof fields.name === 'string') {
    const name = fields.name.trim()
    if (!name) return json(res, 400, { error: 'name cannot be empty' })
    patch.name = name.slice(0, 120)
  }
  if (typeof fields.description === 'string') patch.description = fields.description.trim().slice(0, 500)
  if (Array.isArray(fields.tags)) patch.tags = normalizeTags(fields.tags, { max: 40 })
  if (fields.parentId === null) patch.parentId = null
  else if (fields.parentId !== undefined) {
    const bad = parentError(viewer, id, fields.parentId)
    if (bad) return json(res, bad.code, { error: bad.error })
    patch.parentId = String(fields.parentId)
  }
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

export async function handleAddItem(req: IncomingMessage, res: ServerResponse, id: string, viewer: string | null) {
  if (notMine(viewer, id)) return json(res, 404, { error: 'collection not found' })
  const body = await readBody(req)
  const fields = isRecord(body) ? body : {}
  const itemId = String(fields.itemId || '')
  if (!itemId) return json(res, 400, { error: 'itemId required' })
  // Another visitor's link would be hidden in the space anyway, but still stored in it.
  const visible = visibleTo(viewer)
  if (!store.allNotes().some(n => n.id === itemId && visible(n))) return json(res, 404, { error: 'item not found' })
  const c = await collections.addItem(id, itemId)
  if (!c) return json(res, 404, { error: 'collection not found' })
  json(res, 200, { collection: c })
}

export async function handleRemoveItem(res: ServerResponse, id: string, itemId: string, viewer: string | null) {
  if (notMine(viewer, id)) return json(res, 404, { error: 'collection not found' })
  const c = await collections.removeItem(id, itemId)
  if (!c) return json(res, 404, { error: 'collection not found' })
  json(res, 200, { collection: c })
}

export async function handleDeleteCollection(res: ServerResponse, id: string, viewer: string | null) {
  if (notMine(viewer, id)) return json(res, 404, { ok: false })
  const ok = await collections.remove(id)
  return json(res, ok ? 200 : 404, { ok })
}
