// Second tries for a thumbnail whose download failed for a reason that passes.
//
// fetchLinkMeta records the image URL as `thumbSrc` when that happens, instead
// of giving up on it. Before, a note was marked fetched with no thumbnail and
// nothing ever looked again: a fresh demo lost its GitHub card's picture to
// opengraph.githubassets.com answering 429 while every seeded link was fetched
// at once.
//
// Only the image is fetched again, never the page: the title and description
// already landed, and asking the page twice is how you earn the next 429.
import * as store from '../data/notes.ts'
import { isTransient, saveThumb } from './fetch.ts'

// Backs off like the Instagram lane does, though far shorter: a rate limit on
// one image usually clears in minutes. After the last one, the boot sweep
// (enrich.ts's queueMetaBackfill) tries again on the next start.
const DELAYS_MS = [60_000, 10 * 60_000, 60 * 60_000]
const scheduled = new Set<string>()

export function queueThumbRetry(noteId: string, attempt = 0): void {
  if (scheduled.has(noteId) || attempt >= DELAYS_MS.length) return
  scheduled.add(noteId)
  setTimeout(async () => {
    scheduled.delete(noteId)
    if (await retryThumb(noteId)) queueThumbRetry(noteId, attempt + 1)
  }, DELAYS_MS[attempt]).unref()
}

// True when it is still worth asking again.
async function retryThumb(noteId: string): Promise<boolean> {
  const note = store.getNote(noteId)
  if (!note?.thumbSrc || note.thumb) return false
  try {
    await store.updateNote(noteId, { ...(await saveThumb(note.thumbSrc, noteId)), thumbSrc: null })
    return false
  } catch (e) {
    if (isTransient(e)) return true
    console.error('[thumb] giving up on', note.thumbSrc, '-', e instanceof Error ? e.message : e)
    await store.updateNote(noteId, { thumbSrc: null })
    return false
  }
}
