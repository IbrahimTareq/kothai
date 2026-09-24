// The one save path: a note written immediately with heuristic metadata, and
// an enrichment job queued behind it. Extracted from routes/notes.ts when
// Telegram capture arrived needing the identical sequence — a second copy
// would have drifted the first time either side changed.
import * as store from './data/notes.ts'
import * as ai from './ai/index.ts'
import * as enrich from './ai/enrich.ts'
import type { PublicNote } from './data/notes.ts'

// `url` has already passed ai.isLikelyUrl: each caller refuses anything else
// in its own words (a 400 on /api/save, a reply in Telegram).
export async function saveCapture({
  url,
  visitor = null,
}: {
  url: string
  visitor?: string | null
}): Promise<PublicNote> {
  const note = await store.addNote({
    type: ai.heuristicType(url),
    title: ai.deriveTitle(url),
    content: url,
    url,
    pending: true,
    ...(visitor ? { visitor } : {}),
  })
  enrich.queueEnrich(note.id, url)
  return note
}
