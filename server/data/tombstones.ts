// The deletion half of delta sync (notes.ts owns the rev counter). A deleted
// note leaves { id, rev } here so /api/notes/delta and /api/v1/changes can tell
// a client to drop it; the window is capped, and a cursor older than what was
// trimmed must resync, because deletions may be missing from the answer.
let tombstones: { id: string; rev: number }[] = [] // newest last
let floor = 0 // highest rev discarded from the window
let cap = 1000

export function addTombstone(id: string, rev: number): void {
  tombstones.push({ id, rev })
  // `?.` only because Array.shift() is declared possibly-undefined for an
  // empty array; the loop condition is what rules that out here.
  while (tombstones.length > cap) floor = tombstones.shift()?.rev ?? floor
}

export function deletedSince(since: number): string[] {
  return tombstones.filter(t => t.rev > since).map(t => t.id)
}

// False when `since` predates trimmed tombstones — deletions may be missing,
// so the client must refetch instead of applying a delta.
export function deltaOk(since: number): boolean {
  return since >= floor
}

// Forget every deletion and refuse cursors older than `atRev`: the library was
// replaced wholesale, so clients resync rather than read tombstones.
export function clearTombstones(atRev: number): void {
  tombstones = []
  floor = atRev
}

export function _setTombstoneCap(n: number): void {
  cap = n
} // test-only
