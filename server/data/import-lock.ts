// "An import is mid-flight" — the one piece of store-wide concurrency state,
// and the refusal the other bulk routes answer with.
//
// Kothai is single-user/local-first, so a full mutex around the note store
// would be overkill — but two overlapping imports both read store.allNotes()
// for their own url-dedup snapshot before either has written anything, so
// neither would see the other's in-flight additions and the same post could be
// imported twice. Serializing imports against EACH OTHER (not against every
// other route) closes that specific window cheaply, without touching the
// shared store's concurrency story elsewhere.
//
// Backup, checkpoint and wipe READ this without taking it: an import holds
// unflushed notes in memory, so any of those landing between its addNote()
// loop and its flush() would be undone by that flush. They do not acquire it,
// which is why a backup does not block an import — widening that would be a
// change to what the app allows, not a tidy-up.
//
// It lives in data/ because it is state about the store. It used to be a
// module-level flag inside routes/import.js, which meant three unrelated
// routes had to import a route to find out about it.
let importInProgress = false

export function isImportInProgress(): boolean {
  return importInProgress
}

// Run `fn` as the exclusive import, or answer null if one is already running.
// Callers distinguish the two by the return value rather than by reading the
// flag and then setting it, which is the sequence that can interleave.
export async function runExclusiveImport<T>(fn: () => Promise<T>): Promise<{ result: T } | null> {
  if (importInProgress) return null
  importInProgress = true
  try {
    return { result: await fn() }
  } finally {
    importInProgress = false
  }
}

// The refusal itself. Three routes answered with this same sentence and code,
// and the client matches on the code (client/components/ImportSection.tsx,
// client/views/Settings.tsx) — three copies is three chances to drift from a
// string another codebase is reading.
export const IMPORT_BUSY = {
  error: 'An import is running — wait for it to finish, then try again.',
  code: 'import_in_progress',
}
