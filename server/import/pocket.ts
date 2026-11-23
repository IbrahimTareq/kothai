// Parses Pocket's CSV export (part_000000.csv, part_000001.csv, ...) into
// bookmark items. Same trust posture as server/import/tiktok.ts: the file is a
// user upload and treated as hostile, and every unexpected shape degrades to
// "fewer items" plus a warning rather than a failed import.
//
// Archived rows (`status`) import like unread ones: archiving in Pocket meant
// "done reading", not "discard". Pocket's ril_export.html is not read; the CSV
// carries the same links.
import { type BookmarkItem, deriveBookmarkNote } from './bookmark.ts'
import { csvHeader, readCsv } from './csv.ts'
import { clip, importDate, importTags, usableUrl } from './untrusted.ts'

export const name = 'pocket'
export const label = 'Pocket'
export const expects = 'the part_000000.csv file(s) from your Pocket export (or the ZIP)'

// People rename downloads, so the name is a hint and the header is the test.
const PART_FILE = /(^|\/)part_\d+\.csv$/i
const REQUIRED = ['title', 'url', 'time_added']
const hasPocketHeader = (header: string[]) => REQUIRED.every(c => header.includes(c))

export function sniff(files: Map<string, Buffer>): boolean {
  for (const [key, buf] of files) {
    if (PART_FILE.test(key) || hasPocketHeader(csvHeader(buf))) return true
  }
  return false
}

export function parse(files: Map<string, Buffer>) {
  const items: BookmarkItem[] = []
  const warnings: string[] = []
  let unusableUrl = 0
  let capped = false

  for (const [key, buf] of files) {
    if (!PART_FILE.test(key) && !hasPocketHeader(csvHeader(buf))) continue
    const { header, rows, truncated } = readCsv(buf)
    if (!hasPocketHeader(header)) {
      warnings.push(`${key} is not a Pocket export (expected title, url and time_added columns)`)
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
        tags: importTags(row.tags, '|'),
        note: '',
        savedAt: importDate(row.time_added),
      })
    }
  }

  if (unusableUrl > 0) warnings.push(`${unusableUrl} links were skipped because they were not http(s) URLs`)
  if (capped) warnings.push('item cap reached; the rest of the export was skipped')
  return { items, collections: [], warnings }
}

export const deriveNote = deriveBookmarkNote
