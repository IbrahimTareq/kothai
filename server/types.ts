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

export type NoteType = 'link' | 'image' | 'video' | 'code' | 'text'

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
  image: string | null
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
  embedding?: Float32Array | number[] | null
}
