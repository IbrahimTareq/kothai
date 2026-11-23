import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Changes, Info, NotesPage, SaveResponse, Space, SpacesList } from '@kothai/api'
import { PASSWORD } from '../config.ts'
import * as store from '../data/notes.ts'
import * as collections from '../data/collections.ts'
import * as ai from '../ai/index.ts'
import { saveCapture } from '../capture.ts'
import { json, readBody } from '../lib/http.ts'
import { demoLimits, visibleTo } from './demo.ts'
import { card } from './notes.ts'
import { decodeCursor, encodeCursor } from './v1-cursor.ts'

// Not imported from @kothai/api: that is a runtime value, and the runtime image
// carries no packages/ source, so the import would crash the server on boot.
// test/server/routes/v1-info.test.ts pins this to the package's API_VERSION.
const API_VERSION = 1
const MIN_CLIENT_VERSION = 1

// No build version here: this route answers strangers before the gate, and the
// install's exact version is fingerprinting they do not need.
export function handleInfo(res: ServerResponse): void {
  const info: Info = {
    apiVersion: API_VERSION,
    minClientVersion: MIN_CLIENT_VERSION,
    signIn: PASSWORD ? ['password'] : ['none'],
    cloud: false,
  }
  json(res, 200, info)
}

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 200

interface NotesCursor {
  createdAt: string
  id: string
}

function isNotesCursor(c: Partial<NotesCursor> | null): c is NotesCursor {
  return typeof c?.createdAt === 'string' && typeof c.id === 'string'
}

// Newest first by createdAt, ties by id DESC. A keyset needs a total order, and
// createdAt alone has ties (a bulk import stamps many notes in one millisecond):
// a page boundary inside a tie would skip or repeat notes. This differs from
// /api/notes, whose sortNotes breaks ties by insertion order; offsets tolerate
// that, a cursor cannot.
const newerFirst = (a: NotesCursor, b: NotesCursor) =>
  a.createdAt === b.createdAt ? (a.id === b.id ? 0 : a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1

export function handleNotesPage(res: ServerResponse, url: URL, viewer: string | null): void {
  const p = url.searchParams
  const raw = p.get('cursor')
  const decoded = raw === null ? null : decodeCursor<Partial<NotesCursor>>(raw)
  const after = isNotesCursor(decoded) ? decoded : null
  if (raw !== null && !after) {
    json(res, 400, { error: 'bad cursor', code: 'bad_cursor' })
    return
  }
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(p.get('limit') || '', 10) || DEFAULT_LIMIT))
  // A stale cached space id must read as gone, and on the demo another visitor's
  // space answers like a missing one, so neither is an empty page.
  const spaceId = p.get('space')
  const space = spaceId ? collections.get(spaceId) : null
  if (spaceId && (!space || !visibleTo(viewer)(space))) {
    json(res, 404, { error: 'space not found', code: 'not_found' })
    return
  }
  const members = space ? new Set(space.itemIds) : null
  // Unavailable notes are hidden as the board hides them (query.applyFilters).
  const rows = store
    .allNotes()
    .filter(visibleTo(viewer))
    .filter(n => !n.unavailable && (!members || members.has(n.id)))
    .map(card)
    .sort(newerFirst)
  const rest = after ? rows.filter(n => newerFirst(after, n) < 0) : rows
  const notes = rest.slice(0, limit)
  const last = notes[notes.length - 1]
  const body: NotesPage = {
    notes,
    next: rest.length > limit ? encodeCursor({ createdAt: last.createdAt, id: last.id } satisfies NotesCursor) : null,
  }
  json(res, 200, body)
}

// The visible space list, shared by /api/v1/spaces and the change feed. Counts
// come from collections.all(visibleTo(viewer)), the same call behind
// /api/collections, so none of them disagree about what a visitor can see.
const visibleSpaces = (viewer: string | null): Space[] =>
  collections.all(visibleTo(viewer)).map(c => ({
    id: c.id,
    name: c.name,
    ...(c.parentId ? { parentId: c.parentId } : {}),
    count: c.count,
    createdAt: c.createdAt,
  }))

export function handleSpaces(res: ServerResponse, viewer: string | null): void {
  const body: SpacesList = { spaces: visibleSpaces(viewer) }
  json(res, 200, body)
}

interface ChangesCursor {
  boot: string
  rev: number
  spacesRev: number
}

function isChangesCursor(c: Partial<ChangesCursor> | null): c is ChangesCursor {
  return typeof c?.boot === 'string' && Number.isInteger(c.rev) && Number.isInteger(c.spacesRev)
}

// The offline cache's sync feed; /api/notes/delta's twin (see its comment). A
// cursor from another boot (rev restarts at 0, so its numbers mean nothing) or
// older than the tombstone window (deletions may be missing) answers resync,
// since the client cannot trust a partial answer. No `since` is also a resync:
// that is how a client gets its first cursor.
export function handleChanges(res: ServerResponse, url: URL, viewer: string | null): void {
  const raw = url.searchParams.get('since')
  const { rev, bootId } = store.revState()
  const spacesRev = collections.spacesRevState()
  const cursor = encodeCursor({ boot: bootId, rev, spacesRev } satisfies ChangesCursor)
  const resync: Changes = { resync: true, cursor }
  if (raw === null) {
    json(res, 200, resync)
    return
  }
  const since = decodeCursor<Partial<ChangesCursor>>(raw)
  if (!isChangesCursor(since)) {
    json(res, 400, { error: 'bad cursor', code: 'bad_cursor' })
    return
  }
  if (since.boot !== bootId || !store.deltaOk(since.rev)) {
    json(res, 200, resync)
    return
  }
  const body: Changes = {
    cursor,
    // Deletions go out unfiltered: a tombstone is only a random id, and a client
    // drops one it never held.
    notes: store.changedSince(since.rev).filter(visibleTo(viewer)).map(card),
    deleted: store.deletedSince(since.rev),
    // The full list, not a diff: counts and covers shift with membership, so a
    // per-space delta would be as large as the list for a typical library.
    ...(since.spacesRev !== spacesRev ? { spaces: visibleSpaces(viewer) } : {}),
  }
  json(res, 200, body)
}

// The share extension's save: /api/save with a note alongside the link. Same
// refusals as /api/save, in the same words, so a client can share one error path.
export async function handleSaveV1(req: IncomingMessage, res: ServerResponse, viewer: string | null): Promise<void> {
  // Only the parse failure is caught: an oversized body destroys the socket
  // before any answer could be written, so there is nothing to send for it.
  const body = await readBody(req).catch(() => undefined)
  if (body === undefined) return json(res, 400, { error: 'invalid JSON body', code: 'bad_json' })
  const { url, note } = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const link = typeof url === 'string' ? url.trim() : ''
  if (!ai.isLikelyUrl(link)) {
    return json(res, 400, { error: 'Kothai saves links: paste one starting with https://', code: 'links_only' })
  }
  if (viewer && !demoLimits.save.take(viewer)) {
    return json(res, 429, { error: 'That’s all the demo saves in a day. Try again tomorrow.', code: 'demo_limit' })
  }
  const saved = await saveCapture({ url: link, visitor: viewer, mindNote: typeof note === 'string' ? note : undefined })
  const out: SaveResponse = { note: card(saved) }
  json(res, 200, out)
}
