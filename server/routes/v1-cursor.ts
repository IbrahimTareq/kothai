// Opaque paging cursors for /api/v1: base64url of a JSON object. Clients must
// not look inside, which is what lets the payload change without a version bump.
export function encodeCursor(v: object): string {
  return Buffer.from(JSON.stringify(v)).toString('base64url')
}

// Total: a cursor comes from the query string, so anything can arrive. Null for
// bad base64, bad JSON, and JSON that is not an object (a bare `7` or `null`
// would otherwise pass as a cursor and crash the caller's field reads). The
// caller still checks the fields it needs; T is its claim, not a check.
export function decodeCursor<T>(s: string): T | null {
  try {
    const v: unknown = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'))
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as T) : null
  } catch {
    return null
  }
}
