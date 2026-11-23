import type { ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import type { Info, NotesPage, SpacesList } from '@kothai/api'
import { PASSWORD } from '../config.ts'
import * as store from '../data/notes.ts'
import * as collections from '../data/collections.ts'
import { json } from '../lib/http.ts'
import { visibleTo } from './demo.ts'
import { card } from './notes.ts'
import { decodeCursor, encodeCursor } from './v1-cursor.ts'

// Not imported from @kothai/api: that is a runtime value, and the runtime image
// carries no packages/ source, so the import would crash the server on boot.
// test/server/routes/v1-info.test.ts pins this to the package's API_VERSION.
const API_VERSION = 1
const MIN_CLIENT_VERSION = 1

// package.json ships in the runtime image; read once, not per request.
const SERVER_VERSION: string = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version

export function handleInfo(res: ServerResponse): void {
  const info: Info = {
    apiVersion: API_VERSION,
    minClientVersion: MIN_CLIENT_VERSION,
    serverVersion: SERVER_VERSION,
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
  const members = p.get('space') ? new Set(collections.get(p.get('space') as string)?.itemIds || []) : null
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

// Counts come from collections.all(visibleTo(viewer)), the same call behind
// /api/collections, so the two never disagree about what a visitor can see.
export function handleSpaces(res: ServerResponse, viewer: string | null): void {
  const body: SpacesList = {
    spaces: collections.all(visibleTo(viewer)).map(c => ({
      id: c.id,
      name: c.name,
      ...(c.parentId ? { parentId: c.parentId } : {}),
      count: c.count,
      createdAt: c.createdAt,
    })),
  }
  json(res, 200, body)
}
