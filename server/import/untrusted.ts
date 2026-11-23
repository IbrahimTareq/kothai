// Reading values out of an untrusted export archive.
//
// Every importer is handed a Map<entryName, Buffer> that came straight off a
// user upload (see server/lib/zip.ts), so the two operations below — decode
// some JSON, take a string field — are the points where hostile input enters.
// instagram.ts and tiktok.ts each carried a byte-identical private copy of
// both, and only one of the four copies carried the reasoning for why they are
// shaped the way they are. Shared, so a fix reaches every importer and the
// next importer starts out safe rather than starting out by copying.

// Caps poster/title/collection-name strings only — a note's url has its own,
// tighter cap at its own call site.
const MAX_FIELD_LEN = 500

export function tryJson(buf: Buffer): unknown {
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    return null
  }
}

// Narrowing a value read out of a parsed export before its fields can be
// touched. tryJson returns `unknown` on purpose — that is the honest type for
// JSON.parse of a user-uploaded file — so every importer needs the same first
// step, and every importer's field reads (`row?.Link`, `node?.title`) were
// already relying on exactly this check at runtime. Shared for the same
// reason tryJson and clip are: the next importer should start out safe rather
// than start out by copying.
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

// Collapses whitespace before clipping: these strings ride into an LLM
// enrichment prompt (a poster "name" full of newlines/control whitespace is a
// cheap prompt-formatting/injection vector) as well as into the UI, so a
// multi-MB string field must not be able to ride along.
export function clip(str: unknown): string {
  if (typeof str !== 'string') return ''
  return str.replace(/\s+/g, ' ').trim().slice(0, MAX_FIELD_LEN)
}

const MAX_URL_LEN = 2048
const MAX_TAGS = 20
const MAX_TAG_LEN = 60
// Dates past this are junk (a unit mix-up or a hostile value); new Date() also
// throws RangeError beyond ~8.64e15 ms, which would 500 the whole import.
const MAX_DATE_SECONDS = Date.UTC(2100, 0, 1) / 1000

// http(s) only: the value ends up in an `<a href>`, so `javascript:` must never
// get through; the length cap keeps a megabyte "URL" out of every note field.
export function usableUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const url = v.trim()
  return /^https?:\/\//i.test(url) && url.length <= MAX_URL_LEN ? url : null
}

// For free text (notes, highlights) where line breaks carry meaning, unlike
// clip(). Control characters are stripped because the text reaches an LLM
// prompt and the UI.
export function clipText(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  return (
    v
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
      .replace(/[\u0000-\u0008\u000B-\u001F]/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .trim()
      .slice(0, max)
  )
}

// A tag list from an export: the user's own words, so keep them, but bound the
// count and length — one row must not be able to mint thousands of tags.
export function importTags(v: unknown, sep: string | RegExp): string[] {
  const parts = typeof v === 'string' ? v.split(sep) : Array.isArray(v) ? v : []
  const tags = new Set<string>()
  for (const p of parts) {
    if (typeof p !== 'string') continue
    const tag = p.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, MAX_TAG_LEN).trim()
    if (tag) tags.add(tag)
    if (tags.size >= MAX_TAGS) break
  }
  return [...tags]
}

// Unix seconds from whatever the export used: seconds, milliseconds, a numeric
// string, or ISO text. 0 means "unknown" and the caller falls back to now.
export function importDate(v: unknown): number {
  let n: number
  if (typeof v === 'number') n = v
  else if (typeof v === 'string' && v.trim() !== '') {
    n = /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : Date.parse(v) / 1000
  } else return 0
  if (!Number.isFinite(n) || n <= 0) return 0
  // Past 1e11 a value cannot be seconds (that is the year 5138).
  const seconds = n > 1e11 ? n / 1000 : n
  return Math.floor(seconds) <= MAX_DATE_SECONDS ? Math.floor(seconds) : 0
}
