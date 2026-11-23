// Parses Raindrop.io's CSV export (Settings → Backups/Export) into bookmark
// items. Same trust posture as server/import/pocket.ts: the file is a user
// upload and treated as hostile, and every unexpected shape degrades to "fewer
// items" plus a warning rather than a failed import.
//
// Each folder becomes a flat Space named by its full path ("Design / Artists"):
// Raindrop nests folders, Spaces do not, and the full string keeps two
// same-named leaves under different parents apart. Items in `Unsorted` are in
// no folder, so they make no Space.
import { type BookmarkItem, deriveBookmarkNote } from './bookmark.ts'
import { csvHeader, readCsv } from './csv.ts'
import { clip, clipText, importDate, importTags, usableUrl } from './untrusted.ts'

export const name = 'raindrop'
export const label = 'Raindrop'
export const expects = 'the CSV from Raindrop → Settings → Backups/Export'

// The file name is arbitrary (Raindrop names it by date), so the header is the test.
const REQUIRED = ['url', 'folder', 'excerpt']
const hasRaindropHeader = (header: string[]) => REQUIRED.every(c => header.includes(c))

// The note and the highlights are each capped like deriveBookmarkNote caps the
// joined text, so neither can crowd the other out before that cap runs.
const MAX_NOTE_PART = 4000

export function sniff(files: Map<string, Buffer>): boolean {
  for (const [key, buf] of files) {
    if (key.toLowerCase().endsWith('.csv') && hasRaindropHeader(csvHeader(buf))) return true
  }
  return false
}

export function parse(files: Map<string, Buffer>) {
  const items: BookmarkItem[] = []
  const folders = new Map<string, string[]>()
  const warnings: string[] = []
  let unusableUrl = 0
  let capped = false

  for (const [key, buf] of files) {
    if (!key.toLowerCase().endsWith('.csv')) continue
    const { header, rows, truncated } = readCsv(buf)
    if (!hasRaindropHeader(header)) {
      warnings.push(`${key} is not a Raindrop export (expected url, folder and excerpt columns)`)
      continue
    }
    capped = capped || truncated
    for (const row of rows) {
      const url = usableUrl(row.url)
      if (!url) {
        // A row with no url at all is blank, not a refusal worth reporting.
        if (row.url?.trim()) unusableUrl++
        continue
      }
      items.push({
        url,
        title: clip(row.title),
        tags: importTags(row.tags, ','),
        note: [clipText(row.note, MAX_NOTE_PART), clipText(row.highlights, MAX_NOTE_PART)].filter(Boolean).join('\n\n'),
        savedAt: importDate(row.created),
      })
      const folder = clip(row.folder)
      if (folder && folder.toLowerCase() !== 'unsorted') folders.set(folder, [...(folders.get(folder) ?? []), url])
    }
  }

  if (unusableUrl > 0) {
    warnings.push(
      unusableUrl === 1
        ? '1 link was skipped because it was not an http(s) URL'
        : `${unusableUrl} links were skipped because they were not http(s) URLs`,
    )
  }
  if (capped) warnings.push('item cap reached; the rest of the export was skipped')
  const collections = [...folders].map(([name, urls]) => ({ name, urls }))
  return { items, collections, warnings }
}

export const deriveNote = deriveBookmarkNote
