// The note a bookmark-style export (Pocket, Raindrop, Omnivore, mymind) becomes.
// All four carry the same five facts, so they share one derivation and differ
// only in how they parse.
import { deriveTitle, heuristicType } from '../ai/normalise.ts'
import type { NoteRecord } from '../data/notes.ts'
import { clip, clipText } from './untrusted.ts'

const MAX_NOTE_LEN = 4000

// One wording for all four importers: written four times, they disagreed
// ("1 links were skipped", "it was not http(s) URL").
export const CAP_WARNING = 'item cap reached; the rest of the export was skipped'

export const refusedLinksWarning = (n: number) =>
  n === 1
    ? '1 link was skipped because it was not an http(s) URL'
    : `${n} links were skipped because they were not http(s) URLs`

// readCsv reads an unclosed quote to end of file, so the rows after it are one
// cell; without this the user saw only "fewer items" and no reason.
export const unterminatedWarning = (key: string) =>
  `${key} ends inside an unclosed quote, so its last rows may have been read as one`

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
  const title = clip(item.title)
  return {
    type: heuristicType(item.url),
    title: title || deriveTitle(item.url),
    // The export's title is often all that survives: Pocket libraries are
    // years old and many links are dead. enrichNote's classify read only the
    // URL plus fetched meta, so on a dead link it replaced this title (and
    // invented tags) from the URL alone. As siteTitle it reaches classify's
    // text, since enrichNote reads siteTitle from the fetch or else the note.
    // A live fetch still overwrites it (applyMeta keeps only truthy fields);
    // a note saved by hand holds no siteTitle before its first fetch, so its
    // classify text is unchanged.
    ...(title && { siteTitle: title }),
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
