// Shared domain types for the Kothai client.

// Types the server persists/emits. "text" becomes "note" in the UI.
export type NoteType = 'link' | 'image' | 'video' | 'code' | 'text'

// Types the UI renders. ("text" becomes "note".)
export type UIType = 'link' | 'image' | 'video' | 'code' | 'note'

export type ViewMode = 'grid4' | 'grid6' | 'grid8'
export type CaptureMode = 'store' | 'ask'

// A note as returned by the server (embeddings are stripped before transport).
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
}

// The flattened shape the UI renders (produced by mapNote).
export interface UIItem {
  id: string
  ts: number
  type: UIType
  tags: string[]
  category?: string
  summary?: string
  mindNote?: string
  pending: boolean
  /** Whether link metadata has been ATTEMPTED. `pending` only says the model
   *  pass hasn't run — a note can be permanently thumbnail-less and still
   *  pending — so this is what separates "content is on its way" from "this
   *  is all the content there will be". See isAwaitingContent in Cards.tsx. */
  metaFetched?: boolean
  /** The link was checked and its content is gone. A reversible mark, never a
   *  deletion — see server/routes/availability.js. */
  unavailable?: boolean
  url?: string | null
  host?: string
  title?: string
  note?: string
  thumb?: string | null
  slides?: string[]
  siteName?: string | null
  img?: string | null
  name?: string
  lang?: string
  text?: string
  seed?: number
  score?: number
}

export interface Category {
  id: UIType
  label: string
  glyph: string
}

// What client-side detection infers from raw pasted text (for the detect chip).
export interface Detection {
  type: UIType
  url?: string
  host?: string
  lang?: string
}

export type Residency = 'off' | 'ondemand' | 'always'

export interface RoleStatus {
  state: 'off' | 'idle' | 'loading' | 'ready' | 'error'
  progress: number
  message: string
  model: string
}

export interface ModelStatus {
  roles: { llm: RoleStatus; embed: RoleStatus; vision: RoleStatus }
  aggregate: { state: 'loading' | 'ready' | 'error'; progress: number; message: string }
  configured: boolean   // false until the first-run model picker is completed
  count: number
}

// Derived, UI-facing status of the model "vault".
export interface VaultStatus {
  state: 'loading' | 'ready' | 'error'
  txt: string
  pct: number
  msg?: string
}

export interface ChatSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  questions: number
}

export interface ChatMessage {
  ts?: string
  role: 'user' | 'ai'
  text?: string
  image?: string | null
  sources?: ServerNote[]
  cited?: UIItem[]
}

export interface Chat {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messages: ChatMessage[]
}

// A single message rendered in the live Ask thread.
export interface ThreadMsg {
  role: 'user' | 'ai'
  // Stable slot id for an answer that is still in flight, so the reply is
  // written back to the bubble that asked for it rather than to whatever
  // happens to be last in the thread.
  id?: string
  text?: string
  img?: string | null
  pending?: boolean
  lead?: string
  cited?: UIItem[]
  q?: string
  ts?: number         // when the message was sent, for the thread's clock stamps
  stopped?: boolean   // the user pressed stop before this answer finished
  streaming?: boolean // tokens are still arriving into `lead`
}

export interface ModelPreset {
  key: string
  label: string
  desc: string
  best: string[]
  proj?: string
  sizeBytes: number
}

export interface Capabilities {
  kind: 'local' | 'remote'
  managesResidency: boolean
  downloadsWeights: boolean
}

export interface EndpointInfo {
  configured: boolean
  host: string | null
}

export interface SettingsResponse {
  current: { llm: string; embed: string; vision: string }
  remote: { llm: string; embed: string; vision: string }
  residency: { llm: Residency; embed: Residency; vision: Residency }
  presets: { llm: ModelPreset[]; embed: ModelPreset[]; vision: ModelPreset[] }
  capabilities: Capabilities
  endpoint: EndpointInfo
}

export interface Collection {
  id: string
  createdAt: string
  name: string
  tags: string[]      // smart rule; [] = pure manual collection
  itemIds: string[]   // membership, newest-first
  removedIds: string[]
  count: number       // resolved by the server (= itemIds.length)
  covers?: UIItem[]   // tile preview — first few members, newest-first; absent on endpoints that don't join it
}
