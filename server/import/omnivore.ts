// Parses Omnivore's export (Settings → Export) into bookmark items. Same trust
// posture as server/import/pocket.ts: the files are a user upload and treated
// as hostile, and every unexpected shape degrades to "fewer items" plus a
// warning rather than a failed import.
//
// The export is many `metadata_<a>_to_<b>.json` arrays (20 items each, so a big
// library is hundreds of files) beside `content/<slug>.html|.pdf` and
// `highlights/<slug>.md`. Content is the saved page itself, which Kothai
// re-fetches anyway, so it is ignored. A highlights file joins its item by
// slug and becomes the note.
import { type BookmarkItem, deriveBookmarkNote } from './bookmark.ts'
import { clip, clipText, importDate, importTags, isRecord, tryJson, usableUrl } from './untrusted.ts'

export const name = 'omnivore'
export const label = 'Omnivore'
export const expects =
  'the metadata_*.json files from your Omnivore export (and highlights/*.md if you want highlights), or the ZIP'

const METADATA_FILE = /(^|\/)metadata_[^/]*\.json$/i
// A renamed download still carries Omnivore's own keys; no other export has both.
const SLUG_MARKER = Buffer.from('"slug"')
const SAVED_AT_MARKER = Buffer.from('"savedAt"')

const MAX_HIGHLIGHT_LEN = 4000

export function sniff(files: Map<string, Buffer>): boolean {
  for (const [key, buf] of files) {
    if (METADATA_FILE.test(key)) return true
    if (key.toLowerCase().endsWith('.json') && buf.includes(SLUG_MARKER) && buf.includes(SAVED_AT_MARKER)) return true
  }
  return false
}

// The route prefixes each upload with `<index>/` and ZIP entries keep their
// inner path, so the same highlight is `0/highlights/x.md` or a loose `3/x.md`.
const highlightsBySlug = (files: Map<string, Buffer>) => {
  const bySlug = new Map<string, string>()
  for (const [key, buf] of files) {
    if (!key.toLowerCase().endsWith('.md')) continue
    const slug = key.slice(key.lastIndexOf('/') + 1, -'.md'.length)
    // Bound the decode: a hostile .md must not cost a full-size string before clipText.
    bySlug.set(slug, clipText(buf.subarray(0, MAX_HIGHLIGHT_LEN * 4).toString('utf8'), MAX_HIGHLIGHT_LEN))
  }
  return bySlug
}

export function parse(files: Map<string, Buffer>) {
  const items: BookmarkItem[] = []
  const warnings: string[] = []
  const highlights = highlightsBySlug(files)
  let unusableUrl = 0

  for (const [key, buf] of files) {
    if (!METADATA_FILE.test(key)) continue
    const rows = tryJson(buf)
    if (!Array.isArray(rows)) {
      warnings.push(`${key} is not an Omnivore metadata file (expected a JSON array)`)
      continue
    }
    for (const row of rows) {
      if (!isRecord(row)) continue
      const url = usableUrl(row.url)
      if (!url) {
        // A row with no url at all is blank, not a refusal worth reporting.
        if (typeof row.url === 'string' && row.url.trim()) unusableUrl++
        continue
      }
      items.push({
        url,
        title: clip(row.title),
        tags: importTags(row.labels, ','),
        note: typeof row.slug === 'string' ? (highlights.get(row.slug) ?? '') : '',
        savedAt: importDate(row.savedAt),
      })
    }
  }

  if (unusableUrl > 0) {
    warnings.push(
      unusableUrl === 1
        ? '1 link was skipped because it was not an http(s) URL'
        : `${unusableUrl} links were skipped because they were not http(s) URLs`,
    )
  }
  return { items, collections: [], warnings }
}

export const deriveNote = deriveBookmarkNote
