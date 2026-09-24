// Deleting a note touches three things, not one: its row, its membership in
// every space, and the files it brought into uploads/. Both the item view's
// delete and the demo's nightly reset need all three, and a copy in each would
// be the first thing to drift, leaving dangling space ids or orphaned files.
import path from 'node:path'
import { unlink } from 'node:fs/promises'
import * as store from './notes.ts'
import * as collections from './collections.ts'
import { UPLOAD_DIR } from '../config.ts'

export async function removeNote(id: string): Promise<boolean> {
  const note = store.getNote(id)
  const ok = await store.deleteNote(id)
  if (ok) await collections.deleteItemEverywhere(id)
  if (ok && note) {
    // Awaited so the nightly reset has actually freed the disk when it returns.
    // A file that is already gone is not a failed delete.
    const files = [note.image, note.thumb, ...(note.slides || [])].filter(
      (f): f is string => !!f?.startsWith('/uploads/'),
    )
    await Promise.all(files.map(f => unlink(path.join(UPLOAD_DIR, path.basename(f))).catch(() => {})))
  }
  return ok
}
