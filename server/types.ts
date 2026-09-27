// Domain types for the Kothai server.
//
// DELIBERATELY DUPLICATED from client/types.ts, which describes the same wire
// format from the other side. biome.json's noRestrictedImports fails any
// import between client/ and server/ — "shared meaning crosses the HTTP
// boundary, or is duplicated deliberately" — because the two are separately
// deployed and their wire format is allowed to drift across a version
// boundary. A shared module would couple their release cadence to buy
// nothing. If you change a field here, change its counterpart there in the
// same commit.
import type { CanvasDoc } from './lib/canvas.ts'

export type NoteType = 'link' | 'video'

export interface ServerNote {
  id: string
  createdAt: string
  type: NoteType
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
  // Written by the availability sweep alongside `unavailable`; nothing reads
  // it back yet. Declared rather than dropped because it is already on disk in
  // every note an earlier scan marked, and a mark whose date has been thrown
  // away can neither be explained to the user nor aged out later.
  unavailableAt?: string | null
  // When the sweep last asked about this link, whatever the answer. The daily
  // Instagram slice is taken oldest-first from this, and the newest one across
  // the library is how a restart knows today's sweep already ran.
  availabilityCheckedAt?: string | null
  siteTitle?: string | null
  siteDesc?: string | null
  siteName?: string | null
  thumb?: string | null
  thumbRatio?: number | null // width / height of `thumb`, so a card can hold its shape before it loads
  // Local paths to an Instagram carousel's slides, in post order. Absent until
  // the item has been opened once (slides are fetched lazily) and for any post
  // that turned out to be a single image.
  slides?: string[]
  score?: number
  // Set only on the public demo (server/routes/demo.ts): the visitor who saved
  // this link, and so the only one shown it. Absent on every note of an
  // ordinary install and on the demo's shared library, which is what makes
  // those visible to everyone.
  visitor?: string
  // Held server-side only — stripped before transport, which is why it has no
  // counterpart in client/types.ts.
  //
  // Three shapes, not one: Float32Array coming off disk (decodeEmbedding),
  // a plain number[] fresh from a provider (an OpenAI-compatible /embeddings
  // response is JSON), and null on a note created before anything embedded it.
  embedding?: Float32Array | number[] | null
}

// A Space (data/collections.ts). Mirrors Collection in client/types.ts, minus
// what the server adds on the way out (count, covers).
export type NewCollection = { name: string; tags?: string[]; visitor?: string; parentId?: string } // visitor: see ServerNote.visitor

// The stored document. `canvas` is optional rather than nullable because
// update() in data/collections.ts DELETES the key to clear a board — the
// route sends null, and the absence is what a reader tests for.
export interface Collection extends NewCollection {
  id: string
  createdAt: string
  tags: string[]
  itemIds: string[]
  removedIds: string[]
  canvas?: CanvasDoc
  description?: string
}

export type CollectionPatch = Partial<Pick<Collection, 'name' | 'description' | 'tags'>> & {
  canvas?: CanvasDoc | null
  parentId?: string | null
}
