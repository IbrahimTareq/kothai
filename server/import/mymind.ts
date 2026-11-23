// Parses mymind's cards.csv ("Export my mind") into bookmark items. Same trust
// posture as server/import/raindrop.ts: the file is a user upload and treated
// as hostile, and every unexpected shape degrades to "fewer items" plus a
// warning rather than a failed import.
//
// Links only. A Note or Image card has no url, and an item here is keyed by its
// url, so those cards are counted in a warning instead of being imported; the
// user is told what was left behind rather than finding it missing later.
import {
  type BookmarkItem,
  CAP_WARNING,
  deriveBookmarkNote,
  refusedLinksWarning,
  unterminatedWarning,
} from './bookmark.ts'
import { csvHeader, readCsv } from './csv.ts'
import { clip, clipText, importDate, importTags, usableUrl } from './untrusted.ts'

export const name = 'mymind'
export const label = 'mymind'
export const expects = 'cards.csv from the folder "Export my mind" wrote'

const CARDS_FILE = /(^|\/)cards\.csv$/i
// `type`, `content` and `note` together keep this apart from Raindrop's
// folder+excerpt and Pocket's time_added; the file name is a hint, not the test.
const REQUIRED = ['type', 'url', 'content', 'note']
const hasMymindHeader = (header: string[]) => REQUIRED.every(c => header.includes(c))

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`

export function sniff(files: Map<string, Buffer>): boolean {
  for (const [key, buf] of files) {
    if (CARDS_FILE.test(key) || hasMymindHeader(csvHeader(buf))) return true
  }
  return false
}

export function parse(files: Map<string, Buffer>) {
  const items: BookmarkItem[] = []
  const warnings: string[] = []
  let unusableUrl = 0
  let linklessNotes = 0
  let linklessImages = 0
  let capped = false

  for (const [key, buf] of files) {
    if (!CARDS_FILE.test(key) && !hasMymindHeader(csvHeader(buf))) continue
    const { header, rows, truncated, unterminated } = readCsv(buf)
    if (!hasMymindHeader(header)) {
      warnings.push(`${key} is not a mymind export (expected type, url, content and note columns)`)
      continue
    }
    if (unterminated) warnings.push(unterminatedWarning(key))
    capped = capped || truncated
    for (const row of rows) {
      if (!row.url?.trim()) {
        if (row.type?.trim().toLowerCase() === 'image') linklessImages++
        else linklessNotes++
        continue
      }
      const url = usableUrl(row.url)
      if (!url) {
        unusableUrl++
        continue
      }
      items.push({
        url,
        title: clip(row.title),
        tags: importTags(row.tags, ','),
        note: clipText(row.note, 4000),
        savedAt: importDate(row.created),
      })
    }
  }

  const linkless = [
    linklessNotes > 0 && plural(linklessNotes, 'note'),
    linklessImages > 0 && plural(linklessImages, 'image'),
  ].filter(Boolean)
  if (linkless.length > 0) {
    // The verb agrees with the total, so "1 note and 1 image" is plural.
    const one = linklessNotes + linklessImages === 1
    warnings.push(
      `${linkless.join(' and ')} from mymind ${one ? "has no link and wasn't" : "have no link and weren't"} imported.`,
    )
  }
  if (unusableUrl > 0) warnings.push(refusedLinksWarning(unusableUrl))
  if (capped) warnings.push(CAP_WARNING)
  return { items, collections: [], warnings }
}

export const deriveNote = deriveBookmarkNote
