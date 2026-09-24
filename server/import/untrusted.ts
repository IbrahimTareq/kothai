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
