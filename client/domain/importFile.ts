// Accept/reject rules for the files on their way to /api/import, plus the
// per-platform source descriptors the Import section renders from. Kept pure
// and separate from Settings.tsx so both entry points share one set of checks
// and so they're unit-testable without a DOM.
//
// Drag-and-drop is the reason this isn't just inline in the change handler:
// the file picker enforces each source's `accept` for us, but a file DROPPED
// on the target has been through no filter at all — without an explicit type
// check, dropping a 4GB video would happily base64 it into memory before the
// server got the chance to reject it.

// The server's /api/import body limit is 64MB of raw JSON, and base64 inflates
// a file by ~4/3, so ~45MB of file is the real ceiling. Stopping here rather
// than at the server matters: readBody's overflow path destroys the socket
// before it can write a 413, which reaches fetch() as a bare "Failed to
// fetch" — and we'd have held three copies of a huge file in memory to earn
// that useless message. With several files in one import the limit is on
// their COMBINED size, since they ride in a single request body.
export const MAX_IMPORT_BYTES = 45 * 1024 * 1024

// Mirrors server/routes/import.js's MAX_UPLOADS so a too-large selection is
// refused here rather than after base64-ing every file.
export const MAX_IMPORT_FILES = 20

// One entry per platform Kothai can import from. `id` MUST match the server
// importer's exported `name` (server/import/*.js) — it's sent as `source` so
// the route validates the upload against that importer specifically and can
// say what it expected. Adding a platform is this entry plus the parser.
export type ImportSource = {
  id: string
  label: string
  accept: string // the file picker's `accept` attribute
  extensions: RegExp // the same rule enforced in code, for dropped files
  extensionsLabel: string // how to name those extensions in an error
}

export const IMPORT_SOURCES: ImportSource[] = [
  {
    id: 'instagram',
    label: 'Instagram',
    accept: '.zip,.json',
    extensions: /\.(zip|json)$/i,
    extensionsLabel: '.zip or .json',
  },
  {
    id: 'tiktok',
    label: 'TikTok',
    accept: '.zip,.json',
    extensions: /\.(zip|json)$/i,
    extensionsLabel: '.zip or .json',
  },
]

export function getImportSource(id: string): ImportSource | null {
  return IMPORT_SOURCES.find((s) => s.id === id) || null
}

const DEFAULT_SOURCE = IMPORT_SOURCES[0]

// Returns a user-facing reason to reject, or null when the file is fine.
export function validateImportFile(name: string, size: number, source: ImportSource = DEFAULT_SOURCE): string | null {
  // Type is checked before size: a 4GB .png is the wrong file, and telling
  // someone it's "too big" would send them off to shrink something that was
  // never going to import.
  if (!source.extensions.test(name)) return `That is not an export file — drop a ${source.extensionsLabel}.`
  if (size <= 0) return 'That file is empty.'
  if (size > MAX_IMPORT_BYTES) return 'That export is too big — unzip it and import just saved_posts.json instead.'
  return null
}

// The multi-file gate. An Instagram export hands you saved_posts.json and
// saved_collections.json as separate files, so the common case is selecting
// both at once — the combined size is what has to fit the request body, and
// naming the offending file matters when only one of several is at fault.
export function validateImportFiles(
  files: { name: string; size: number }[],
  source: ImportSource = DEFAULT_SOURCE,
): string | null {
  if (!files.length) return 'No files to import.'
  if (files.length > MAX_IMPORT_FILES) return `Too many files — import up to ${MAX_IMPORT_FILES} at a time.`
  let total = 0
  for (const f of files) {
    // Per-file type and empty checks first, so "that's the wrong file" always
    // beats "that's too big" — same reasoning as validateImportFile above.
    if (!source.extensions.test(f.name)) return `${f.name} is not an export file — drop a ${source.extensionsLabel}.`
    if (f.size <= 0) return `${f.name} is empty.`
    total += f.size
  }
  if (total > MAX_IMPORT_BYTES) {
    return files.length === 1
      ? 'That export is too big — unzip it and import just saved_posts.json instead.'
      : 'Those files are too big to import together — try them one at a time.'
  }
  return null
}
