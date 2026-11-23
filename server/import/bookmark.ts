// The note a bookmark-style export (Pocket, Raindrop, Omnivore, mymind) becomes.
// All four carry the same five facts, so they share one derivation and differ
// only in how they parse.
import { deriveTitle, heuristicType } from '../ai/normalise.ts'
import type { NoteRecord } from '../data/notes.ts'
import { clip, clipText } from './untrusted.ts'

const MAX_NOTE_LEN = 4000

export interface BookmarkItem {
  url: string
  title: string
  tags: string[]
  note: string
  // Unix seconds; 0 when the export had no usable date.
  savedAt: number
}

export function deriveBookmarkNote(item: BookmarkItem): Partial<NoteRecord> {
  const note = clipText(item.note, MAX_NOTE_LEN)
  return {
    type: heuristicType(item.url),
    title: clip(item.title) || deriveTitle(item.url),
    content: item.url, // enrich reads `content` as the note's text
    url: item.url,
    tags: item.tags,
    createdAt: item.savedAt > 0 ? new Date(item.savedAt * 1000).toISOString() : new Date().toISOString(),
    pending: true,
    ...(note && { mindNote: note }),
    // Tags in an export are the user's own; marking them edited makes
    // enrichment keep them rather than replace them.
    ...(item.tags.length && { ai: { tagsEdited: true } }),
  }
}
