// Domain types for the Kothai server.
//
// DELIBERATELY DUPLICATED from client/types.ts, which describes the same wire
// format from the other side. CLAUDE.md calls the zero cross-imports between
// client/ and server/ load-bearing, and it is: the two are separately deployed
// and their wire format is allowed to drift across a version boundary. A
// shared module would couple their release cadence to buy nothing. If you
// change a field here, change its counterpart there in the same commit.

export type NoteType = 'link' | 'image' | 'video' | 'code' | 'text'

export interface Note {
  id: string
  createdAt: string
  type: NoteType
  category: string
  title: string
  summary: string
  tags: string[]
  content: string
  url: string | null
  image: string | null
  account?: string | null
  mindNote?: string
  pending?: boolean
  metaFetched?: boolean
  unavailable?: boolean
  siteTitle?: string | null
  siteDesc?: string | null
  siteName?: string | null
  thumb?: string | null
  // Local paths to an Instagram carousel's slides, in post order. Absent until
  // the item has been opened once (slides are fetched lazily) and for any post
  // that turned out to be a single image.
  slides?: string[]
  description?: string
  score?: number
  // Held server-side only — stripped before transport, which is why it has no
  // counterpart in client/types.ts.
  //
  // Three shapes, not one: Float32Array coming off disk (decodeEmbedding),
  // a plain number[] fresh from a provider (an OpenAI-compatible /embeddings
  // response is JSON), and null on a note created before anything embedded it.
  // searchByVector in server/data/notes.js reads `.length` precisely because
  // both array shapes reach it.
  embedding?: Float32Array | number[] | null
}
