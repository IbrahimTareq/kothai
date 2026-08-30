// POST /api/wipe — the Settings "danger zone" reset. Erases the user's
// CONTENT (notes, spaces, chats, the learned tag vocabulary, and the uploaded
// images those notes referenced) and deliberately leaves model settings and
// residency policy untouched: the multi-GB weights on disk stay valid and the
// app comes back configured rather than dumped into first-run setup.
//
// This is the only irreversible destructive route in the app, so the
// confirmation is enforced HERE and not just in the UI — a mis-fired fetch(),
// a stale tab, or a page-embedded script must not be able to erase anything
// without the exact token. The client's type-to-confirm box produces it.
import * as store from '../data/notes.js'
import * as collections from '../data/collections.js'
import * as chats from '../data/chats.js'
import * as tagvocab from '../data/tagvocab.js'
import { isImportInProgress } from './import.js'
import { json, readBody } from '../lib/http.js'

export const CONFIRM_TOKEN = 'DELETE'

// The body is a single short field; no reason to buffer more than that.
const BODY_LIMIT = 4 * 1024

export async function handleWipe(req, res) {
  let body
  try {
    body = await readBody(req, BODY_LIMIT)
  } catch {
    return json(res, 400, { error: 'Could not read the request.' })
  }
  // Exact match, no trimming or case-folding: "delete" or " DELETE " means
  // the user did not type the confirmation the UI asked for.
  if (!body || typeof body !== 'object' || body.confirm !== CONFIRM_TOKEN) {
    return json(res, 400, { error: `Type ${CONFIRM_TOKEN} to confirm.`, code: 'confirm_required' })
  }
  // An import writes notes in a batch it holds in memory (see import.js) — a
  // wipe landing mid-import would clear the table and then have that batch
  // flushed on top of it, leaving exactly the notes the user asked to erase.
  if (isImportInProgress()) {
    return json(res, 409, { error: 'An import is running — wait for it to finish, then try again.', code: 'import_in_progress' })
  }

  // Ordered notes-first so that if a later step throws, what's left behind is
  // orphaned metadata (spaces pointing at nothing, a stale tag vocab) rather
  // than the notes themselves — the store layer already tolerates both, and
  // re-running the wipe cleans up the remainder.
  const notes = await store.clearAll()
  const spaces = await collections.clearAll()
  const conversations = await chats.clearAll()
  const tags = await tagvocab.clearAll()
  // Last, and non-fatal by construction (see clearUploads): the database is
  // already consistent by this point, so a stubborn file can't undo the wipe.
  await store.clearUploads()

  json(res, 200, { cleared: { notes, collections: spaces, chats: conversations, tags } })
}
