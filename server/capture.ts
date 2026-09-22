// The one save path: a note written immediately with heuristic metadata, and
// an enrichment job queued behind it. Extracted from routes/notes.ts when
// Telegram capture arrived needing the identical sequence — a second copy
// would have drifted the first time either side changed.
import * as store from './data/notes.ts'
import * as ai from './ai/index.ts'
import * as enrich from './ai/enrich.ts'
import { saveImage } from './lib/http.ts'
import type { PublicNote } from './data/notes.ts'

export async function saveCapture({ text, image }: { text: string; image?: string | null }): Promise<PublicNote> {
  const img = await saveImage(image)
  const isUrl = ai.isLikelyUrl(text)
  const note = await store.addNote({
    type: img ? 'image' : ai.heuristicType({ hasImage: false, isUrl, text }),
    title: ai.deriveTitle(text) || (img ? 'Image' : 'Untitled'),
    content: text,
    url: isUrl ? text : null,
    image: img?.webPath || null,
    pending: true,
  })
  enrich.queueEnrich(note.id, { absPath: img?.absPath, text, isUrl, hasImage: !!img })
  return note
}
