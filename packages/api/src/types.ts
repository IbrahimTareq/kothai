// The /api/v1 wire contract. Server and clients both import these as types
// only, so a drift between them is a typecheck error rather than a field that
// silently reads undefined on a phone.

export const API_VERSION = 1

export interface ApiError {
  error: string
  code: string
}

export interface Info {
  apiVersion: number
  minClientVersion: number
  signIn: ('password' | 'none')[]
  cloud: boolean
}

// What card() in server/routes/notes.ts sends: ServerNote (server/types.ts)
// minus `embedding`, which never leaves the server, and the sweep bookkeeping
// card() strips. Every field the server may omit is optional.
export interface Note {
  id: string
  createdAt: string
  type: 'link' | 'video'
  category: string
  title: string
  summary: string
  tags: string[]
  content: string
  url: string | null
  account?: string | null
  mindNote?: string
  pending?: boolean
  metaFetched?: boolean
  unavailable?: boolean
  unavailableAt?: string | null
  siteTitle?: string | null
  siteDesc?: string | null
  siteName?: string | null
  thumb?: string | null
  thumbRatio?: number | null
  slides?: string[]
  score?: number
  visitor?: string
}

export interface Space {
  id: string
  name: string
  parentId?: string
  count: number
  createdAt: string
}

export interface NotesPage {
  notes: Note[]
  next: string | null
}

export interface SpacesList {
  spaces: Space[]
}

export type Changes =
  | { resync: true; cursor: string }
  | { resync?: false; cursor: string; notes: Note[]; deleted: string[]; spaces?: Space[] }

export interface SaveRequest {
  url: string
  note?: string
}

export interface SaveResponse {
  note: Note
}
